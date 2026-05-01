import json
import boto3
import os
from decimal import Decimal

dynamodb = boto3.resource('dynamodb')


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def handler(event, context):
    table = dynamodb.Table(os.environ['APRSPOSITIONSTABLE_TABLE_NAME'])

    response = table.scan()
    items = response['Items']
    while 'LastEvaluatedKey' in response:
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        items.extend(response['Items'])

    return {
        'statusCode': 200,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization,Content-Type',
            'Content-Type': 'application/json',
        },
        'body': json.dumps(items, cls=DecimalEncoder),
    }
