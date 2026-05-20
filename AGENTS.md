# Project Metadata

Title: SOTA Watchtower
Description: Real-time APRS-driven SOTA activator monitoring and automatic summit-zone detection. Functional POC that integrates APRS telemetry with SOTA data.
Intent: Experiment – validate an APRS-first detection workflow for SOTA activations.
Stack: AWS SAM, Angular 19, Lambda, API Gateway, DynamoDB, Telegram Bot API
Status: proof-of-concept | last update 2024

## Architecture
- APRS-IS ingestion → geo-filtered processing → proximity check against SOTA summit zones
- Web dashboard (Angular) + Telegram notifications
- AWS SAM serverless deployment

## Disclaimer
This is a proof of concept, not a replacement for SOTLAS.
