"""
GetSummitsFunction — returns SOTA summits as GeoJSON FeatureCollection.

Data is read from SummitsTable (DynamoDB), which is populated daily by
RefreshSummitsFunction.  Returns only summits for the associations
configured in ConfigTable (key "config", field "sotaAssociations").

GET /summits
  ?associations=DL,OE,HB   (optional override; comma-separated)
"""

import json
import os

import boto3
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource('dynamodb')

CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Content-Type':                 'application/json',
}

# European associations served by default when config is unavailable
DEFAULT_ASSOCIATIONS = [
    'DL', 'OE', 'HB', 'HB0', 'F', 'I',
    'PA', 'ON', 'LX', '9A', 'OK', 'SP',
    'OM', 'HA', 'S5', 'YU', 'YO', 'LZ',
]


def _parse_json_list(raw: str) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [str(v).strip() for v in parsed if str(v).strip()]
    except Exception:
        pass
    return []


def get_associations_from_config() -> list[str]:
    """Read selected associations from ConfigTable.

    Order of precedence:
      1) explicit selected associations (sotaAssociations)
      2) dynamic options catalog (sotaAssociationOptions)
      3) hardcoded fallback list
    """
    table_name = os.environ.get('CONFIGTABLE_TABLE_NAME')
    if not table_name:
        return DEFAULT_ASSOCIATIONS

    try:
        table = dynamodb.Table(table_name)

        selected = table.get_item(Key={'configKey': 'sotaAssociations'}).get('Item', {})
        selected_values = _parse_json_list(str(selected.get('configValue', '') or ''))
        if selected_values:
            return selected_values

        options = table.get_item(Key={'configKey': 'sotaAssociationOptions'}).get('Item', {})
        option_values = _parse_json_list(str(options.get('configValue', '') or ''))
        if option_values:
            return option_values
    except Exception as e:
        print(f"ConfigTable read error: {e}")

    return DEFAULT_ASSOCIATIONS


def handler(event, context):
    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS_HEADERS, 'body': ''}

    # Association list: explicit param > config > hardcoded defaults
    params      = event.get('queryStringParameters') or {}
    assoc_param = params.get('associations')
    if assoc_param:
        associations = [a.strip() for a in assoc_param.split(',') if a.strip()]
    else:
        associations = get_associations_from_config()

    print(f"Querying associations: {associations}")

    summits_table = dynamodb.Table(os.environ['SUMMITS_TABLE_NAME'])
    features: list[dict] = []

    for assoc in associations:
        try:
            resp  = summits_table.query(
                IndexName='AssociationIndex',
                KeyConditionExpression=Key('association').eq(assoc),
            )
            items = resp.get('Items', [])

            # Paginate if needed (unlikely for a single association, but safe)
            while 'LastEvaluatedKey' in resp:
                resp  = summits_table.query(
                    IndexName='AssociationIndex',
                    KeyConditionExpression=Key('association').eq(assoc),
                    ExclusiveStartKey=resp['LastEvaluatedKey'],
                )
                items.extend(resp.get('Items', []))

            for item in items:
                try:
                    lat = float(item['latitude'])
                    lon = float(item['longitude'])
                except (KeyError, ValueError, TypeError):
                    continue

                features.append({
                    'type': 'Feature',
                    'geometry': {
                        'type':        'Point',
                        'coordinates': [lon, lat],
                    },
                    'properties': {
                        'summitCode':      item.get('summitCode', ''),
                        'peakName':        item.get('peakName', ''),
                        'elevationM':      int(item.get('elevationM', 0)),
                        'points':          int(item.get('points', 1)),
                        'associationName': item.get('associationName', ''),
                        'region':          item.get('region', ''),
                        'association':     item.get('association', ''),
                    },
                })

        except Exception as e:
            print(f"Error querying association {assoc}: {e}")

    print(f"Returning {len(features)} summits from {len(associations)} associations")

    return {
        'statusCode': 200,
        'headers':    CORS_HEADERS,
        'body':       json.dumps({'type': 'FeatureCollection', 'features': features}),
    }
