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
    return association_options, regions_map


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
    if 'sotaAssociationOptions' not in config or 'sotaRegionsByAssociation' not in config:
        summits_table_name = os.environ.get('SUMMITS_TABLE_NAME')
        if summits_table_name:
            try:
                summits_table = dynamodb.Table(summits_table_name)
                assoc_options, regions_map = _scan_summit_scope_options(summits_table)
                if 'sotaAssociationOptions' not in config:
                    config['sotaAssociationOptions'] = json.dumps(assoc_options)
                if 'sotaRegionsByAssociation' not in config:
                    config['sotaRegionsByAssociation'] = json.dumps(regions_map)
            except Exception as exc:
                print(f"[WARNING] Failed to derive dynamic scope options from SummitsTable: {exc}")

    return {
        'statusCode': 200,
        'headers': CORS_HEADERS,
        'body': json.dumps(config, cls=DecimalEncoder),
    }
