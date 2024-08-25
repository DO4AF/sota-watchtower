import json
import requests
import re
import os

# Your bot token and user ID
bot_token = os.getenv('TELEGRAM_BOT_TOKEN')

def send_telegram(chat_id, text):
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
    except requests.RequestException as e:
        print(f"Error sending message to Telegram: {e}")
        print(response.text)

def handler(event, context):
    send_telegram(event["chat_id"], event["message"])