import json
import boto3
import os
from decimal import Decimal

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Content-Type': 'application/json',
}


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def handler(event, context):
    dynamodb = boto3.resource('dynamodb')
    alerts_table = dynamodb.Table(os.environ['SOTAALERTSTABLE_TABLE_NAME'])
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

    items = []
    scan_kwargs = {}
    while True:
        response = alerts_table.scan(**scan_kwargs)
        items.extend(response.get('Items', []))
        if 'LastEvaluatedKey' not in response:
            break
        scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']

    normalized = []
    for item in items:
        summit_ref = str(item.get('summit', ''))
        summit = summit_by_code.get(summit_ref, {})
        frequency = str(item.get('frequency', '') or '')
        mode = str(item.get('mode', '') or '')
        comments = str(item.get('comments', '') or '')
        freqs_comments_parts = [part for part in [frequency, mode, comments] if part]
        normalized.append({
            **item,
            'summitRef': summit_ref,
            'summitName': summit.get('peakName', ''),
            'altitude': int(summit.get('elevationM', 0) or 0),
            'points': int(summit.get('points', 0) or 0),
            'frequenciesComments': ' · '.join(freqs_comments_parts),
        })

    return {
        'statusCode': 200,
        'headers': CORS_HEADERS,
        'body': json.dumps(normalized, cls=DecimalEncoder),
    }
