import aprslib
import boto3
import json
import time
import os


DEFAULT_FILTER = "a/49.0/7.7/46.0/16.5 t/p"
MAX_AREA_FILTERS = 9
CONFIG_REFRESH_SECONDS = 600
DEDUPE_SECONDS = 45
DEDUPE_EPSILON_DEG = 0.0003

last_filter_refresh = 0.0
last_filter_string = ""
dedupe_cache = {}
packet_stats = {
    "walker": 0,
    "invoked": 0,
    "deduped": 0,
    "too_fast": 0,
    "ignored_symbol": 0,
}


def get_config_table():
    table_name = os.environ.get("CONFIGTABLE_TABLE_NAME")
    if not table_name:
        return None
    return dynamodb_resource.Table(table_name)


def parse_json_list(raw):
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
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return {}


def read_config_item(table, key):
    if not table:
        return ""
    try:
        item = table.get_item(Key={"configKey": key}).get("Item", {})
        return str(item.get("configValue", "") or "")
    except Exception as exc:
        print(f"[WARNING] Failed to read config key {key}: {exc}")
        return ""


def build_aprs_filter_from_config():
    table = get_config_table()
    if not table:
        return DEFAULT_FILTER

    selected_associations = parse_json_list(read_config_item(table, "sotaAssociations"))
    selected_regions = parse_json_list(read_config_item(table, "sotaRegions"))
    association_options = parse_json_list(read_config_item(table, "sotaAssociationOptions"))
    area_by_association = parse_json_dict(read_config_item(table, "sotaAprsAreaByAssociation"))
    area_by_region = parse_json_dict(read_config_item(table, "sotaAprsAreaByRegion"))

    effective_associations = selected_associations or association_options
    area_filters = []

    # Region-level selection takes precedence if present.
    if selected_regions:
        for region_key in selected_regions:
            region_bbox = area_by_region.get(region_key)
            if not isinstance(region_bbox, dict):
                continue
            area_filters.append(
                f"a/{region_bbox.get('latN')}/{region_bbox.get('lonW')}/{region_bbox.get('latS')}/{region_bbox.get('lonE')}"
            )
    else:
        for assoc in effective_associations:
            bbox = area_by_association.get(assoc)
            if not isinstance(bbox, dict):
                continue
            area_filters.append(
                f"a/{bbox.get('latN')}/{bbox.get('lonW')}/{bbox.get('latS')}/{bbox.get('lonE')}"
            )

    area_filters = [f for f in area_filters if "None" not in f]

    if not area_filters:
        print("[WARNING] No APRS area filters could be derived from config. Falling back to default filter.")
        return DEFAULT_FILTER

    if len(area_filters) > MAX_AREA_FILTERS:
        print(
            f"[WARNING] Derived {len(area_filters)} APRS area filters; limiting to first {MAX_AREA_FILTERS}."
        )
        area_filters = area_filters[:MAX_AREA_FILTERS]

    # Position packets only, as agreed.
    return " ".join(area_filters + ["t/p"])


def refresh_aprs_filter(force=False):
    global last_filter_refresh, last_filter_string

    now = time.time()
    if not force and now - last_filter_refresh < CONFIG_REFRESH_SECONDS:
        return

    try:
        next_filter = build_aprs_filter_from_config()
        if next_filter != last_filter_string:
            print(f"[INFO] Applying APRS filter: {next_filter}")
            client.set_filter(next_filter)
            last_filter_string = next_filter
        else:
            print("[INFO] APRS filter unchanged")
    except Exception as exc:
        print(f"[WARNING] Failed to refresh APRS filter from config: {exc}")
        if not last_filter_string:
            client.set_filter(DEFAULT_FILTER)
            last_filter_string = DEFAULT_FILTER

    last_filter_refresh = now


