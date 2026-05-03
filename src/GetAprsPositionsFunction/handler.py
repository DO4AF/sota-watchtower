import json
import boto3
import os
import time
import math
from decimal import Decimal
from datetime import datetime, timedelta, timezone

dynamodb = boto3.resource('dynamodb')

# ─── Module-level config cache ────────────────────────────────────────────────
# Config values (selected associations, bounding boxes) almost never change.
# Caching in the Lambda execution context avoids 4 DynamoDB reads on every
# warm invocation, saving ~80 ms per request.
_CONFIG_CACHE: dict = {}
_CONFIG_CACHE_TIME: float = 0.0
_CONFIG_CACHE_TTL: float = 300.0   # 5 minutes

# ─── Module-level summit spatial index ────────────────────────────────────────
# The nearest-summit search (formerly O(N_aprs × 150K) on the frontend) is
# done here once per Lambda response.  We keep summits in a spatial grid so
# each per-activator search touches only ~9 grid cells (~50 candidates) rather
# than all 150K summits.
#
# Grid cell size: 0.1° ≈ 11 km at mid-latitudes.  A 3×3 neighbourhood of
# cells (±0.1°) covers a ~33 km search radius — well beyond the 2 km threshold.
_SUMMIT_GRID: dict = {}          # (lat_cell, lon_cell) → list[dict]
_SUMMIT_GRID_ASSOC_KEY: str = '' # sorted assoc string used when cache was built
_SUMMIT_GRID_TIME: float = 0.0
_SUMMIT_GRID_TTL: float = 1800.0  # 30 minutes

GRID_CELL_SIZE = 0.1   # degrees per grid cell
NEARBY_KM = 2.0        # summit proximity threshold sent to frontend

