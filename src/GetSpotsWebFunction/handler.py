import json
import boto3
import requests
import os

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Content-Type': 'application/json',
}

DEFAULT_ASSOCIATIONS = ['DL', 'OE', 'DM']


def get_associations():
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(os.environ['CONFIGTABLE_TABLE_NAME'])
    try:
        response = table.get_item(Key={'configKey': 'sotaAssociations'})
        item = response.get('Item')
        if item and item.get('configValue'):
            return json.loads(item['configValue'])
    except Exception:
        pass
    return DEFAULT_ASSOCIATIONS


def handler(event, context):
    dynamodb = boto3.resource('dynamodb')
    summits_table = dynamodb.Table(os.environ['SUMMITS_TABLE_NAME'])

    summit_items = []
    summit_scan_kwargs = {}
    while True:
        summit_resp = summits_table.scan(**summit_scan_kwargs)
        summit_items.extend(summit_resp.get('Items', []))
        if 'LastEvaluatedKey' not in summit_resp:
            break
        summit_scan_kwargs['ExclusiveStartKey'] = summit_resp['LastEvaluatedKey']

    summit_by_code = {}
    for summit in summit_items:
        code = summit.get('summitCode')
        if code:
            summit_by_code[code] = summit

    associations = get_associations()
    response = requests.get('https://api2.sota.org.uk/api/spots/-60/all', timeout=10)
    response.raise_for_status()
    spots = response.json()
    filtered = [s for s in spots if s.get('associationCode') in associations]

    normalized = []
    for spot in filtered:
        summit_ref = f"{spot.get('associationCode', '')}/{spot.get('summitCode', '')}".strip('/')
        summit = summit_by_code.get(summit_ref, {})
        normalized.append({
            'time': spot.get('timeStamp', ''),
            'callsign': spot.get('activatingCallsign', ''),
            'frequency': str(spot.get('frequency', '') or ''),
            'mode': str(spot.get('mode', '') or ''),
            'summitRef': summit_ref,
            'summitName': summit.get('peakName', ''),
            'altitude': int(summit.get('elevationM', 0) or 0),
            'points': int(summit.get('points', 0) or 0),
            'postedBy': spot.get('posterCallsign', ''),
            'comments': spot.get('comments', spot.get('comment', '')),
            # Backward-compatible aliases
            'activatorCallsign': spot.get('activatingCallsign', ''),
            'summitCode': summit_ref,
            'timeStamp': spot.get('timeStamp', ''),
        })

    return {
        'statusCode': 200,
        'headers': CORS_HEADERS,
        'body': json.dumps(normalized),
    }
