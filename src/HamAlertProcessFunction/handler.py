import json
import re
import boto3, os

dynamodb = boto3.resource('dynamodb')


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

    aprs_ssid = get_aprs_ssid(comment)

    # HTML-formatted message with variables
    message = f"""
    <b>{full_callsign}{sotastring} {flag}</b>
🏔 {summit_name} {summit_height}m
📻 {frequency} {mode}
🏆 {spot_data['summitPoints']} Punkte
{comment}
"""

    print(f"[INFO] HamAlert spot received: trigger={trigger_comment!r} callsign={full_callsign!r} summit={summit_ref!r}")

    # TODO: implement notification dispatch (Telegram removed; new notification system TBD)

    return {
        'statusCode': 200,
        'body': 'Message received successfully'
    }
