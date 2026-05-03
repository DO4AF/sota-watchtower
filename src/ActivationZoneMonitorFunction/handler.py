import json
import boto3
import requests
import os
from datetime import datetime, timedelta, timezone
import re
from geopy.distance import geodesic
import time

# Initialize AWS clients
lambda_client = boto3.client('lambda')
dynamodb = boto3.resource('dynamodb')


def parse_json_list(raw):
    if isinstance(raw, list):
        return [str(v).strip() for v in raw if str(v).strip()]
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [str(v).strip() for v in parsed if str(v).strip()]
    except Exception:
        pass
    return []


def parse_json_dict(raw):
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return {}


def _normalize_bbox(raw_bbox):
    if not isinstance(raw_bbox, dict):
        return None
    try:
        lat_n = float(raw_bbox.get('latN'))
        lon_w = float(raw_bbox.get('lonW'))
        lat_s = float(raw_bbox.get('latS'))
        lon_e = float(raw_bbox.get('lonE'))
    except Exception:
        return None

    top = max(lat_n, lat_s)
    bottom = min(lat_n, lat_s)
    left = min(lon_w, lon_e)
    right = max(lon_w, lon_e)
    return {
        'latN': top,
        'latS': bottom,
        'lonW': left,
        'lonE': right,
    }


def build_scope_bboxes(config):
    selected_associations = parse_json_list(config.get('sotaAssociations', ''))
    selected_regions = parse_json_list(config.get('sotaRegions', ''))
    association_options = parse_json_list(config.get('sotaAssociationOptions', ''))
    area_by_association = parse_json_dict(config.get('sotaAprsAreaByAssociation', ''))
    area_by_region = parse_json_dict(config.get('sotaAprsAreaByRegion', ''))

    has_scope_selection = bool(selected_associations or selected_regions)

    associations_to_use = selected_associations if selected_associations else association_options
    bboxes = []
    if selected_regions:
        for region_key in selected_regions:
            bbox = _normalize_bbox(area_by_region.get(region_key))
            if bbox:
                bboxes.append(bbox)
    else:
        for assoc in associations_to_use:
            bbox = _normalize_bbox(area_by_association.get(assoc))
            if bbox:
                bboxes.append(bbox)

    return bboxes, has_scope_selection


def is_position_in_scope(latitude, longitude, bboxes):
    if not bboxes:
        return True
    for bbox in bboxes:
        if (
            bbox['latS'] <= latitude <= bbox['latN']
            and bbox['lonW'] <= longitude <= bbox['lonE']
        ):
            return True
    return False


def get_config():
    """Read runtime configuration from DynamoDB ConfigTable.

    Returns a dict with at least:
      - activationZoneDistanceMeters  (default: 300)
      - activationZoneAltitudeDeltaMeters (default: 25)
    """
    table_name = os.environ.get('CONFIGTABLE_TABLE_NAME')
    if not table_name:
        return {}
    try:
        table = dynamodb.Table(table_name)
        response = table.scan()
        items = response.get('Items', [])
        return {item['configKey']: item['configValue'] for item in items}
    except Exception as e:
        print(f"[WARNING] Could not read config from DynamoDB: {e}")
        return {}


def fetch_alerts():
    """Get alerts from SotaAlertsTable (DynamoDB)."""
    table = dynamodb.Table(os.getenv('SOTAALERTSTABLE_TABLE_NAME'))
    response = table.scan()
    alerts = response['Items']
    while 'LastEvaluatedKey' in response:
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        alerts.extend(response['Items'])
    return alerts


def store_aprs_position(callsign, latitude, longitude, altitude):
    """Store APRS activator position in DynamoDB with 2-hour TTL.

    Maintains a rolling history of up to 100 positions so the frontend
    can draw a trace path.  Uses get_item + put_item (single PK means
    no sort-key history, so we store the list inside the item).
    """
    table_name = os.getenv('APRSPOSITIONSTABLE_TABLE_NAME')
    if not table_name:
        return
    table = dynamodb.Table(table_name)
    now = datetime.now(timezone.utc).isoformat()
    ttl = int(time.time()) + 7200  # 2 hours TTL

    new_point = {
        'latitude':  str(latitude),
        'longitude': str(longitude),
        'altitude':  str(altitude),
        'timestamp': now,
    }

    # Fetch existing positions list (may not exist yet)
    try:
        response = table.get_item(Key={'callsign': callsign})
        positions = list(response.get('Item', {}).get('positions', []))
    except Exception:
        positions = []

    positions.append(new_point)
    positions = positions[-100:]  # keep last 100 points (~2 h at 1 pkt/min)

    table.put_item(Item={
        'callsign':  callsign,
        'latitude':  str(latitude),
        'longitude': str(longitude),
        'altitude':  str(altitude),
        'lastSeen':  now,
        'ttl':       ttl,
        'positions': positions,
    })


