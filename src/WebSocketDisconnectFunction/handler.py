import boto3
import os


def handler(event, context):
    connection_id = event['requestContext']['connectionId']
    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(os.environ['WEBSOCKETCONNECTIONSTABLE_TABLE_NAME'])
    table.delete_item(Key={'connectionId': connection_id})
    return {'statusCode': 200}
