import boto3
import os
import time


def handler(event, context):
    connection_id = event['requestContext']['connectionId']
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(os.environ['WEBSOCKETCONNECTIONSTABLE_TABLE_NAME'])
    table.put_item(Item={
        'connectionId': connection_id,
        'ttl': int(time.time()) + 7200,
    })
    return {'statusCode': 200}
