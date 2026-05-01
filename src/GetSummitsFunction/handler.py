import csv
import json
import os

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Content-Type': 'application/json',
}


def handler(event, context):
    features = []
    csv_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'summitslist.csv')
    with open(csv_path, newline='', encoding='utf-8') as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) < 11:
                continue
            try:
                summit_code = row[0].strip()
                association_name = row[1].strip()
                region = row[2].strip()
                peak_name = row[3].strip()
                elevation_m = int(row[4].strip())
                lon = float(row[6].strip())
                lat = float(row[7].strip())
                points = int(row[10].strip())
            except (ValueError, IndexError):
                continue
            features.append({
                'type': 'Feature',
                'geometry': {
                    'type': 'Point',
                    'coordinates': [lon, lat],
                },
                'properties': {
                    'summitCode': summit_code,
                    'associationName': association_name,
                    'region': region,
                    'peakName': peak_name,
                    'elevationM': elevation_m,
                    'points': points,
                },
            })

    return {
        'statusCode': 200,
        'headers': CORS_HEADERS,
        'body': json.dumps({'type': 'FeatureCollection', 'features': features}),
    }
