import json
import urllib.request
import boto3


def send_cfn_response(event, context, status, reason='', data=None):
    body = json.dumps({
        'Status': status,
        'Reason': reason,
        'PhysicalResourceId': context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data or {},
    }).encode()
    req = urllib.request.Request(
        url=event['ResponseURL'],
        data=body,
        method='PUT',
        headers={'Content-Type': '', 'Content-Length': len(body)},
    )
    urllib.request.urlopen(req)


def handler(event, context):
    props = event.get('ResourceProperties', {})
    request_type = event.get('RequestType')
    try:
        if request_type == 'Delete':
            send_cfn_response(event, context, 'SUCCESS')
            return

        # --- Seed ConfigTable (attribute_not_exists prevents overwriting) ---
        dynamodb = boto3.resource('dynamodb')
        config_table = dynamodb.Table(props['ConfigTableName'])
        defaults = {
            'frequencyFilterPattern': props.get('FrequencyFilterPattern', ''),
            'sotaAssociations': json.dumps(['DL', 'DM', 'OE']),
            'sotaRegions': json.dumps([]),
            'activationZoneDistanceMeters': '300',
            'activationZoneAltitudeDeltaMeters': '25',
        }
        ddb_client = dynamodb.meta.client
        for key, value in defaults.items():
            try:
                config_table.put_item(
                    Item={'configKey': key, 'configValue': str(value)},
                    ConditionExpression='attribute_not_exists(configKey)',
                )
            except ddb_client.exceptions.ConditionalCheckFailedException:
                pass  # Already set by a previous deploy — keep runtime value

        # --- Create Cognito admin user with permanent password ---
        user_pool_id = props.get('UserPoolId', '')
        admin_email = props.get('AdminEmail', '')
        admin_password = props.get('AdminPassword', '')

        if user_pool_id and admin_email and admin_password:
            cognito = boto3.client('cognito-idp')
            try:
                cognito.admin_create_user(
                    UserPoolId=user_pool_id,
                    Username=admin_email,
                    UserAttributes=[
                        {'Name': 'email', 'Value': admin_email},
                        {'Name': 'email_verified', 'Value': 'true'},
                    ],
                    MessageAction='SUPPRESS',
                )
            except cognito.exceptions.UsernameExistsException:
                pass  # Idempotent on stack update
            cognito.admin_set_user_password(
                UserPoolId=user_pool_id,
                Username=admin_email,
                Password=admin_password,
                Permanent=True,
            )

        send_cfn_response(event, context, 'SUCCESS')
    except Exception as exc:
        send_cfn_response(event, context, 'FAILED', reason=str(exc))