# ─── Haversine (pure Python, no external deps) ────────────────────────────────

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + (
        math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# ─── Summit spatial grid ──────────────────────────────────────────────────────

def _build_summit_grid(summits: list) -> dict:
    """Index summits into a dict keyed by (lat_cell, lon_cell) tuples."""
    grid: dict = {}
    for s in summits:
        cell = (int(s['lat'] / GRID_CELL_SIZE), int(s['lon'] / GRID_CELL_SIZE))
        grid.setdefault(cell, []).append(s)
    return grid


def _load_summits_for_associations(summits_table_name: str, associations: list) -> list:
    """Scan SummitsTable for all configured associations, return minimal dicts."""
    from boto3.dynamodb.conditions import Key as DdbKey
    table = dynamodb.Table(summits_table_name)
    summits = []
    for assoc in associations:
        try:
            resp = table.query(
                IndexName='AssociationIndex',
                KeyConditionExpression=DdbKey('association').eq(assoc),
                ProjectionExpression='summitCode, peakName, latitude, longitude',
            )
            items = resp.get('Items', [])
            while 'LastEvaluatedKey' in resp:
                resp = table.query(
                    IndexName='AssociationIndex',
                    KeyConditionExpression=DdbKey('association').eq(assoc),
                    ProjectionExpression='summitCode, peakName, latitude, longitude',
                    ExclusiveStartKey=resp['LastEvaluatedKey'],
                )
                items.extend(resp.get('Items', []))

            for item in items:
                try:
                    summits.append({
                        'code': str(item['summitCode']),
                        'name': str(item.get('peakName', '')),
                        'lat':  float(item['latitude']),
                        'lon':  float(item['longitude']),
                    })
                except (KeyError, ValueError, TypeError):
                    pass
        except Exception as e:
            print(f"[WARN] Could not load summits for association {assoc}: {e}")
    return summits


def get_summit_grid(config: dict) -> dict:
    """Return a cached spatial grid of summits, rebuilding when stale or associations change."""
    global _SUMMIT_GRID, _SUMMIT_GRID_TIME, _SUMMIT_GRID_ASSOC_KEY

    summits_table_name = os.environ.get('SUMMITS_TABLE_NAME', '')
    if not summits_table_name:
        return {}

    # Determine which associations to index
    selected = parse_json_list(config.get('sotaAssociations', ''))
    options  = parse_json_list(config.get('sotaAssociationOptions', ''))
    associations = selected if selected else options
    if not associations:
        return {}

    assoc_key = ','.join(sorted(associations))
    now = time.monotonic()

    # Return cached grid if still fresh and associations haven't changed
    if (
        _SUMMIT_GRID
        and assoc_key == _SUMMIT_GRID_ASSOC_KEY
        and (now - _SUMMIT_GRID_TIME) < _SUMMIT_GRID_TTL
    ):
        return _SUMMIT_GRID

    # (Re)build the grid
    print(f"[INFO] Building summit spatial grid for associations: {associations}")
    summits = _load_summits_for_associations(summits_table_name, associations)
    _SUMMIT_GRID = _build_summit_grid(summits)
    _SUMMIT_GRID_ASSOC_KEY = assoc_key
    _SUMMIT_GRID_TIME = now
    total = sum(len(v) for v in _SUMMIT_GRID.values())
    print(f"[INFO] Summit grid built: {total} summits across {len(_SUMMIT_GRID)} cells")
    return _SUMMIT_GRID


def find_nearest_summit(lat: float, lon: float, grid: dict):
    """Return (summit_dict, distance_km) for the nearest summit within NEARBY_KM, or (None, None)."""
    if not grid:
        return None, None

    cell_lat = int(lat / GRID_CELL_SIZE)
    cell_lon = int(lon / GRID_CELL_SIZE)

    nearest = None
    nearest_km = float('inf')

    for dlat in (-1, 0, 1):
        for dlon in (-1, 0, 1):
            candidates = grid.get((cell_lat + dlat, cell_lon + dlon), [])
            for s in candidates:
                km = haversine_km(lat, lon, s['lat'], s['lon'])
                if km < nearest_km:
                    nearest_km = km
                    nearest = s

    if nearest is not None and nearest_km <= NEARBY_KM:
        return nearest, round(nearest_km, 4)
    return None, None


# ─── Config cache ─────────────────────────────────────────────────────────────

def _read_config_item(table, key: str) -> str:
    try:
        item = table.get_item(Key={'configKey': key}).get('Item', {})
        return item.get('configValue', '')
    except Exception:
        return ''


def _load_config(config_table) -> dict:
    keys = [
        'sotaAssociations',
        'sotaRegions',
        'sotaAssociationOptions',
        'sotaAprsAreaByAssociation',
        'sotaAprsAreaByRegion',
    ]
    return {k: _read_config_item(config_table, k) for k in keys}


def get_cached_config(config_table) -> dict:
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
    # Keep-warm ping — return immediately without touching DynamoDB.
    if event.get('warmup'):
        return {'statusCode': 200, 'body': 'warm'}

    table        = dynamodb.Table(os.environ['APRSPOSITIONSTABLE_TABLE_NAME'])
    config_table = dynamodb.Table(os.environ['CONFIGTABLE_TABLE_NAME'])
    max_age_hours = 6
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)

    # Cached config (refreshed at most every 5 min)
    config = get_cached_config(config_table)
    scope_bboxes, has_scope_selection = build_scope_bboxes(config)

    # Cached summit spatial grid (refreshed at most every 30 min)
    summit_grid = get_summit_grid(config)

    # Optional ?maxPositions=N — limit trace history size in the response.
    # Default 240 ≈ 2 hours of 30-second APRS beacons.
    params = (event.get('queryStringParameters') or {})
    try:
        max_positions = int(params.get('maxPositions', 240))
        max_positions = max(10, min(max_positions, 1440))
    except (TypeError, ValueError):
        max_positions = 240

    # Full table scan (APRS positions table is small — typically <200 items)
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
            continue  # fail closed

        if not is_item_in_scope(item, scope_bboxes):
            continue

        # Truncate position history to keep payload small
        positions = item.get('positions')
        if isinstance(positions, list) and len(positions) > max_positions:
            item = dict(item)
            item['positions'] = positions[-max_positions:]

        # ── Nearest-summit enrichment ─────────────────────────────────────
        # Compute once here (O(~50) haversines via spatial grid) so the
        # frontend never needs to iterate 150K summits for candidate detection.
        try:
            act_lat = float(item.get('latitude'))
            act_lon = float(item.get('longitude'))
            if not (math.isnan(act_lat) or math.isnan(act_lon)):
                summit, dist_km = find_nearest_summit(act_lat, act_lon, summit_grid)
                if summit is not None:
                    # Shallow-copy only if not already copied above
                    if not isinstance(item, dict) or 'positions' not in item or positions is item.get('positions'):
                        item = dict(item)
                    item['nearestSummitCode']      = summit['code']
                    item['nearestSummitName']      = summit['name']
                    item['nearestSummitDistanceKm'] = dist_km
        except Exception as e:
            print(f"[WARN] Nearest-summit lookup failed for {item.get('callsign')}: {e}")

        filtered_items.append(item)

    return {
        'statusCode': 200,
        'headers': {
            'Access-Control-Allow-Origin':  '*',
            'Access-Control-Allow-Headers': 'Authorization,Content-Type',
            'Content-Type':                 'application/json',
            'Cache-Control':                'public, max-age=15',
        },
        'body': json.dumps(filtered_items, cls=DecimalEncoder),
    }
