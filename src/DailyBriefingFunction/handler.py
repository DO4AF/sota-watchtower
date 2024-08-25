import json
import os
import boto3
from datetime import datetime

telegram_group_id = os.getenv('TELEGRAM_GROUP_ID')

def handler(event, context):
    # Log the event argument for debugging and for use in local development.
    #print(json.dumps(event))

    # Create a Lambda client
    client = boto3.client('lambda')

    # Retrieve the Target Lambda ARN from environment variables
    sotaalerts_lambda_arn = os.environ['GETSOTAALERTSFUNCTION_FUNCTION_ARN']
    telegram_lambda_arn = os.environ['TELEGRAMNOTIFYFUNCTION_FUNCTION_ARN']

    # Invoke the Target Lambda function
    response = client.invoke(
        FunctionName=sotaalerts_lambda_arn,
        InvocationType='RequestResponse'
    )

    response_payload = json.loads(response['Payload'].read())
    #response_payload = event

    # Get the current date in YYYY-MM-DD format
    current_date = datetime.now().date().strftime("%Y-%m-%d")

    # Initialize a list to store summary lines
    summary_lines = []

    # Iterate through the alerts and filter by the current date
    for alert in response_payload:
        date_activated = alert.get('dateActivated', '')
        if date_activated:
            # Extract just the date part from the dateActivated
            alert_date = date_activated.split('T')[0]
            alert_time = date_activated.split('T')[1]

            # Check if the alert date is the same as the current date
            if alert_date == current_date:
                activating_callsign = alert.get('activatingCallsign', 'Unknown Callsign')
                summit_code = alert.get('associationCode', 'Unknown Association Code') + "/" + alert.get('summitCode', 'Unknown Summit Code')

                # Format the summary line for this alert
                summary_line = f"🏔 <b>{activating_callsign}</b> auf <b>{summit_code}</b> um {alert_time} UTC"
                
                # Add the line to the list
                summary_lines.append(summary_line)

    # Combine all lines into a single multiline string
    if summary_lines:
        summary = "\n".join(summary_lines)
    else:
        summary = "<i>Keine Aktivierungen geplant. Zeit dafür, selbst eine zu starten? 😉</i>"

    # Create the HTML-formatted message
    message = f"""
Guten Morgen liebe Chaser!
<b>Aktivierungen heute:</b>
{summary}
    """

    # Optionally, print the message for debugging purposes
    #print(message)

    # Invoke the Target Lambda function
    response = client.invoke(
        FunctionName=telegram_lambda_arn,
        InvocationType='Event',
        Payload=json.dumps(
            {
                'chat_id': telegram_group_id,
                'message': message
            }
        )
    )

    return {
        'statusCode': 200,
        'body': {}
    }
