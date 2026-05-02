import json
import boto3
import requests
import os
import re
from boto3.dynamodb.types import TypeDeserializer

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Content-Type': 'application/json',
}

DEFAULT_ASSOCIATIONS = []

_DESERIALIZER = TypeDeserializer()


def chunked(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def batch_get_summits_by_codes(dynamodb_client, table_name, summit_codes):
    if not summit_codes:
        return {}

    unique_codes = sorted(set(code for code in summit_codes if code))
    result = {}

    for chunk in chunked(unique_codes, 100):
        request_items = {
            table_name: {
                'Keys': [{'summitCode': {'S': code}} for code in chunk]
            }
        }

        while request_items:
            response = dynamodb_client.batch_get_item(RequestItems=request_items)
            for raw_item in response.get('Responses', {}).get(table_name, []):
                item = {k: _DESERIALIZER.deserialize(v) for k, v in raw_item.items()}
                code = item.get('summitCode')
                if code:
                    result[code] = item
            request_items = response.get('UnprocessedKeys', {})

    return result


def parse_summit_details(details):
    """Parse SOTA API summitDetails like: 'Reisseck, 2305m, 10 points'."""
    if not isinstance(details, str) or not details.strip():
        return '', 0, 0

    match = re.match(r'^\s*(?P<name>[^,]+),\s*(?P<alt>\d+)m,\s*(?P<pts>\d+)\s+points\s*$', details)
    if not match:
        return '', 0, 0

    return (
        match.group('name').strip(),
        int(match.group('alt')),
        int(match.group('pts')),
    )


def normalize_summit_ref(association_code, summit_code):
    association = str(association_code or '').strip()
    summit = str(summit_code or '').strip()

    if '/' in summit:
        left, right = summit.split('/', 1)
        if left and not association:
            association = left.strip()
        summit = right.strip()

    if not summit:
        return ''
    return f"{association}/{summit}".strip('/')


def get_associations():
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(os.environ['CONFIGTABLE_TABLE_NAME'])

    def parse_list(raw):
        if not raw:
            return []
        try:
            value = json.loads(raw)
            if isinstance(value, list):
                return [str(v).strip() for v in value if str(v).strip()]
        except Exception:
            pass
        return []

    try:
        response = table.get_item(Key={'configKey': 'sotaAssociations'})
        item = response.get('Item')
        if item and item.get('configValue'):
            selected = parse_list(item['configValue'])
            if selected:
                return selected

        response = table.get_item(Key={'configKey': 'sotaAssociationOptions'})
        item = response.get('Item')
        if item and item.get('configValue'):
            options = parse_list(item['configValue'])
            if options:
                return options
    except Exception:
        pass
    return DEFAULT_ASSOCIATIONS


def handler(event, context):
    dynamodb = boto3.resource('dynamodb')
    dynamodb_client = boto3.client('dynamodb')
    summits_table_name = os.environ['SUMMITS_TABLE_NAME']

    associations = get_associations()
    response = requests.get('https://api2.sota.org.uk/api/spots/-60/all', timeout=10)
    response.raise_for_status()
    spots = response.json()
    filtered = [s for s in spots if not associations or s.get('associationCode') in associations]

    summit_refs = []
    for spot in filtered:
        summit_refs.append(
            normalize_summit_ref(
                spot.get('associationCode', ''),
                spot.get('summitCode', ''),
            )
        )

    summit_by_code = batch_get_summits_by_codes(dynamodb_client, summits_table_name, summit_refs)

    normalized = []
    for spot in filtered:
        summit_ref = normalize_summit_ref(
            spot.get('associationCode', ''),
            spot.get('summitCode', ''),
        )
        summit = summit_by_code.get(summit_ref, {})

        fallback_name, fallback_altitude, fallback_points = parse_summit_details(spot.get('summitDetails', ''))

        time_value = str(
            spot.get('timeStamp')
            or spot.get('timestamp')
            or spot.get('spotTime')
            or ''
        )
        callsign_value = str(
            spot.get('activatingCallsign')
            or spot.get('activatorCallsign')
            or spot.get('callsign')
            or ''
        )
        posted_by_value = str(spot.get('posterCallsign') or spot.get('callsign') or '')

        normalized.append({
            'time': time_value,
            'callsign': callsign_value,
            'frequency': str(spot.get('frequency', '') or ''),
            'mode': str(spot.get('mode', '') or ''),
            'summitRef': summit_ref,
            'summitName': str(summit.get('peakName', '') or fallback_name),
            'altitude': int(summit.get('elevationM', 0) or fallback_altitude),
            'points': int(summit.get('points', 0) or fallback_points),
            'postedBy': posted_by_value,
            'comments': spot.get('comments', spot.get('comment', '')),
            # Backward-compatible aliases
            'activatorCallsign': callsign_value,
            'summitCode': summit_ref,
            'timeStamp': time_value,
        })

    return {
        'statusCode': 200,
        'headers': CORS_HEADERS,
        'body': json.dumps(normalized),
    }
