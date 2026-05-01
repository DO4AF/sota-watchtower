"""
RefreshSummitsFunction — downloads the SOTA summits database once per day,
writes every currently-valid summit into SummitsTable (DynamoDB), and
uploads a compact worldwide GeoJSON to S3 for direct frontend consumption.

The S3 file (summits.json) contains ALL valid worldwide summits with minimal
properties (summitCode, points, lat, lon) to keep the payload small.

Triggered: EventBridge schedule cron(0 2 * * ? *)   [02:00 UTC daily]
On-demand:  aws lambda invoke --function-name RefreshSummitsFunction /tmp/out.json
"""

import csv
import gzip
import io
import json
import os
import urllib.request
from datetime import date

import boto3

SOTA_CSV_URL = "https://storage.sota.org.uk/summitslist.csv"
dynamodb = boto3.resource('dynamodb')
s3_client = boto3.client('s3')


def handler(event, context):
    table_name  = os.environ['SUMMITS_TABLE_NAME']
    bucket_name = os.environ.get('SUMMITS_BUCKET_NAME')
    table = dynamodb.Table(table_name)
    today = date.today().isoformat()          # "YYYY-MM-DD"

    # ── Download CSV ──────────────────────────────────────────────────────────
    print(f"Downloading {SOTA_CSV_URL}")
    req = urllib.request.Request(
        SOTA_CSV_URL,
        headers={'User-Agent': 'SOTA-Watchtower/1.0 (+https://github.com/DO4AF/sota-watchtower)'},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode('utf-8')
    except Exception as e:
        print(f"Download failed: {e}")
        raise

    # ── Parse CSV ─────────────────────────────────────────────────────────────
    # Line 0: "SOTA Summits List" header (skip)
    # Line 1: column names
    # Line 2+: data rows
    lines = raw.splitlines()
    if len(lines) < 3:
        raise ValueError(f"CSV too short: {len(lines)} lines")

    reader = csv.DictReader(lines[1:])

    written  = 0
    skipped  = 0
    features = []   # for the S3 GeoJSON

    with table.batch_writer() as batch:
        for row in reader:
            summit_code = row.get('SummitCode', '').strip()
            if not summit_code:
                skipped += 1
                continue

            valid_from = row.get('ValidFrom', '').strip()
            valid_to   = row.get('ValidTo', '').strip()

            # Skip summits that are not valid today
            if valid_from and valid_from > today:
                skipped += 1
                continue
            if valid_to and valid_to < today:
                skipped += 1
                continue

            # Extract top-level association code ("DL/AL-001" → "DL")
            association = summit_code.split('/')[0] if '/' in summit_code else summit_code

            try:
                alt_m  = int(row.get('AltM', '0').strip() or '0')
                points = int(row.get('Points', '1').strip() or '1')
                lat    = row.get('Latitude', '').strip()
                lon    = row.get('Longitude', '').strip()
            except ValueError:
                skipped += 1
                continue

            if not lat or not lon:
                skipped += 1
                continue

            peak_name   = row.get('SummitName', '').strip()
            assoc_name  = row.get('AssociationName', '').strip()
            region_name = row.get('RegionName', '').strip()

            batch.put_item(Item={
                'summitCode':      summit_code,
                'association':     association,
                'peakName':        peak_name,
                'associationName': assoc_name,
                'region':          region_name,
                'elevationM':      alt_m,
                'latitude':        lat,
                'longitude':       lon,
                'points':          points,
                'validFrom':       valid_from,
                'validTo':         valid_to,
            })
            written += 1

            # Accumulate feature for GeoJSON (minimal properties for small payload)
            try:
                features.append({
                    'type': 'Feature',
                    'geometry': {
                        'type':        'Point',
                        'coordinates': [round(float(lon), 5), round(float(lat), 5)],
                    },
                    'properties': {
                        'c': summit_code,           # summitCode
                        'n': peak_name,             # name
                        'e': alt_m,                 # elevationM
                        'p': points,                # points
                        'a': assoc_name,            # associationName
                        'r': region_name,           # region
                    },
                })
            except (ValueError, TypeError):
                pass  # skip bad coordinates for GeoJSON but already written to DDB

    print(f"RefreshSummits complete: {written} written, {skipped} skipped")

    # ── Upload worldwide GeoJSON to S3 ────────────────────────────────────────
    if bucket_name and features:
        geojson = {'type': 'FeatureCollection', 'features': features}
        body    = json.dumps(geojson, separators=(',', ':'))   # compact JSON

        # Gzip compress
        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode='wb') as gz:
            gz.write(body.encode('utf-8'))
        compressed = buf.getvalue()

        s3_client.put_object(
            Bucket=bucket_name,
            Key='summits.json',
            Body=compressed,
            ContentType='application/json',
            ContentEncoding='gzip',
            CacheControl='public, max-age=86400',   # cache for 24h
        )
        size_kb = len(compressed) // 1024
        print(f"Uploaded summits.json to s3://{bucket_name} ({len(features)} features, {size_kb} KB gzipped)")
    elif not bucket_name:
        print("SUMMITS_BUCKET_NAME not set — skipping S3 upload")

    return {'written': written, 'skipped': skipped, 'geojson_features': len(features)}
