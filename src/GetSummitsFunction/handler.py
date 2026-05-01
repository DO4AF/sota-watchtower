import csv
import io
import json
import os
import time
from datetime import datetime, timezone
from urllib.request import urlopen
from urllib.error import URLError

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Content-Type': 'application/json',
}

SUMMITS_URL = 'https://storage.sota.org.uk/summitslist.csv'
CACHE_PATH  = '/tmp/summitslist.csv'
CACHE_TTL   = 86400  # 24 hours


def _fetch_csv_text() -> str:
    """Return CSV text, preferring a fresh /tmp cache over the bundled file."""
    # Use cached version if it exists and is younger than 24 h
    if os.path.exists(CACHE_PATH):
        age = time.time() - os.path.getmtime(CACHE_PATH)
        if age < CACHE_TTL:
            with open(CACHE_PATH, encoding='utf-8') as f:
                return f.read()

    # Try downloading fresh copy
    try:
        with urlopen(SUMMITS_URL, timeout=10) as resp:
            text = resp.read().decode('utf-8')
        with open(CACHE_PATH, 'w', encoding='utf-8') as f:
            f.write(text)
        return text
    except (URLError, OSError) as exc:
        print(f'[GetSummitsFunction] Download failed ({exc}); falling back to bundled CSV.')

    # Fall back to bundled CSV shipped with the Lambda package
    bundled = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'summitslist.csv')
    with open(bundled, encoding='utf-8') as f:
        return f.read()


def _parse_date(s: str) -> datetime:
    """Parse DD/MM/YYYY date string into an aware UTC datetime (midnight)."""
    return datetime.strptime(s.strip(), '%d/%m/%Y').replace(tzinfo=timezone.utc)


def handler(event, context):
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    csv_text = _fetch_csv_text()
    reader = csv.reader(io.StringIO(csv_text))

    features = []
    for row in reader:
        # Skip header rows / comment rows / short rows
        if len(row) < 14:
            continue
        if row[0].startswith('SOTA') or row[0].strip() == 'SummitCode':
            continue

        try:
            summit_code    = row[0].strip()
            association    = row[1].strip()
            region         = row[2].strip()
            peak_name      = row[3].strip()
            elevation_m    = int(float(row[4].strip()))
            lon            = float(row[8].strip())   # Longitude column
            lat            = float(row[9].strip())   # Latitude column
            points         = int(float(row[10].strip()))
            valid_from_str = row[12].strip()
            valid_to_str   = row[13].strip()
        except (ValueError, IndexError):
            continue

        # Validity filter
        try:
            valid_from = _parse_date(valid_from_str)
            valid_to   = _parse_date(valid_to_str)
        except ValueError:
            continue

        if today < valid_from or today > valid_to:
            continue

        features.append({
            'type': 'Feature',
            'geometry': {
                'type': 'Point',
                'coordinates': [lon, lat],
            },
            'properties': {
                'summitCode':      summit_code,
                'associationName': association,
                'region':          region,
                'peakName':        peak_name,
                'elevationM':      elevation_m,
                'points':          points,
            },
        })

    body = json.dumps({'type': 'FeatureCollection', 'features': features})
    return {
        'statusCode': 200,
        'headers': CORS_HEADERS,
        'body': body,
    }
