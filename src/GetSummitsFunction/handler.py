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


def get_associations_from_config() -> list[str]:
    """Read sotaAssociations from ConfigTable; fall back to DEFAULT_ASSOCIATIONS."""
    table_name = os.environ.get('CONFIGTABLE_TABLE_NAME')
    if not table_name:
        return DEFAULT_ASSOCIATIONS
    try:
        table = dynamodb.Table(table_name)
        resp  = table.get_item(Key={'configKey': 'config'})
        item  = resp.get('Item', {})
        raw   = item.get('sotaAssociations', '').strip()
        if raw:
            return [a.strip() for a in raw.split(',') if a.strip()]
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
