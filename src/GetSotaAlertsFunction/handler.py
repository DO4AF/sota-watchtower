import json
import requests
import re
from datetime import datetime, timedelta
import time
import os
import boto3

# Filter settings
filter_combinations = {
    "DL": {"summit_patterns": []},  # No specific summit filter for "DL"
    "OE": {"summit_patterns": []},  # No specific summit filter for "OE"
    "DM": {"summit_patterns": [r"DM", r"BW"]},  # DM requires summit codes to contain "DM" or "BW"
    # Add more associations and summit patterns as needed
}

def build_frequency_pattern():
    """Build a safe regex pattern for frequency filtering.

    Falls back to a permissive pattern if the env var is missing/invalid,
    so alert ingestion never silently dies after redeploy.
    """
    raw = os.getenv("FREQUENCY_FILTER_PATTERN", "")
    if not raw:
        return re.compile(r".*")
    try:
        return re.compile(raw)
    except re.error as exc:
        print(f"[WARNING] Invalid FREQUENCY_FILTER_PATTERN={raw!r}: {exc}. Falling back to match-all.")
        return re.compile(r".*")


def parse_iso8601(value):
    if not value:
        return None
    try:
        # SOTA API may return trailing Z.
        return datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None


def normalize_summit_ref(association_code, summit_code):
    association = str(association_code or '').strip()
    summit = str(summit_code or '').strip()

    if '/' in summit:
        left, right = summit.split('/', 1)
        if left and not association:
            association = left.strip()
        summit = right.strip()

    if not summit:
        return ''
    return f"{association}/{summit}".strip('/')

def get_sota_alerts():
    url = f'https://api2.sota.org.uk/api/alerts'
    try:
        response = requests.get(url)
        response.raise_for_status()  # Ensure we raise for bad responses
        return response.json()
    except requests.RequestException as e:
        print(f"Error getting SOTA Spots from API: {e}")
        if response is not None:
            print(response.text)  # Print response text in case of error
        return []  # Return an empty list in case of an error to prevent further issues

def summit_code_matches(summit_code, summit_patterns):
    """Check if the summit code matches any of the specified summit patterns."""
    for pattern in summit_patterns:
        if re.search(pattern, summit_code):
            return True
    return False

def filter_data(data, filter_combinations, frequency_regex):
    filtered_data = {}
    
    for entry in data:
        association_code = str(entry.get("associationCode", "") or "").strip()
        summit_code = str(entry.get("summitCode", "") or "").strip()
        summit_ref = normalize_summit_ref(association_code, summit_code)
        if not association_code and '/' in summit_ref:
            association_code = summit_ref.split('/', 1)[0]
        frequency = entry.get("frequency", "")
        time_stamp = entry.get("timeStamp", "") or entry.get("timestamp", "")
        activating_callsign = (
            entry.get("activatingCallsign", "")
            or entry.get("activatorCallsign", "")
            or entry.get("callsign", "")
        )

        # Check if the association code has specific filter criteria
        if association_code in filter_combinations:
            summit_patterns = filter_combinations[association_code]["summit_patterns"]

            # If summit_patterns are defined, check for summit code match
            if summit_patterns and not summit_code_matches(summit_code, summit_patterns):
                continue  # Skip this entry if summit code doesn't match the pattern

            # Filter by frequency using regex
            if re.search(frequency_regex, frequency):
                # Generate a unique key based on activatingCallsign and summitCode
                key = (activating_callsign, summit_ref)

                # Only keep the most recent entry by comparing timestamps
                if key in filtered_data:
                    existing_time = parse_iso8601(filtered_data[key].get("timeStamp", ""))
                    new_time = parse_iso8601(time_stamp)

                    if new_time and existing_time:
                        if new_time > existing_time:
                            filtered_data[key] = entry  # Replace with newer entry
                    elif new_time and not existing_time:
                        filtered_data[key] = entry
                else:
                    filtered_data[key] = entry  # Add new entry
    
    return list(filtered_data.values())  # Return filtered entries as a list

def get_next_day_start_timestamp():
    now = datetime.utcnow()
    # Calculate the start of the next day
    next_day_start = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    # Convert to Unix timestamp
    return int(next_day_start.timestamp())

def handler(event, context):
    frequency_pattern = build_frequency_pattern()

    # Get current SOTA alerts
    alerts = get_sota_alerts()

    # Apply the filter
    filtered_result = filter_data(alerts, filter_combinations, frequency_pattern)

    expiration_timestamp = get_next_day_start_timestamp()

    dynamodb = boto3.client('dynamodb')

    # Delete all items in the table
    table_name = os.getenv('SOTAALERTSTABLE_TABLE_NAME')
    delete_count = 0
    scan_kwargs = {'TableName': table_name}
    while True:
        response = dynamodb.scan(**scan_kwargs)
        for item in response.get('Items', []):
            callsign = item['callsign']['S']
            summit = item['summit']['S']
            dynamodb.delete_item(TableName=table_name, Key={'callsign': {'S': str(callsign)}, 'summit': {'S': str(summit)}})
            delete_count += 1
        if 'LastEvaluatedKey' not in response:
            break
        scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']

    # Print the filtered result with proper Unicode characters
    for result in filtered_result:
        #print(json.dumps(result, indent=2, ensure_ascii=False))  # Pretty print the result in JSON format

        summit_code = normalize_summit_ref(result.get("associationCode"), result.get("summitCode"))
        callsign = (
            result.get("activatingCallsign")
            or result.get("activatorCallsign")
            or result.get("posterCallsign")
            or result.get("callsign")
            or ""
        )
        poster_callsign = result.get("posterCallsign", "")
        frequency = str(result.get("frequency", "") or "")
        mode = str(result.get("mode", "") or "")
        comments = str(result.get("comments", result.get("comment", "")) or "")

        # Define the item to be put into DynamoDB
        item = {
            'callsign': {'S': callsign},
            'summit': {'S': summit_code},
            'notified': {'BOOL': False},
            'expiration': {'N': str(expiration_timestamp)},
            'dateActivated': {'S': result.get("dateActivated", result.get("activationDate", ""))},
            'posterCallsign': {'S': poster_callsign},
            'frequency': {'S': frequency},
            'mode': {'S': mode},
            'comments': {'S': comments},
        }

        # Put item into DynamoDB table
        dynamodb.put_item(TableName=table_name, Item=item)

    print(
        f"[INFO] GetSotaAlertsFunction: fetched={len(alerts)} filtered={len(filtered_result)} "
        f"deleted={delete_count} written={len(filtered_result)}"
    )

    return filtered_result
