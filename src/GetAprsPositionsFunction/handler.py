import json
import boto3
import os
from decimal import Decimal
from datetime import datetime, timedelta, timezone

dynamodb = boto3.resource('dynamodb')


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

    top = max(lat_n, lat_s)
    bottom = min(lat_n, lat_s)
    left = min(lon_w, lon_e)
    right = max(lon_w, lon_e)
    return {
        'latN': top,
        'latS': bottom,
        'lonW': left,
        'lonE': right,
    }


def read_config_item(table, key):
    try:
        item = table.get_item(Key={'configKey': key}).get('Item', {})
        return item.get('configValue', '')
    except Exception:
        return ''


def build_scope_bboxes(config_table):
    selected_associations = parse_json_list(read_config_item(config_table, 'sotaAssociations'))
    selected_regions = parse_json_list(read_config_item(config_table, 'sotaRegions'))
    association_options = parse_json_list(read_config_item(config_table, 'sotaAssociationOptions'))
    area_by_association = parse_json_dict(read_config_item(config_table, 'sotaAprsAreaByAssociation'))
    area_by_region = parse_json_dict(read_config_item(config_table, 'sotaAprsAreaByRegion'))

    has_scope_selection = bool(selected_associations or selected_regions)
    associations_to_use = selected_associations if selected_associations else association_options

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


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def handler(event, context):
    table = dynamodb.Table(os.environ['APRSPOSITIONSTABLE_TABLE_NAME'])
    config_table = dynamodb.Table(os.environ['CONFIGTABLE_TABLE_NAME'])
    max_age_hours = 6
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
    scope_bboxes, has_scope_selection = build_scope_bboxes(config_table)

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
            # Fail closed: when scope is configured but bbox lookup failed,
            # return no APRS items instead of leaking global data.
            continue

        if not is_item_in_scope(item, scope_bboxes):
            continue

        filtered_items.append(item)

    return {
        'statusCode': 200,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization,Content-Type',
            'Content-Type': 'application/json',
        },
        'body': json.dumps(filtered_items, cls=DecimalEncoder),
    }
