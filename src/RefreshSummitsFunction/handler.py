"""
RefreshSummitsFunction — downloads the SOTA summits database once per day
and writes every currently-valid summit into SummitsTable (DynamoDB).

Triggered: EventBridge schedule cron(0 2 * * ? *)   [02:00 UTC daily]
On-demand:  aws lambda invoke --function-name RefreshSummitsFunction /tmp/out.json
"""

import csv
import io
import json
import os
import urllib.request
from datetime import date

import boto3

SOTA_CSV_URL = "https://storage.sota.org.uk/summitslist.csv"
dynamodb = boto3.resource('dynamodb')


def handler(event, context):
    table_name = os.environ['SUMMITS_TABLE_NAME']
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

    # Column names are on line 1
    reader = csv.DictReader(lines[1:])

    written = 0
    skipped = 0

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

            batch.put_item(Item={
                'summitCode':      summit_code,
                'association':     association,
                'peakName':        row.get('SummitName', '').strip(),
                'associationName': row.get('AssociationName', '').strip(),
                'region':          row.get('RegionName', '').strip(),
                'elevationM':      alt_m,
                'latitude':        lat,
                'longitude':       lon,
                'points':          points,
                'validFrom':       valid_from,
                'validTo':         valid_to,
            })
            written += 1

    print(f"RefreshSummits complete: {written} written, {skipped} skipped")
    return {'written': written, 'skipped': skipped}
