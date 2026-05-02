import json
import boto3
import os
from decimal import Decimal
from boto3.dynamodb.types import TypeDeserializer

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Content-Type': 'application/json',
}

_DESERIALIZER = TypeDeserializer()


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def chunked(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def batch_get_summits_by_codes(dynamodb_client, table_name, summit_codes):
    """Fetch only required summit records via BatchGetItem (100 key max/chunk)."""
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


def handler(event, context):
    dynamodb = boto3.resource('dynamodb')
    dynamodb_client = boto3.client('dynamodb')
    alerts_table = dynamodb.Table(os.environ['SOTAALERTSTABLE_TABLE_NAME'])
    summits_table_name = os.environ['SUMMITS_TABLE_NAME']

    items = []
    scan_kwargs = {}
    while True:
        response = alerts_table.scan(**scan_kwargs)
        items.extend(response.get('Items', []))
        if 'LastEvaluatedKey' not in response:
            break
        scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']

    summit_refs = [str(item.get('summit', '') or '') for item in items]
    summit_by_code = batch_get_summits_by_codes(dynamodb_client, summits_table_name, summit_refs)

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
