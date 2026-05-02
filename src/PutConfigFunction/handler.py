import json
import boto3
import os

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Content-Type': 'application/json',
}

ALLOWED_KEYS = {
    'telegramBotToken',
    'telegramGroupId',
    'telegramUserId',
    'frequencyFilterPattern',
    'sotaAssociations',
    'sotaRegions',
    'activationZoneDistanceMeters',
    'activationZoneAltitudeDeltaMeters',
}


def parse_list(value):
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        if not value.strip():
            return []
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return [str(v).strip() for v in parsed if str(v).strip()]
        except Exception:
            return []
    return []


def parse_regions_map(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            return {}
    if not isinstance(value, dict):
        return {}

    result = {}
    for assoc, regions in value.items():
        assoc_key = str(assoc).strip()
        if not assoc_key:
            continue
        region_list = []
        if isinstance(regions, list):
            region_list = [str(r).strip() for r in regions if str(r).strip()]
        result[assoc_key] = set(region_list)
    return result


def handler(event, context):
    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return {
            'statusCode': 400,
            'headers': CORS_HEADERS,
            'body': json.dumps({'error': 'Invalid JSON'}),
        }

    dynamodb = boto3.resource('dynamodb')
    table = dynamodb.Table(os.environ['CONFIGTABLE_TABLE_NAME'])
    aprs_positions_table_name = os.environ.get('APRSPOSITIONSTABLE_TABLE_NAME', '')

    # Validate association/region selections against dynamic option catalog when present.
    selected_assocs = parse_list(body.get('sotaAssociations', [])) if 'sotaAssociations' in body else None
    selected_regions = parse_list(body.get('sotaRegions', [])) if 'sotaRegions' in body else None

    if selected_assocs is not None or selected_regions is not None:
        assoc_options_item = table.get_item(Key={'configKey': 'sotaAssociationOptions'}).get('Item', {})
        assoc_options = set(parse_list(assoc_options_item.get('configValue', '')))

        regions_map_item = table.get_item(Key={'configKey': 'sotaRegionsByAssociation'}).get('Item', {})
        regions_map = parse_regions_map(regions_map_item.get('configValue', {}))

        if selected_assocs is not None and assoc_options:
            invalid_assocs = [a for a in selected_assocs if a not in assoc_options]
            if invalid_assocs:
                return {
                    'statusCode': 400,
                    'headers': CORS_HEADERS,
                    'body': json.dumps({'error': f'Invalid associations: {invalid_assocs}'}),
                }
        if selected_assocs is not None and len(selected_assocs) == 0:
            return {
                'statusCode': 400,
                'headers': CORS_HEADERS,
                'body': json.dumps({'error': 'At least one association must be selected'}),
            }

        if selected_regions is not None and regions_map:
            invalid_regions = []
            for region_key in selected_regions:
                if '|' not in region_key:
                    invalid_regions.append(region_key)
                    continue
                assoc, region = region_key.split('|', 1)
                assoc = assoc.strip()
                region = region.strip()
                if not assoc or not region or region not in regions_map.get(assoc, set()):
                    invalid_regions.append(region_key)
                elif selected_assocs is not None and selected_assocs and assoc not in selected_assocs:
                    invalid_regions.append(region_key)

            if invalid_regions:
                return {
                    'statusCode': 400,
                    'headers': CORS_HEADERS,
                    'body': json.dumps({'error': f'Invalid regions: {invalid_regions}'}),
                }

    previous_assocs = parse_list(table.get_item(Key={'configKey': 'sotaAssociations'}).get('Item', {}).get('configValue', ''))
    previous_regions = parse_list(table.get_item(Key={'configKey': 'sotaRegions'}).get('Item', {}).get('configValue', ''))

    with table.batch_writer() as batch:
        for key, value in body.items():
            if key not in ALLOWED_KEYS:
                continue
            serialized = value if isinstance(value, str) else json.dumps(value)
            batch.put_item(Item={'configKey': key, 'configValue': serialized})

    # If scope changed, clear APRS positions so old broad-scope markers disappear immediately.
    scope_changed = False
    if selected_assocs is not None and selected_assocs != previous_assocs:
        scope_changed = True
    if selected_regions is not None and selected_regions != previous_regions:
        scope_changed = True

    if scope_changed and aprs_positions_table_name:
        aprs_table = dynamodb.Table(aprs_positions_table_name)
        scan_kwargs = {'ProjectionExpression': 'callsign'}
        deleted = 0
        with aprs_table.batch_writer() as batch:
            while True:
                response = aprs_table.scan(**scan_kwargs)
                for item in response.get('Items', []):
                    callsign = item.get('callsign')
                    if not callsign:
                        continue
                    batch.delete_item(Key={'callsign': callsign})
                    deleted += 1
                if 'LastEvaluatedKey' not in response:
                    break
                scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
        print(f"[INFO] Scope changed -> cleared APRS positions: {deleted} items")

    return {
        'statusCode': 200,
        'headers': CORS_HEADERS,
        'body': json.dumps({'message': 'Config saved'}),
    }
