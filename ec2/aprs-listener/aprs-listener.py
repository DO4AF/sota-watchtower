import aprslib
import boto3
import json
import time
import os

def packet_handler(packet):
    #print(f"Received packet: {packet.get('symbol_table')}{packet.get('symbol')} ")

    if packet.get('symbol_table') == '/' and (packet.get('symbol') == '[' or packet.get('symbol') == 'p'):
        callsign = packet.get('from')
        comment = packet.get('comment')
        speed = packet.get('speed')

        print(f"[INFO]    Received walker packet: {callsign} - {comment} - https://aprs.fi/?call={callsign}&timerange=10800&tail=10800&others=1&z=19&mt=terrain")
        
        speed = packet.get('speed')
        if(speed and speed > 10):
            print(f"[WARNING] {callsign} is too fast - speed: {speed} km/h")
        else:
            print(f"[INFO]    {callsign} is walking - speed: {speed} km/h")
            print(f"[SUCCESS] {callsign} could be a SOTA activator")

            # Define the payload to send to the Lambda function (can be a JSON string or a dict)
            payload = {
                "callsign": callsign,
                "latitude": packet.get('latitude'),
                "longitude": packet.get('longitude'),
                "altitude": packet.get('altitude'),
            }

            # Invoke the Lambda function
            response = lambda_client.invoke(
                FunctionName=function_arn,
                InvocationType='Event',  # Use 'Event' for asynchronous invocation
                Payload=json.dumps(payload)  # Convert payload to JSON string if it's a dict
            )

            print('Lambda invocation request sent. Request ID:', response['ResponseMetadata']['RequestId'])

# Create a client object and specify port 14580
client = aprslib.IS("N0CALL", port=14580)
# Set area filter to receive packets only from Austria and southern Germany
client.set_filter("a/49.0/7.7/46.0/16.5")

# Create a Lambda client
lambda_client = boto3.client('lambda', region_name='eu-central-1')

# Define the name of the Lambda function you want to invoke
function_arn = os.environ.get('ACTIVATIONZONEMONITORFUNCTION_FUNCTION_ARN')

while True:
    try:
        print("Connecting to APRS-IS server on port 14580...")
        client.connect()  # Connect to the APRS-IS server
        
        # Start receiving packets
        client.consumer(callback=packet_handler)
        
    except aprslib.exceptions.ConnectionDrop:
        print("Connection dropped.")
        time.sleep(10)  # Wait for 10 seconds before reconnecting
    except Exception as e:
        print(f"An error occurred: {e}")
        time.sleep(10)  # Wait for 10 seconds before reconnecting
