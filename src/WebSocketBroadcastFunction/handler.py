import json
import boto3
import os
from boto3.dynamodb.types import TypeDeserializer

deserializer = TypeDeserializer()


def handler(event, context):
    dynamodb = boto3.resource('dynamodb')
    connections_table = dynamodb.Table(os.environ['WEBSOCKETCONNECTIONSTABLE_TABLE_NAME'])

    endpoint_url = os.environ['WS_API_ENDPOINT']
    apigw = boto3.client('apigatewaymanagementapi', endpoint_url=endpoint_url)

    for record in event.get('Records', []):
        if record['eventName'] not in ('INSERT', 'MODIFY'):
            continue

        new_image = record['dynamodb'].get('NewImage', {})
        alert = {k: deserializer.deserialize(v) for k, v in new_image.items()}
        payload = json.dumps({'type': 'ALERT_UPDATE', 'payload': alert}, default=str).encode()

        connections = []
        scan_kwargs = {}
        while True:
            resp = connections_table.scan(**scan_kwargs)
            connections.extend(resp['Items'])
            if 'LastEvaluatedKey' not in resp:
                break
            scan_kwargs['ExclusiveStartKey'] = resp['LastEvaluatedKey']

        for conn in connections:
            try:
                apigw.post_to_connection(
                    ConnectionId=conn['connectionId'],
                    Data=payload,
                )
            except apigw.exceptions.GoneException:
                connections_table.delete_item(Key={'connectionId': conn['connectionId']})

    return {'statusCode': 200}