def mark_alert_as_notified(callsign, summit):
    """Mark alert as notified by adding the key 'notified' to the item."""
    table = dynamodb.Table(os.getenv('SOTAALERTSTABLE_TABLE_NAME'))
    response = table.update_item(
        Key={
            'callsign': callsign,
            'summit': summit
        },
        UpdateExpression="set notified = :n",
        ExpressionAttributeValues={
            ':n': True
        },
        ReturnValues="UPDATED_NEW"
    )
    return response


def handler(event, context):
    # Load runtime config (activation zone thresholds)
    config = get_config()

    # Activation zone — configurable via GUI, stored in DynamoDB
    # Distance threshold in km (stored as meters in config)
    activation_distance_km = float(config.get('activationZoneDistanceMeters', 300)) / 1000.0
    # Altitude delta threshold in meters
    activation_altitude_delta_m = float(config.get('activationZoneAltitudeDeltaMeters', 25))

    print(f"[INFO] Activation zone: {activation_distance_km*1000:.0f} m horizontal, "
          f"{activation_altitude_delta_m:.0f} m vertical")

    aprs_callsign = event.get('callsign')
    aprs_latitude = event.get('latitude')
    aprs_longitude = event.get('longitude')
    aprs_altitude = event.get('altitude')

    try:
        aprs_latitude_f = float(aprs_latitude)
        aprs_longitude_f = float(aprs_longitude)
    except Exception:
        print(f"[WARNING] Invalid APRS coordinates for {aprs_callsign}: lat={aprs_latitude}, lon={aprs_longitude}")
        return {}

    scope_bboxes, has_scope_selection = build_scope_bboxes(config)
    if has_scope_selection and not scope_bboxes:
        print("[WARNING] Scope selected but no scope bboxes resolved; dropping APRS packet (fail-closed).")
        return {}

    if not is_position_in_scope(aprs_latitude_f, aprs_longitude_f, scope_bboxes):
        print(f"[INFO] Dropping out-of-scope APRS position for {aprs_callsign}: lat={aprs_latitude_f}, lon={aprs_longitude_f}")
        return {}

    print(f"APRS Callsign: {aprs_callsign}, APRS Latitude: {aprs_latitude}, "
          f"APRS Longitude: {aprs_longitude}, APRS Altitude: {aprs_altitude}")

    # Always store the APRS position for map display
    store_aprs_position(aprs_callsign, aprs_latitude, aprs_longitude, aprs_altitude)

    # Get Alerts from SotaAlertsTable
    upcoming_alerts = fetch_alerts()

    # Loop through all activations
    for alert in upcoming_alerts:
        summit_code = alert.get('summit')
        alert_callsign = alert.get('callsign')

        if alert_callsign in aprs_callsign:
            print(f"Activator {alert_callsign} of {summit_code} found in APRS data.")

            # Get the summit latitude/longitude from summitslist.csv
            summit_lat = None
            summit_lon = None
            summit_altitude = None
            with open('summitslist.csv', 'r') as file:
                summits = file.readlines()[2:]
                for summit in summits:
                    summit_data = summit.split(',')
                    summit_code_file = summit_data[0]
                    summit_lon = summit_data[8]
                    summit_lat = summit_data[9]
                    summit_altitude = summit_data[4]
                    if summit_code_file == summit_code:
                        break

            if summit_lat and summit_lon:
                # Calculate the distance between the walker and the summit
                walker_coordinates = (aprs_latitude, aprs_longitude)
                summit_coordinates = (summit_lat, summit_lon)
                distance = geodesic(walker_coordinates, summit_coordinates).kilometers

                print(f"[INFO] Distance to summit {summit_code}: {distance*1000:.0f} m "
                      f"(threshold: {activation_distance_km*1000:.0f} m)")

                if distance < activation_distance_km:
                    # Check altitude: walker must be within configured delta below summit
                    alt_diff = float(summit_altitude) - float(aprs_altitude if aprs_altitude else 0)
                    print(f"[INFO] Altitude difference: {alt_diff:.0f} m "
                          f"(threshold: {activation_altitude_delta_m:.0f} m)")

                    if alt_diff > activation_altitude_delta_m:
                        print(f"Walker is more than {activation_altitude_delta_m:.0f} m below "
                              f"the summit altitude — not in activation zone.")
                    else:
                        print("Walker is in the activation zone!")
                        # TODO: implement notification dispatch (Telegram removed; new notification system TBD)
                        mark_alert_as_notified(alert_callsign, summit_code)

            break

    return {}