def is_duplicate_position(callsign, latitude, longitude):
    now = time.time()
    prev = dedupe_cache.get(callsign)
    if not prev:
        dedupe_cache[callsign] = {"ts": now, "lat": latitude, "lon": longitude}
        return False

    age = now - prev["ts"]
    if age > DEDUPE_SECONDS:
        dedupe_cache[callsign] = {"ts": now, "lat": latitude, "lon": longitude}
        return False

    if abs(float(latitude) - float(prev["lat"])) <= DEDUPE_EPSILON_DEG and abs(float(longitude) - float(prev["lon"])) <= DEDUPE_EPSILON_DEG:
        return True

    dedupe_cache[callsign] = {"ts": now, "lat": latitude, "lon": longitude}
    return False

def packet_handler(packet):
    refresh_aprs_filter()

    #print(f"Received packet: {packet.get('symbol_table')}{packet.get('symbol')} ")

    if packet.get('symbol_table') == '/' and (packet.get('symbol') == '[' or packet.get('symbol') == 'p'):
        packet_stats["walker"] += 1
        callsign = packet.get('from')
        comment = packet.get('comment')
        speed = packet.get('speed')
        latitude = packet.get('latitude')
        longitude = packet.get('longitude')

        print(f"[INFO]    Received walker packet: {callsign} - {comment} - https://aprs.fi/?call={callsign}&timerange=10800&tail=10800&others=1&z=19&mt=terrain")
        
        speed = packet.get('speed')
        if(speed and speed > 10):
            packet_stats["too_fast"] += 1
            print(f"[WARNING] {callsign} is too fast - speed: {speed} km/h")
        elif latitude is None or longitude is None:
            print(f"[WARNING] {callsign} packet has no coordinates; skipping")
        else:
            if is_duplicate_position(callsign, latitude, longitude):
                packet_stats["deduped"] += 1
                print(f"[INFO]    Deduped packet for {callsign}")
                return

            print(f"[INFO]    {callsign} is walking - speed: {speed} km/h")
            print(f"[SUCCESS] {callsign} could be a SOTA activator")

            # Define the payload to send to the Lambda function (can be a JSON string or a dict)
            payload = {
                "callsign": callsign,
                "latitude": latitude,
                "longitude": longitude,
                "altitude": packet.get('altitude'),
            }

            # Invoke the Lambda function
            response = lambda_client.invoke(
                FunctionName=function_arn,
                InvocationType='Event',  # Use 'Event' for asynchronous invocation
                Payload=json.dumps(payload)  # Convert payload to JSON string if it's a dict
            )

            packet_stats["invoked"] += 1
            print('Lambda invocation request sent. Request ID:', response['ResponseMetadata']['RequestId'])
            print(f"[INFO]    APRS stats: {packet_stats}")
    else:
        packet_stats["ignored_symbol"] += 1

# Create a client object and specify port 14580
aprs_login = os.environ.get("APRS_LOGIN_CALLSIGN", "N0CALL")
client = aprslib.IS(aprs_login, port=14580)

dynamodb_resource = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'eu-central-1'))

# Initialize with static fallback; will be refreshed from ConfigTable dynamically.
client.set_filter(DEFAULT_FILTER)

# Create a Lambda client
lambda_client = boto3.client('lambda', region_name=os.environ.get('AWS_REGION', 'eu-central-1'))

# Define the name of the Lambda function you want to invoke
function_arn = os.environ.get('ACTIVATIONZONEMONITORFUNCTION_FUNCTION_ARN')

while True:
    try:
        print("Connecting to APRS-IS server on port 14580...")
        refresh_aprs_filter(force=True)
        client.connect()  # Connect to the APRS-IS server
        
        # Start receiving packets
        client.consumer(callback=packet_handler)
        
    except aprslib.exceptions.ConnectionDrop:
        print("Connection dropped.")
        time.sleep(10)  # Wait for 10 seconds before reconnecting
    except Exception as e:
        print(f"An error occurred: {e}")
        time.sleep(10)  # Wait for 10 seconds before reconnecting
