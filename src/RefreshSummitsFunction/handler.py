"""
RefreshSummitsFunction — downloads the SOTA summits database once per day,
writes every currently-valid summit into SummitsTable (DynamoDB), and
uploads summit GeoJSON files to S3 for direct frontend consumption.

S3 layout:
  summits.json               — full worldwide file (all associations, gzip)
  summits/<ASSOC>.json       — per-association file, e.g. summits/DL.json (gzip)
  summits-manifest.json      — list of available per-association file keys (plain JSON)

The frontend loads only the per-association files it needs (configured in the
user's association filter), downloading ~90% less data compared to the full file.
The full summits.json is kept for backward compatibility.

Triggered: EventBridge schedule cron(0 2 * * ? *)   [02:00 UTC daily]
On-demand:  aws lambda invoke --function-name RefreshSummitsFunction /tmp/out.json
"""

import csv
import gzip
import io
import json
import os
import urllib.request
from collections import defaultdict
from datetime import date
from datetime import datetime

import boto3

SOTA_CSV_URL = "https://storage.sota.org.uk/summitslist.csv"
dynamodb  = boto3.resource('dynamodb')
s3_client = boto3.client('s3')


def update_bbox(bbox: dict, lat: float, lon: float) -> None:
    bbox['minLat'] = min(bbox['minLat'], lat)
    bbox['maxLat'] = max(bbox['maxLat'], lat)
    bbox['minLon'] = min(bbox['minLon'], lon)
    bbox['maxLon'] = max(bbox['maxLon'], lon)


def make_bbox():
    return {
        'minLat': 90.0,
        'maxLat': -90.0,
        'minLon': 180.0,
        'maxLon': -180.0,
    }


def to_aprs_area(bbox: dict) -> dict:
    return {
        'latN': round(bbox['maxLat'], 4),
        'lonW': round(bbox['minLon'], 4),
        'latS': round(bbox['minLat'], 4),
        'lonE': round(bbox['maxLon'], 4),
    }


def parse_sota_date(raw_value: str) -> date | None:
    """Parse SOTA CSV date fields (DD/MM/YYYY) into date objects."""
    raw = (raw_value or '').strip()
    if not raw:
        return None
    try:
        return datetime.strptime(raw, '%d/%m/%Y').date()
    except ValueError:
        return None


def _gzip_json(obj: dict | list) -> bytes:
    """Serialize obj to compact JSON and gzip-compress it."""
    body = json.dumps(obj, separators=(',', ':'))
    buf  = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb') as gz:
        gz.write(body.encode('utf-8'))
    return buf.getvalue()


def _upload_gzip(bucket_name: str, key: str, compressed: bytes) -> int:
    """Upload a gzip-compressed object to S3. Returns compressed size in bytes."""
    s3_client.put_object(
        Bucket=bucket_name,
        Key=key,
        Body=compressed,
        ContentType='application/json',
        ContentEncoding='gzip',
        CacheControl='public, max-age=86400',   # cache for 24 h
    )
    return len(compressed)


