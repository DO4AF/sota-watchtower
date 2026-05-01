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
    associations = get_associations()
    response = requests.get('https://api2.sota.org.uk/api/spots/-60/all', timeout=10)
    response.raise_for_status()
    spots = response.json()
    filtered = [s for s in spots if s.get('associationCode') in associations]
    return {
        'statusCode': 200,
        'headers': CORS_HEADERS,
        'body': json.dumps(filtered),
    }
