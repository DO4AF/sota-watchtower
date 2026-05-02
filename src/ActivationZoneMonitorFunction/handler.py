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


def get_config():
    """Read runtime configuration from DynamoDB ConfigTable.

    Returns a dict with at least:
      - telegramGroupId
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


def notify_telegram(chat_id, text):
    """Invoke the TelegramNotifyFunction asynchronously."""
    if not chat_id:
        print(f"[WARNING] notify_telegram: no chat_id provided, skipping.")
        return
    response = lambda_client.invoke(
        FunctionName=os.getenv('TELEGRAMNOTIFYFUNCTION_FUNCTION_ARN'),
        InvocationType='Event',
        Payload=json.dumps(
            {
                'chat_id': chat_id,
                'message': text
            }
        )
    )
    return response


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
    # Load runtime config (Telegram group, activation zone thresholds)
    config = get_config()

    telegram_group_id = config.get(
        'telegramGroupId',
        os.getenv('TELEGRAM_GROUP_ID', '')
    )

    # Activation zone — configurable via GUI, stored in DynamoDB
    # Distance threshold in km (stored as meters in config)
    activation_distance_km = float(config.get('activationZoneDistanceMeters', 300)) / 1000.0
    # Altitude delta threshold in meters
    activation_altitude_delta_m = float(config.get('activationZoneAltitudeDeltaMeters', 25))

    print(f"[INFO] Activation zone: {activation_distance_km*1000:.0f} m horizontal, "
          f"{activation_altitude_delta_m:.0f} m vertical")

    # Get Alerts from SotaAlertsTable
    upcoming_alerts = fetch_alerts()
    aprs_callsign = event.get('callsign')
    aprs_latitude = event.get('latitude')
    aprs_longitude = event.get('longitude')
    aprs_altitude = event.get('altitude')

    print(f"APRS Callsign: {aprs_callsign}, APRS Latitude: {aprs_latitude}, "
          f"APRS Longitude: {aprs_longitude}, APRS Altitude: {aprs_altitude}")

    # Always store the APRS position for map display
    store_aprs_position(aprs_callsign, aprs_latitude, aprs_longitude, aprs_altitude)

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
                        notify_telegram(
                            telegram_group_id,
                            f"🏔 {aprs_callsign} ist in der Aktivierungszone von {summit_code_file}!"
                        )
                        mark_alert_as_notified(alert_callsign, summit_code)

            break

    return {}
