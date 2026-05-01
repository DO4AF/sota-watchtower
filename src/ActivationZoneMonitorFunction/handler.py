import json
import boto3
import requests
import os
from datetime import datetime, timedelta
import re
from geopy.distance import geodesic
import time

telegram_group_id = os.getenv('TELEGRAM_GROUP_ID')

# Initialize the boto3 client for Lambda
lambda_client = boto3.client('lambda')

# Initialize the boto3 client for DynamoDB
dynamodb = boto3.resource('dynamodb')

def fetch_alerts():
    # Get alerts from SotaAlertsTable (dynamoDB)
    table = dynamodb.Table(os.getenv('SOTAALERTSTABLE_TABLE_NAME'))
    response = table.scan()
    alerts = response['Items']
    while 'LastEvaluatedKey' in response:
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        alerts.extend(response['Items'])
    return alerts

def store_aprs_position(callsign, latitude, longitude, altitude):
    """Store APRS walker position in DynamoDB with 2-hour TTL."""
    table_name = os.getenv('APRSPOSITIONSTABLE_TABLE_NAME')
    if not table_name:
        return
    table = dynamodb.Table(table_name)
    ttl = int(time.time()) + 7200  # 2 hours TTL
    table.put_item(Item={
        'callsign': callsign,
        'latitude': str(latitude),
        'longitude': str(longitude),
        'altitude': str(altitude),
        'lastSeen': datetime.utcnow().isoformat(),
        'ttl': ttl,
    })

def notify_telegram(chat_id, text):
    # Invoke the TelegramNotifyFunction
    response = lambda_client.invoke(
        FunctionName=os.getenv('TELEGRAMNOTIFYFUNCTION_FUNCTION_ARN'),
        InvocationType='Event',
        Payload=json.dumps(
            {
                'chat_id': chat_id,
                'message': text
            }
        )
    )
    return response

def mark_alert_as_notified(callsign, summit):
    # mark as notified by adding the key 'notified' to the item
    table = dynamodb.Table(os.getenv('SOTAALERTSTABLE_TABLE_NAME'))
    response = table.update_item(
        Key={
            'callsign': callsign,
            'summit': summit
        },
        UpdateExpression="set notified = :n",  # Update the item
        ExpressionAttributeValues={  # Define the expression attribute values
            ':n': True
        },
        ReturnValues="UPDATED_NEW"
    )
    return response

def handler(event, context):
    # Get Alerts from GetSotaAlertsFunction
    upcoming_alerts = fetch_alerts()  # Fetch alerts from the Lambda function
    aprs_callsign = event.get('callsign')
    aprs_latitude = event.get('latitude')
    aprs_longitude = event.get('longitude')
    aprs_altitude = event.get('altitude')

    print(f"APRS Callsign: {aprs_callsign}, APRS Latitude: {aprs_latitude}, APRS Longitude: {aprs_longitude}, APRS Altitude: {aprs_altitude}")

    # Always store the APRS position for map display
    store_aprs_position(aprs_callsign, aprs_latitude, aprs_longitude, aprs_altitude)

    # loop through all activations
    for alert in upcoming_alerts:
        summit_code = alert.get('summit')
        alert_callsign = alert.get('callsign')

        if alert_callsign in aprs_callsign:
            print(f"Activator {alert_callsign} of {summit_code} found in APRS data.")

            # Get the summit Latitude and Longitude from the summitslist.csv
            summit_lat = None
            summit_lon = None
            summit_altitude = None
            with open('summitslist.csv', 'r') as file:
                summits = file.readlines()[2:]
                for summit in summits:
                    summit_data = summit.split(',')
                    summit_code_file = summit_data[0]
                    summit_lon = summit_data[8]
                    summit_lat = summit_data[9]
                    summit_altitude = summit_data[4]
                    if summit_code_file == summit_code:
                        break

            if summit_lat and summit_lon:
                # Calculate the distance between the walker and the summit
                walker_coordinates = (aprs_latitude, aprs_longitude)
                summit_coordinates = (summit_lat, summit_lon)
                distance = geodesic(walker_coordinates, summit_coordinates).kilometers

                if distance < 0.3:
                    # Check if walker is within 25m below the summit altitude
                    if aprs_altitude < float(summit_altitude) - 25:
                        print("Walker is not within 25m below the summit altitude.")
                    else:
                        print("Walker is within 25m below the summit altitude!")
                        notify_telegram(telegram_group_id, f"🏔 {aprs_callsign} ist in der Aktivierungszone von {summit_code_file}!")
                        mark_alert_as_notified(alert_callsign, summit_code)

            break

    return {}
