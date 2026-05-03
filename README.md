# SOTA Watchtower

> Real-time APRS-driven SOTA activator monitoring and automatic summit-zone detection.

![Status](https://img.shields.io/badge/status-functional%20POC-orange)
![License](https://img.shields.io/badge/license-GPL--3.0-blue)
![Stack](https://img.shields.io/badge/stack-AWS%20SAM%20%7C%20Angular%2019-informational)

---

## Overview

SOTA Watchtower is a **functional proof of concept (POC)** for integrating APRS telemetry with SOTA activity data to automatically identify likely summit activations in near real time.

The project ingests APRS positions from APRS-IS, correlates them with configured SOTA scope and active alerts, and publishes operator-relevant outputs through a web dashboard and Telegram notifications.

Its primary value is exploring and validating an **APRS-first detection workflow** for SOTA activators, including geo-filtered ingestion, proximity checks, and automated event signaling.

---

## Important Disclaimer

> **This project is a proof of concept and is not a replacement for SOTLAS.**
>
> SOTLAS (`manuelkasper/sotlas-frontend`) is an established, mature reference implementation in the SOTA ecosystem.
>
> SOTA Watchtower has a different objective: it focuses on **experimental APRS integration and automatic activator detection workflows**. It should be viewed as a complementary exploration that can coexist with existing SOTA tools and infrastructure.

- SOTLAS remains the canonical user-facing reference for broad SOTA map/spot experience.
- SOTA Watchtower concentrates on APRS ingestion, detection logic, and alerting behavior.
- Design choices here prioritize experimentation and iteration in APRS-driven automation.

---

## Background Context

### SOTA (Summits on the Air)

SOTA is a global amateur radio award program where licensed operators activate qualifying mountain summits and make contacts.

- **Activators** operate portable radio stations from summits.
- **Chasers** attempt to contact activators from other locations.
- Points are awarded based on summit characteristics under SOTA program rules.
- The program has grown internationally across many associations and regions.

Official references:
- https://www.sota.org.uk/
- https://de.wikipedia.org/wiki/Summits_on_the_Air

### APRS (Automatic Packet Reporting System)

APRS is a digital amateur radio data network used to transmit position and telemetry information.

In this project, APRS enables near real-time location updates from operators carrying APRS-capable devices (handheld radios, trackers, mobile stations), creating the data foundation for automated summit proximity detection.

### Why APRS + SOTA Together

When activators transmit APRS while moving toward or operating from summits, their position stream can be correlated with summit metadata and planned activations.

That correlation enables automated workflows such as:
- detecting probable arrival in activation zones,
- prioritizing relevant activators,
- notifying teams/chats without manual map watching.

---

## Use Cases and Objectives

- **Activation zone awareness**: detect when a tracked operator enters a configurable summit vicinity.
- **Operational support**: send Telegram notifications for key events (alerts, spots, summit-zone detection).
- **Situational map view**: display APRS walkers, summit context, and tactical relevance in one UI.
- **Scope control**: monitor selected SOTA associations/regions instead of broad global feeds.
- **Research and iteration**: test detection heuristics, correlation strategies, and filtering models.

---

## Key Features

- **APRS-IS Integration**
  - EC2 listener connects to APRS-IS (`rotate.aprs.net:14580`).
  - Applies dynamic APRS area filters (`a/...`) and position-only constraints (`t/p`).
  - Uses lightweight deduplication to reduce noisy near-identical packets.

- **Automatic Activator Detection**
  - Correlates APRS callsigns with active SOTA alerts.
  - Performs summit-zone checks using distance and altitude thresholds.
  - Supports SSID-insensitive matching for improved APRS/alert correlation.
  - Avoids duplicate notification spam by tracking already-notified states.

- **Web Dashboard**
  - Angular 19 frontend with map, alerts, spots, tactical view, and config UI.
  - Real-time position visibility and summit metadata enrichment.
  - Configurable monitoring scope and runtime behavior.

- **Telegram Notification Pipeline**
  - Sends HamAlert-forwarded events and auto-detection signals.
  - Includes daily briefing support for planned activations.

- **Cloud-Native AWS Deployment**
  - AWS SAM backend (Lambda, API Gateway, DynamoDB, EventBridge).
  - Cognito-protected UI/API sections.
  - CloudWatch logging/monitoring coverage.

---

## Technical Architecture

### High-Level Data Flow

```text
APRS-IS Network
   |
   v
EC2 APRS Listener (aprslib)
   |  dynamic filter + packet screening
   v
ActivationZoneMonitorFunction
   |-- store positions -> AprsPositionsTable
   |-- correlate callsigns with active SOTA alerts
   |-- geofence checks (distance + altitude)
   `-- notify -> TelegramNotifyFunction

HamAlert Webhook -> HamAlertApi -> HamAlertProcessFunction -> SotaAlertsTable -> Telegram

SOTA API (alerts/spots/summits refresh) -> scheduled Lambdas -> DynamoDB

Web App (Angular)
   |-- GET /aprs-positions
   |-- GET /alerts
   |-- GET /spots
   |-- GET /summits
   `-- GET/PUT /config
```

### Core Components

| Layer | Component | Purpose |
|---|---|---|
| APRS ingest | EC2 `aprs-listener.py` | APRS-IS connection, filter refresh, packet pre-processing |
| Detection | `ActivationZoneMonitorFunction` | Position persistence + summit-zone detection + signaling |
| Alert ingest | `HamAlertProcessFunction` | HamAlert webhook processing and Telegram forwarding |
| Data/API | Multiple Lambda endpoints | Alerts, spots, summits, APRS positions, runtime config |
| Storage | DynamoDB tables | Positions, alerts, config, websocket sessions, summit metadata |
| Frontend | Angular 19 app (`web/`) | Map, alerts/spots views, tactical workflows, configuration |
| Notifications | `TelegramNotifyFunction` | Outbound Telegram messaging |

### APRS Processing and Detection Strategy

1. APRS listener receives position packets under configured geographic scope.
2. Candidate packets are filtered and deduplicated.
3. Position updates are forwarded to the activation monitor Lambda.
4. Lambda stores positions with TTL and evaluates active alerts.
5. Callsign normalization + summit proximity checks estimate activation likelihood.
6. On threshold pass, event is emitted via Telegram and reflected in UI state.

### Confidence Model (Practical Heuristics)

Detection confidence is derived from multiple converging signals rather than a single point test:

- **Spatial proximity**: distance to target summit within configured radius.
- **Vertical plausibility**: altitude relationship to summit altitude within configurable delta.
- **Identity correlation**: APRS callsign and alert callsign normalization (SSID-insensitive).
- **Temporal relevance**: active/current alert windows and fresh APRS updates.

This is intentionally heuristic and operational, not a formal probabilistic classifier.

---

## Installation and Setup

### Prerequisites

- Python 3.12+
- AWS CLI configured for target account/region
- AWS SAM CLI
- Node.js 18+ (for frontend builds)
- HamAlert account
- Telegram bot token + target chat IDs

### 1) Clone Repository

```bash
git clone https://github.com/DO4AF/sota-watchtower.git
cd sota-watchtower
```

### 2) Configure Environment Values

Create local environment file from example:

```bash
cp .env.example .env
```

Populate required values in `.env` (never commit secrets):

```dotenv
TELEGRAM_BOT_TOKEN=<your_telegram_bot_token>
TELEGRAM_USER_CHAT_ID=<your_personal_chat_id>
TELEGRAM_GROUP_CHAT_ID=<your_group_chat_id>
FREQUENCY_FILTER_PATTERN='\b(145|433|2|70).*-.*\b'
ADMIN_EMAIL=<admin_email>
ADMIN_PASSWORD=<admin_password>
```

### 3) Configure SAM Parameters

Set parameter overrides in `samconfig.toml` according to your environment:

- `TelegramBotToken`
- `TelegramUserChatId`
- `TelegramGroupChatId`
- `FrequencyFilterPattern`
- admin credentials parameters

### 4) Build and Deploy

```bash
sam build
sam deploy
```

Alternatively, use the project helper:

```bash
./deploy.sh
```

### 5) Configure HamAlert Integration

- Add webhook destination URL (`POST /notify`) from stack outputs.
- Use trigger comment keyword format containing `SOTA2TELEGRAM`.

Example trigger comment:

```text
SOTA2TELEGRAM_VHFUHF_DM-South
```

---

## Usage Guide

### Common Workflow

1. Open the web UI and authenticate.
2. Configure scope (`sotaAssociations`, optional `sotaRegions`) in the Config view.
3. Verify APRS positions are arriving in the map.
4. Monitor alerts/spots tables and tactical map overlays.
5. Observe Telegram for forwarded spots and activation-zone notifications.

### Typical Operations

- **Map view**: inspect walkers, summit overlays, and tactical relationships.
- **Alerts/Spots view**: review normalized and summit-enriched event data.
- **Config view**: adjust runtime behavior without full redeploy for supported keys.

### Validation Tips

- Use HamAlert simulate/test tools for webhook verification.
- Confirm APRS packets in CloudWatch logs for the listener and monitor functions.
- Ensure selected SOTA scope matches your intended operating region.

---

## Project Status

- **Current stage**: Functional proof of concept with live operational deployment.
- **Maturity**: Experimental system suitable for iterative development and focused operational use.
- **Scope**: APRS-centric activator detection and alerting, not full ecosystem replacement tooling.

### Known Limitations

- Detection logic is heuristic; false positives/negatives remain possible.
- APRS data quality and coverage depend on external network conditions and device behavior.
- Configuration and infrastructure are optimized for this project context, not generic turnkey multi-tenant operation.
- Ecosystem dependencies (SOTA API, HamAlert, APRS-IS, Telegram API) can affect behavior.

---

## Roadmap

- Harden detection scoring and add richer confidence metadata.
- Improve APRS scope guardrails and fallback safety behavior.
- Expand observability (structured metrics, trend dashboards, anomaly alerts).
- Add more explicit correlation diagnostics in UI for operator trust.
- Improve test coverage for normalization, geofencing, and filtering paths.
- Evaluate broader interoperability hooks with existing SOTA ecosystem tools.

---

## Contributing

Contributions are welcome, especially around APRS filtering, detection quality, UI clarity, and reliability.

1. Fork the repository.
2. Create a branch (`git checkout -b feature/your-change`).
3. Implement and validate changes.
4. Open a pull request with clear context and test notes.

Recommended validation before PR:

```bash
cd web && npx ng build --configuration production
```

---

## License

This project is licensed under the **GNU General Public License v3.0**.

See `LICENSE` for full terms.

---

## References and Resources

### SOTA
- Official SOTA site: https://www.sota.org.uk/
- SOTA overview (DE): https://de.wikipedia.org/wiki/Summits_on_the_Air
- SOTAWatch: https://sotawatch.sota.org.uk/

### APRS and Related Infrastructure
- APRS-IS network overview: http://www.aprs-is.net/
- APRS Foundation: https://www.aprs.org/

### Related Projects and Services
- SOTLAS frontend (reference project): https://github.com/manuelkasper/sotlas-frontend
- HamAlert: https://hamalert.org/

---

## Acknowledgments

- The international **SOTA community** for operating practices, summit data, and shared knowledge.
- **SOTLAS** and maintainers for providing a strong ecosystem reference point.
- **HamAlert** for alerting infrastructure used in this workflow.
- **APRS-IS operators and volunteers** for sustaining packet routing infrastructure.

---

**SOTA Watchtower is intentionally focused on APRS-driven detection experimentation.**
It complements existing SOTA tooling by exploring automated activator-awareness workflows built from live packet telemetry.
