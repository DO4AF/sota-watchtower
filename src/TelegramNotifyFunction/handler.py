import json
import requests
import re
import os
import boto3

dynamodb = boto3.resource('dynamodb')

def get_bot_token():
    """Read Telegram bot token from DynamoDB ConfigTable at runtime.
    Falls back to TELEGRAM_BOT_TOKEN env var for backwards compatibility."""
    table_name = os.environ.get('CONFIGTABLE_TABLE_NAME')
    if table_name:
        try:
            table = dynamodb.Table(table_name)
            response = table.get_item(Key={'configKey': 'telegramBotToken'})
            token = response.get('Item', {}).get('configValue', '')
            if token:
                return token
        except Exception as e:
            print(f"[WARNING] Could not read bot token from DynamoDB: {e}")
    # Fallback to deploy-time env var
    return os.getenv('TELEGRAM_BOT_TOKEN', '')

def send_telegram(chat_id, text):
    bot_token = get_bot_token()
    if not bot_token:
        print(f"[ERROR] No Telegram bot token available — cannot send message")
        return

    url = f'https://api.telegram.org/bot{bot_token}/sendMessage'
    payload = {
        'chat_id': chat_id,
        'text': text,
        'parse_mode': 'HTML',
        'link_preview_options': {
            'is_disabled': True
        }
    }

    try:
        response = requests.post(url, json=payload)
        response.raise_for_status()
        print(f"[INFO] Telegram message sent to chat_id={chat_id!r}")
    except requests.RequestException as e:
        print(f"[ERROR] Error sending message to Telegram: {e}")
        try:
            print(response.text)
        except Exception:
            pass

def handler(event, context):
    send_telegram(event["chat_id"], event["message"])
