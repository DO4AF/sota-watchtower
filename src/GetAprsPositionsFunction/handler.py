import json
import boto3
import os
import time
from decimal import Decimal
from datetime import datetime, timedelta, timezone

dynamodb = boto3.resource('dynamodb')

# ─── Module-level config cache ────────────────────────────────────────────────
# Config values (selected associations, bounding boxes) almost never change.
# Caching them in the Lambda execution context avoids 4 DynamoDB reads on every
# warm invocation, saving ~80 ms per request.
_CONFIG_CACHE: dict = {}
_CONFIG_CACHE_TIME: float = 0.0
_CONFIG_CACHE_TTL: float = 300.0   # 5 minutes


def _read_config_item(table, key: str) -> str:
    try:
        item = table.get_item(Key={'configKey': key}).get('Item', {})
        return item.get('configValue', '')
    except Exception:
        return ''


def _load_config(config_table) -> dict:
    """Read all required config keys from DynamoDB in one batch."""
    keys = [
        'sotaAssociations',
        'sotaRegions',
        'sotaAssociationOptions',
        'sotaAprsAreaByAssociation',
        'sotaAprsAreaByRegion',
    ]
    return {k: _read_config_item(config_table, k) for k in keys}


def get_cached_config(config_table) -> dict:
    """Return config dict, reading from DynamoDB at most once every TTL seconds."""
    global _CONFIG_CACHE, _CONFIG_CACHE_TIME
    now = time.monotonic()
    if _CONFIG_CACHE and (now - _CONFIG_CACHE_TIME) < _CONFIG_CACHE_TTL:
        return _CONFIG_CACHE
    _CONFIG_CACHE = _load_config(config_table)
    _CONFIG_CACHE_TIME = now
    return _CONFIG_CACHE


# ─── JSON helpers ─────────────────────────────────────────────────────────────

def parse_json_list(raw):
    if isinstance(raw, list):
        return [str(v).strip() for v in raw if str(v).strip()]
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [str(v).strip() for v in parsed if str(v).strip()]
    except Exception:
        pass
    return []


def parse_json_dict(raw):
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return {}


def _normalize_bbox(raw_bbox):
    if not isinstance(raw_bbox, dict):
        return None
    try:
        lat_n = float(raw_bbox.get('latN'))
        lon_w = float(raw_bbox.get('lonW'))
        lat_s = float(raw_bbox.get('latS'))
        lon_e = float(raw_bbox.get('lonE'))
    except Exception:
        return None

    top    = max(lat_n, lat_s)
    bottom = min(lat_n, lat_s)
    left   = min(lon_w, lon_e)
    right  = max(lon_w, lon_e)
    return {'latN': top, 'latS': bottom, 'lonW': left, 'lonE': right}


def build_scope_bboxes(config: dict):
    selected_associations = parse_json_list(config.get('sotaAssociations', ''))
    selected_regions      = parse_json_list(config.get('sotaRegions', ''))
    association_options   = parse_json_list(config.get('sotaAssociationOptions', ''))
    area_by_association   = parse_json_dict(config.get('sotaAprsAreaByAssociation', ''))
    area_by_region        = parse_json_dict(config.get('sotaAprsAreaByRegion', ''))

    has_scope_selection   = bool(selected_associations or selected_regions)
    associations_to_use   = selected_associations if selected_associations else association_options

    bboxes = []
    if selected_regions:
        for region_key in selected_regions:
            bbox = _normalize_bbox(area_by_region.get(region_key))
            if bbox:
                bboxes.append(bbox)
    else:
        for assoc in associations_to_use:
            bbox = _normalize_bbox(area_by_association.get(assoc))
            if bbox:
                bboxes.append(bbox)

    return bboxes, has_scope_selection


def is_item_in_scope(item, bboxes):
    if not bboxes:
        return True
    try:
        lat = float(item.get('latitude'))
        lon = float(item.get('longitude'))
    except Exception:
        return False

    for bbox in bboxes:
        if (
            bbox['latS'] <= lat <= bbox['latN']
            and bbox['lonW'] <= lon <= bbox['lonE']
        ):
            return True
    return False


# ─── Serialisation ────────────────────────────────────────────────────────────

class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


# ─── Handler ─────────────────────────────────────────────────────────────────

def handler(event, context):
    # Keep-warm ping from the EventBridge schedule — return immediately without
    # touching DynamoDB so the execution context stays alive at minimal cost.
    if event.get('warmup'):
        return {'statusCode': 200, 'body': 'warm'}

    table        = dynamodb.Table(os.environ['APRSPOSITIONSTABLE_TABLE_NAME'])
    config_table = dynamodb.Table(os.environ['CONFIGTABLE_TABLE_NAME'])
    max_age_hours = 6
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)

    # Use cached config (refreshed at most every 5 min)
    config = get_cached_config(config_table)
    scope_bboxes, has_scope_selection = build_scope_bboxes(config)

    # Optional: honour ?maxPositions=N query param to limit history array size.
    # Default 240 ≈ 2 hours of 30-second APRS beacons — covers the default trace window.
    params = (event.get('queryStringParameters') or {})
    try:
        max_positions = int(params.get('maxPositions', 240))
        max_positions = max(10, min(max_positions, 1440))  # clamp 10–1440
    except (TypeError, ValueError):
        max_positions = 240

    response = table.scan()
    items = response['Items']
    while 'LastEvaluatedKey' in response:
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        items.extend(response['Items'])

    filtered_items = []
    for item in items:
        last_seen = str(item.get('lastSeen', '') or '').strip()
        if not last_seen:
            continue
        try:
            last_seen_dt = datetime.fromisoformat(last_seen.replace('Z', '+00:00'))
            if last_seen_dt < cutoff:
                continue
        except Exception:
            continue

        if has_scope_selection and not scope_bboxes:
            # Fail closed: scope configured but bbox lookup failed → return nothing.
            continue

        if not is_item_in_scope(item, scope_bboxes):
            continue

        # Truncate position history to the most recent N entries to reduce payload size.
        # The positions list is stored oldest-first by the APRS listener.
        positions = item.get('positions')
        if isinstance(positions, list) and len(positions) > max_positions:
            item = dict(item)   # shallow copy so we don't mutate the DynamoDB item
            item['positions'] = positions[-max_positions:]

        filtered_items.append(item)

    return {
        'statusCode': 200,
        'headers': {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Headers': 'Authorization,Content-Type',
            'Content-Type':                 'application/json',
            # Allow CDN / browser to cache the response for up to 15 s.
            # The UI polls every 60 s so a 15 s cache prevents redundant requests
            # when the user navigates between the Map and Alerts pages.
            'Cache-Control': 'public, max-age=15',
        },
        'body': json.dumps(filtered_items, cls=DecimalEncoder),
    }
