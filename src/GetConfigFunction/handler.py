import json
import boto3
import os
from decimal import Decimal
from collections import defaultdict

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Content-Type': 'application/json',
}


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def _scan_summit_scope_options(table):
    """Build dynamic association/region options from SummitsTable.

    Used as a fallback when cached option keys are not yet present in ConfigTable.
    """
    associations = set()
    regions_by_association = defaultdict(set)

    scan_kwargs = {
        'ProjectionExpression': '#a, #r',
        'ExpressionAttributeNames': {
            '#a': 'association',
            '#r': 'region',
        },
    }

    while True:
        response = table.scan(**scan_kwargs)
        for item in response.get('Items', []):
            association = str(item.get('association', '') or '').strip()
            region = str(item.get('region', '') or '').strip()
            if not association:
                continue
            associations.add(association)
            if region:
                regions_by_association[association].add(region)

        if 'LastEvaluatedKey' not in response:
            break
        scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']

    association_options = sorted(associations)
    regions_map = {
        assoc: sorted(list(regions_by_association.get(assoc, set())))
        for assoc in association_options
    }

    # Derive APRS area boxes as simple bboxes from summit points
    def make_bbox():
        return {'minLat': 90.0, 'maxLat': -90.0, 'minLon': 180.0, 'maxLon': -180.0}

    def update_bbox(bbox, lat, lon):
        bbox['minLat'] = min(bbox['minLat'], lat)
        bbox['maxLat'] = max(bbox['maxLat'], lat)
        bbox['minLon'] = min(bbox['minLon'], lon)
        bbox['maxLon'] = max(bbox['maxLon'], lon)

    def to_aprs_area(bbox):
        return {
            'latN': round(bbox['maxLat'], 4),
            'lonW': round(bbox['minLon'], 4),
            'latS': round(bbox['minLat'], 4),
            'lonE': round(bbox['maxLon'], 4),
        }

    bbox_by_association = defaultdict(make_bbox)
    bbox_by_region = defaultdict(make_bbox)

    bbox_scan_kwargs = {
        'ProjectionExpression': '#a, #r, #lat, #lon',
        'ExpressionAttributeNames': {
            '#a': 'association',
            '#r': 'region',
            '#lat': 'latitude',
            '#lon': 'longitude',
        },
    }

    while True:
        response = table.scan(**bbox_scan_kwargs)
        for item in response.get('Items', []):
            association = str(item.get('association', '') or '').strip()
            region = str(item.get('region', '') or '').strip()
            if not association:
                continue
            try:
                lat = float(item.get('latitude'))
                lon = float(item.get('longitude'))
            except Exception:
                continue
            update_bbox(bbox_by_association[association], lat, lon)
            if region:
                update_bbox(bbox_by_region[f"{association}|{region}"], lat, lon)

        if 'LastEvaluatedKey' not in response:
            break
        bbox_scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']

    aprs_area_by_association = {
        assoc: to_aprs_area(bbox)
        for assoc, bbox in sorted(bbox_by_association.items())
    }
    aprs_area_by_region = {
        region_key: to_aprs_area(bbox)
        for region_key, bbox in sorted(bbox_by_region.items())
    }

    return association_options, regions_map, aprs_area_by_association, aprs_area_by_region


def handler(event, context):
    dynamodb = boto3.resource('dynamodb')
    config_table = dynamodb.Table(os.environ['CONFIGTABLE_TABLE_NAME'])

    items = []
    scan_kwargs = {}
    while True:
        response = config_table.scan(**scan_kwargs)
        items.extend(response['Items'])
        if 'LastEvaluatedKey' not in response:
            break
        scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']

    config = {item['configKey']: item['configValue'] for item in items}

    # Fallback for first-run scenarios before RefreshSummits has cached option keys.
    if (
        'sotaAssociationOptions' not in config
        or 'sotaRegionsByAssociation' not in config
        or 'sotaAprsAreaByAssociation' not in config
        or 'sotaAprsAreaByRegion' not in config
    ):
        summits_table_name = os.environ.get('SUMMITS_TABLE_NAME')
        if summits_table_name:
            try:
                summits_table = dynamodb.Table(summits_table_name)
                (
                    assoc_options,
                    regions_map,
                    aprs_area_by_association,
                    aprs_area_by_region,
                ) = _scan_summit_scope_options(summits_table)

                generated = {}
                if 'sotaAssociationOptions' not in config:
                    generated['sotaAssociationOptions'] = json.dumps(assoc_options)
                if 'sotaRegionsByAssociation' not in config:
                    generated['sotaRegionsByAssociation'] = json.dumps(regions_map)
                if 'sotaAprsAreaByAssociation' not in config:
                    generated['sotaAprsAreaByAssociation'] = json.dumps(aprs_area_by_association)
                if 'sotaAprsAreaByRegion' not in config:
                    generated['sotaAprsAreaByRegion'] = json.dumps(aprs_area_by_region)

                # Persist generated fallback values to avoid repeated expensive scans.
                for key, value in generated.items():
                    config_table.put_item(Item={'configKey': key, 'configValue': value})
                    config[key] = value
            except Exception as exc:
                print(f"[WARNING] Failed to derive dynamic scope options from SummitsTable: {exc}")

    return {
        'statusCode': 200,
        'headers': CORS_HEADERS,
        'body': json.dumps(config, cls=DecimalEncoder),
    }
