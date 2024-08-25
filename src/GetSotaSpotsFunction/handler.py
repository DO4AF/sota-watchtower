import json
import requests
import re
from datetime import datetime

# Filter settings
filter_combinations = {
    "DL": {"summit_patterns": []},  # No specific summit filter for "DL"
    "OE": {"summit_patterns": []},  # No specific summit filter for "OE"
    "DM": {"summit_patterns": [r"DM", r"BW"]},  # DM requires summit codes to contain "DM" or "BW"
    # Add more associations and summit patterns as needed
}

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

def summit_code_matches(summit_code, summit_patterns):
    """Check if the summit code matches any of the specified summit patterns."""
    for pattern in summit_patterns:
        if re.search(pattern, summit_code):
            return True
    return False

def filter_data(data, filter_combinations):
    filtered_data = {}
    
    for entry in data:
        association_code = entry.get("associationCode", "")
        summit_code = entry.get("summitCode", "")
        time_stamp = entry.get("timeStamp", "")
        activating_callsign = entry.get("activatingCallsign", "")

        # Check if the association code has specific filter criteria
        if association_code in filter_combinations:
            summit_patterns = filter_combinations[association_code]["summit_patterns"]

            # If summit_patterns are defined, check for summit code match
            if summit_patterns and not summit_code_matches(summit_code, summit_patterns):
                continue  # Skip this entry if summit code doesn't match the pattern

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

    # Apply the filter
    filtered_result = filter_data(spots, filter_combinations)

    # # Print the filtered result with proper Unicode characters
    # for result in filtered_result:
    #     print(json.dumps(result, indent=2, ensure_ascii=False))  # Pretty print the result in JSON format

    return filtered_result
