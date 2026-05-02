import json
import requests
import os
import boto3
from datetime import datetime

dynamodb = boto3.resource('dynamodb')


def parse_json_list(raw):
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [str(v).strip() for v in parsed if str(v).strip()]
    except Exception:
        pass
    return []


def get_associations():
    table_name = os.environ.get('CONFIGTABLE_TABLE_NAME')
    if not table_name:
        return []
    try:
        table = dynamodb.Table(table_name)
        selected_item = table.get_item(Key={'configKey': 'sotaAssociations'}).get('Item', {})
        selected = parse_json_list(selected_item.get('configValue', ''))
        if selected:
            return selected

        options_item = table.get_item(Key={'configKey': 'sotaAssociationOptions'}).get('Item', {})
        return parse_json_list(options_item.get('configValue', ''))
    except Exception as exc:
        print(f"[WARNING] Could not read spot associations from config: {exc}")
        return []

def get_sota_spots():
    url = f'https://api2.sota.org.uk/api/spots/-5/all'
    try:
        response = requests.get(url)
        response.raise_for_status()  # Ensure we raise for bad responses
        return response.json()
    except requests.RequestException as e:
        print(f"Error getting SOTA Spots from API: {e}")
        if response is not None:
            print(response.text)  # Print response text in case of error
        return []  # Return an empty list in case of an error to prevent further issues

def filter_data(data, associations):
    filtered_data = {}
    assoc_set = set(associations or [])
    
    for entry in data:
        association_code = entry.get("associationCode", "")
        summit_code = entry.get("summitCode", "")
        time_stamp = entry.get("timeStamp", "")
        activating_callsign = entry.get("activatingCallsign", "")

        if assoc_set and association_code not in assoc_set:
            continue

        # Generate a unique key based on activatingCallsign and summitCode
        key = (activating_callsign, summit_code)

        # Only keep the most recent entry by comparing timestamps
        if key in filtered_data:
            # Convert to datetime for comparison
            existing_time = datetime.fromisoformat(filtered_data[key]["timeStamp"])
            new_time = datetime.fromisoformat(time_stamp)

            if new_time > existing_time:
                filtered_data[key] = entry  # Replace with newer entry
        else:
            filtered_data[key] = entry  # Add new entry
    
    return list(filtered_data.values())  # Return filtered entries as a list

def handler(event, context):
    # Get current SOTA spots
    spots = get_sota_spots()
    associations = get_associations()

    # Apply the filter
    filtered_result = filter_data(spots, associations)

    # # Print the filtered result with proper Unicode characters
    # for result in filtered_result:
    #     print(json.dumps(result, indent=2, ensure_ascii=False))  # Pretty print the result in JSON format

    return filtered_result
