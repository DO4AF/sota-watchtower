import json
import re
import boto3, os
from functools import lru_cache

dynamodb = boto3.resource('dynamodb')

def get_config():
    """Read Telegram credentials from DynamoDB ConfigTable at runtime."""
    table_name = os.environ.get('CONFIGTABLE_TABLE_NAME')
    if not table_name:
        # Fallback to env vars for backwards compatibility
        return {
            'telegramGroupId': os.getenv('TELEGRAM_GROUP_ID', ''),
            'telegramUserId': os.getenv('TELEGRAM_USER_ID', ''),
        }
    table = dynamodb.Table(table_name)
    response = table.scan()
    items = response.get('Items', [])
    config = {item['configKey']: item['configValue'] for item in items}
    return config

def send_telegram(chat_id, text):
    if not chat_id:
        print(f"[WARNING] No chat_id provided — skipping Telegram message")
        return

    # Create a Lambda client
    client = boto3.client('lambda')

    # Retrieve the Target Lambda ARN from environment variables
    telegram_lambda_arn = os.environ['TELEGRAMNOTIFYFUNCTION_FUNCTION_ARN']

    # Invoke the Target Lambda function
    response = client.invoke(
        FunctionName=telegram_lambda_arn,
        InvocationType='Event',
        Payload=json.dumps(
            {
                'chat_id': chat_id,
                'message': text
            }
        )
    )
    return response

def get_aprs_ssid(s):
    # Define the regex pattern
    pattern = r'[A-Za-z0-9]{3,10}-\d{1,2}'

    # Search for the pattern in the string
    match = re.search(pattern, s)

    # Check if a match is found
    if match:
        return match.group()  # Return the matched string
    else:
        return None  # No match found

def handler(event, context):

    # Load config from DynamoDB (includes Telegram credentials)
    config = get_config()
    telegram_group_id = config.get('telegramGroupId', os.getenv('TELEGRAM_GROUP_ID', ''))
    telegram_user_id  = config.get('telegramUserId',  os.getenv('TELEGRAM_USER_ID', ''))

    print(f"[INFO] Telegram group_id={telegram_group_id!r} user_id={telegram_user_id!r}")

    # Extract and decode the 'body'
    body = event.get('body', '{}')

    # If body is a string and needs to be parsed as JSON
    if isinstance(body, str):
        try:
            # Decode the JSON string into a Python dictionary
            spot_data = json.loads(body)
        except json.JSONDecodeError:
            print("Error decoding JSON from body.")
            return {
                'statusCode': 400,
                'body': 'Invalid JSON format in body'
            }
    else:
        # If body is already a dictionary, use it directly
        spot_data = body

    # Initialize the message components
    sotastring = ""

    # Construct the sotastring if summit information is present
    if "summitRef" in spot_data:
        sotastring = " auf " + spot_data['summitRef']

    # Store the trigger comment
    trigger_comment = spot_data.get("triggerComment", "NONE")

    # Construct the message
    full_callsign = spot_data.get("fullCallsign", "No Callsign provided")
    frequency = spot_data.get("frequency", "Unknown Frequency")
    mode = spot_data.get("mode", "Unknown Mode").upper()
    comment = spot_data.get("comment", "No Comment provided")
    summit_ref = spot_data.get("summitRef", "No Summit Reference")
    summit_name = spot_data.get("summitName", "No Summit Name")
    summit_height = spot_data.get("summitHeight", "No Summit Height")

    # Select country flag
    if "OE/" in summit_ref:
        flag = '🇦🇹'
    elif "DL/" in summit_ref or "DM/" in summit_ref:
        flag = '🇩🇪'
    else:
        flag = ""

    aprs_information = ""
    aprs_ssid = get_aprs_ssid(comment)
    if aprs_ssid:
        aprs_information = f"🗺️ <a href=\"https://aprs.fi/?call={aprs_ssid}&timerange=10800&tail=10800&others=1&z=19&mt=terrain\">Verfolge {full_callsign} auf APRS.fi</a>"

    # HTML-formatted message with variables
    message = f"""
    <b>{full_callsign}{sotastring} {flag}</b>
🏔 {summit_name} {summit_height}m
📻 {frequency} {mode}
🏆 {spot_data['summitPoints']} Punkte
{aprs_information}
{comment}
"""
    match_count = 0

    if "SOTA2TELEGRAM_VHFUHF" in trigger_comment:
        send_telegram(telegram_group_id, message)
        match_count += 1

    if "USER" in trigger_comment:
        send_telegram(telegram_user_id, message)
        match_count += 1

    if match_count < 1:
        send_telegram(telegram_user_id, "Invalid trigger comment " + trigger_comment + ". Check HamAlert config.")

    return {
        'statusCode': 200,
        'body': 'Message received successfully'
    }
