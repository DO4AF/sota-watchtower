import json
import boto3
import os

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Content-Type': 'application/json',
}

ALLOWED_KEYS = {
    'telegramBotToken',
    'telegramGroupId',
    'telegramUserId',
    'frequencyFilterPattern',
    'sotaAssociations',
    'activationZoneDistanceMeters',
    'activationZoneAltitudeDeltaMeters',
}


def handler(event, context):
    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return {
            'statusCode': 400,
            'headers': CORS_HEADERS,
            'body': json.dumps({'error': 'Invalid JSON'}),
        }

    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(os.environ['CONFIGTABLE_TABLE_NAME'])

    with table.batch_writer() as batch:
        for key, value in body.items():
            if key not in ALLOWED_KEYS:
                continue
            serialized = value if isinstance(value, str) else json.dumps(value)
            batch.put_item(Item={'configKey': key, 'configValue': serialized})

    return {
        'statusCode': 200,
        'headers': CORS_HEADERS,
        'body': json.dumps({'message': 'Config saved'}),
    }
