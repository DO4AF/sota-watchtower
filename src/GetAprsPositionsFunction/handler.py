import json
import boto3
import os
from decimal import Decimal
from datetime import datetime, timedelta, timezone

dynamodb = boto3.resource('dynamodb')


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def handler(event, context):
    table = dynamodb.Table(os.environ['APRSPOSITIONSTABLE_TABLE_NAME'])
    max_age_hours = 6
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)

    response = table.scan()
    items = response['Items']
    while 'LastEvaluatedKey' in response:
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        items.extend(response['Items'])

    filtered_items = []
    for item in items:
        last_seen = str(item.get('lastSeen', '') or '').strip()
        if not last_seen:
            continue
        try:
            last_seen_dt = datetime.fromisoformat(last_seen.replace('Z', '+00:00'))
            if last_seen_dt < cutoff:
                continue
        except Exception:
            continue
        filtered_items.append(item)

    return {
        'statusCode': 200,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization,Content-Type',
            'Content-Type': 'application/json',
        },
        'body': json.dumps(filtered_items, cls=DecimalEncoder),
    }