def handler(event, context):
    table_name        = os.environ['SUMMITS_TABLE_NAME']
    bucket_name       = os.environ.get('SUMMITS_BUCKET_NAME')
    config_table_name = os.environ.get('CONFIGTABLE_TABLE_NAME')
    table        = dynamodb.Table(table_name)
    config_table = dynamodb.Table(config_table_name) if config_table_name else None
    today        = date.today()

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
    features_all: list[dict] = []               # full worldwide set
    features_by_assoc: dict[str, list[dict]] = defaultdict(list)  # per association

    associations            = set()
    regions_by_association  = defaultdict(set)
    bbox_by_association     = defaultdict(make_bbox)
    bbox_by_region          = defaultdict(make_bbox)

    with table.batch_writer() as batch:
        for row in reader:
            summit_code = row.get('SummitCode', '').strip()
            if not summit_code:
                skipped += 1
                continue

            valid_from_raw = row.get('ValidFrom', '').strip()
            valid_to_raw   = row.get('ValidTo', '').strip()
            valid_from = parse_sota_date(valid_from_raw)
            valid_to   = parse_sota_date(valid_to_raw)

            # Skip summits that are not valid today
            if valid_from and valid_from > today:
                skipped += 1
                continue
            if valid_to and valid_to < today:
                skipped += 1
                continue

            # Extract top-level association code ("DL/AL-001" → "DL")
            association = summit_code.split('/')[0] if '/' in summit_code else summit_code
            if association:
                associations.add(association)

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

            try:
                lat_f = float(lat)
                lon_f = float(lon)
            except ValueError:
                skipped += 1
                continue

            peak_name   = row.get('SummitName', '').strip()
            assoc_name  = row.get('AssociationName', '').strip()
            region_name = row.get('RegionName', '').strip()
            if association and region_name:
                regions_by_association[association].add(region_name)
            if association:
                update_bbox(bbox_by_association[association], lat_f, lon_f)
            if association and region_name:
                region_key = f"{association}|{region_name}"
                update_bbox(bbox_by_region[region_key], lat_f, lon_f)

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
                'validFrom':       valid_from_raw,
                'validTo':         valid_to_raw,
            })
            written += 1

            # Accumulate GeoJSON feature (minimal properties for small payload)
            try:
                feature = {
                    'type': 'Feature',
                    'geometry': {
                        'type':        'Point',
                        'coordinates': [round(lon_f, 5), round(lat_f, 5)],
                    },
                    'properties': {
                        'c': summit_code,   # summitCode
                        'n': peak_name,     # name
                        'e': alt_m,         # elevationM
                        'p': points,        # points
                        'a': assoc_name,    # associationName
                        'r': region_name,   # region
                    },
                }
                features_all.append(feature)
                if association:
                    features_by_assoc[association].append(feature)
            except (ValueError, TypeError):
                pass  # skip bad coordinates for GeoJSON but already written to DDB

    print(f"RefreshSummits complete: {written} written, {skipped} skipped")

    # ── Update dynamic config option catalog in ConfigTable ──────────────────
    if config_table:
        assoc_options = sorted(a for a in associations if a)
        region_options = {
            assoc: sorted(list(regions))
            for assoc, regions in sorted(regions_by_association.items())
            if assoc
        }
        aprs_area_by_association = {
            assoc: to_aprs_area(bbox)
            for assoc, bbox in sorted(bbox_by_association.items())
            if assoc
        }
        aprs_area_by_region = {
            key: to_aprs_area(bbox)
            for key, bbox in sorted(bbox_by_region.items())
            if key
        }

        config_table.put_item(
            Item={
                'configKey': 'sotaAssociationOptions',
                'configValue': json.dumps(assoc_options),
            }
        )
        config_table.put_item(
            Item={
                'configKey': 'sotaRegionsByAssociation',
                'configValue': json.dumps(region_options),
            }
        )
        config_table.put_item(
            Item={
                'configKey': 'sotaAprsAreaByAssociation',
                'configValue': json.dumps(aprs_area_by_association),
            }
        )
        config_table.put_item(
            Item={
                'configKey': 'sotaAprsAreaByRegion',
                'configValue': json.dumps(aprs_area_by_region),
            }
        )
        print(
            f"Updated config options: associations={len(assoc_options)} "
            f"assoc-with-regions={len(region_options)} "
            f"assoc-bboxes={len(aprs_area_by_association)} region-bboxes={len(aprs_area_by_region)}"
        )
    else:
        print("CONFIGTABLE_TABLE_NAME not set — skipping config option catalog refresh")

    # ── Upload GeoJSON files to S3 ────────────────────────────────────────────
    if not bucket_name:
        print("SUMMITS_BUCKET_NAME not set — skipping S3 upload")
        return {'written': written, 'skipped': skipped, 'geojson_features': len(features_all)}

    if not features_all:
        print("No features to upload")
        return {'written': written, 'skipped': skipped, 'geojson_features': 0}

    # 1. Full worldwide file (backward-compatible)
    compressed_full = _gzip_json({'type': 'FeatureCollection', 'features': features_all})
    _upload_gzip(bucket_name, 'summits.json', compressed_full)
    print(
        f"Uploaded summits.json to s3://{bucket_name} "
        f"({len(features_all)} features, {len(compressed_full) // 1024} KB gzipped)"
    )

    # 2. Per-association files  (e.g. summits/DL.json)
    #    The frontend downloads only the associations it is configured to monitor,
    #    reducing the download by up to ~90% for typical single-country setups.
    assoc_keys: list[str] = []
    total_per_assoc_bytes = 0
    for assoc_code, feat_list in sorted(features_by_assoc.items()):
        if not assoc_code:
            continue
        s3_key = f"summits/{assoc_code}.json"
        compressed = _gzip_json({'type': 'FeatureCollection', 'features': feat_list})
        _upload_gzip(bucket_name, s3_key, compressed)
        total_per_assoc_bytes += len(compressed)
        assoc_keys.append(s3_key)

    print(
        f"Uploaded {len(assoc_keys)} per-association files to s3://{bucket_name}/summits/ "
        f"(total {total_per_assoc_bytes // 1024} KB gzipped)"
    )

    # 3. Manifest file — plain JSON (tiny, not gzipped) listing available keys.
    #    The frontend can use this to verify that per-association files exist
    #    before falling back to the full file.
    manifest = {
        'generatedAt': datetime.utcnow().isoformat() + 'Z',
        'totalFeatures': len(features_all),
        'associations': sorted(features_by_assoc.keys()),
        'keys': sorted(assoc_keys),
    }
    s3_client.put_object(
        Bucket=bucket_name,
        Key='summits-manifest.json',
        Body=json.dumps(manifest, separators=(',', ':')).encode('utf-8'),
        ContentType='application/json',
        CacheControl='public, max-age=3600',   # manifest refreshes hourly
    )
    print(f"Uploaded summits-manifest.json ({len(manifest['associations'])} associations)")

    return {
        'written': written,
        'skipped': skipped,
        'geojson_features': len(features_all),
        'per_assoc_files': len(assoc_keys),
    }
