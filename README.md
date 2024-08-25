# SOTA Watchtower

SOTA Watchtower is a project designed to monitor SOTA activities and send notifications via Telegram. It uses AWS Lambda functions to process events and send messages to a specified Telegram chat.

## Features

### Spot forwarding
Reception of SOTA Spots from HamAlert and forward to Telegram chat

### Daily Morning Briefing
Daily summary of upcoming planned activations (Alerts)

### Activation Zone Monitoring (APRS)
Receive notifications when an Activator reaches the summit area (based on APRS data)

## Data sources
- HamAlert
- SOTA API
- APRS-IS

## AWS Resources

### Networking
![api](doc/api.png) HamAlertApi - *API Gateway Endpoint for HamAlert Spots*

### Compute
![ec2](doc/ec2.png) AprsMonitorInstance - *Reception of APRS-IS data*

![lambda](doc/lambda.png) ActivationZoneMonitorFunction - *Processing of APRS data and trigger of notifications*

![lambda](doc/lambda.png) DailyBriefingFunction - *Generation of daily morning briefing based on available Alerts*

![lambda](doc/lambda.png) GetSotaAlertsFunction - *Get SOTA Alerts from SOTA API*

![lambda](doc/lambda.png) GetSotaSpotsFunction - *Get SOTA Spots from SOTA API*

![lambda](doc/lambda.png) HamAlertProcessFunction - *Forwarding of HamAlert Spots to TelegramNotifyFunction*

![lambda](doc/lambda.png) TelegramNotifyFunction - *Generic function to send Telegram messages*

### Cloudwatch
![event-time](doc/event-time.png) DailyBriefingEvent - *Event to trigger the daily morning briefing*

![logs](doc/logs.png) SotaWatchtowerMasterLogGroup - *Central loggroup for all Logs*

![alarm](doc/alarm.png) AprsMonitorAlarm - *Alarm to monitor health of APRS data stream*

Additionaly there is a CloudWatch Dashboard showing details of the application

## Getting Started

To get started with SOTA Watchtower, follow the steps below to set up the project locally and deploy it to your AWS account.

## Prerequisites

- Python 3.12 or higher
- AWS CLI configured with your credentials
- AWS SAM CLI installed
- A HamAlert account
- An AWS account
- A Telegram bot token and user or group ID

## Installation

1. **Clone the repository:**
	```bash
	git clone https://gitlab.com/afruechtl/sota-watchtower.git
	cd sota-watchtower
	```
2. **Configure Triggers in HamAlert**

	Triggers need to follow a specific naming convention in order to be processed by SOTA Watchtower
	
	The required keyword is

	> SOTA2TELEGRAM

	Configure one or more triggers in HamAlert under configuration option **Triggers**
	
	Make sure to include the keyword *SOTA2TELEGRAM* in each trigger comment field for triggers you want to be recognized by SOTA Watchtower

	Example trigger comment:
	> SOTA2TELEGRAM_VHFUHF_DM-South

3. **Configure parameters in `samconfig.toml`**
	
	TelegramUserChatId is optional if you want to receive your own spots also via Telegram.

	FrequencyFilterPattern is a regex to filter out alerts of interest based on frequency or mode. This is applied on the frequencies field in the alert from SOTAwatch.

	Make sure your bot is added to the Telegram group chat associated with the ID provided in TelegramGroupChatId.
	```
	parameter_overrides =[
	"TelegramBotToken=<YOUR_TOKEN>",
	"TelegramUserChatId=<YOUR_CHAT_ID>",
	"TelegramGroupChatId=<YOUR_CHAT_ID>",
	"FrequencyFilterPattern=\\b(145|433|2|70).*-.*\\b"
	]
	```

4. **Build the AWS SAM template:**
	```bash
	sam build
	```

5. **Deploy the AWS SAM template:**
	```bash
	sam deploy
	```

6. **Configure API Endpoint in HamAlert**
	
	Copy the Invoke URL from API Gateway, which is shown at the end of the deploy process
	```
	Key                 ApiGatewayInvokeUrl
	Description         URL to enter into HamAlert Destination
	Value               https://abcdefghijk.execute-api.eu-central-1.amazonaws.com/Prod/notify

	Key                 DashboardUrl                                                                                                                 
	Description         URLtotheCloudWatchDashboard
	Value               https://eu-central-1.console.aws.amazon.com/cloudwatch/home?region=eu-central-1#dashboards/dashboard/SOTA-Watchtower-Dashboard
	```

	Insert the URL from above output into [HamAlert](https://hamalert.org/destinations) under configuration option **Destinations -> URL notifications**

	Example URL:

	> https://abcdefghijk.execute-api.eu-central-1.amazonaws.com/Prod/notify

## Usage
- Check your Dashboard at the provided link [SOTA Watchtower Dashboard](https://eu-central-1.console.aws.amazon.com/cloudwatch/home?region=eu-central-1#dashboards/dashboard/SOTA-Watchtower-Dashboard)
- Observe your Telegram chat group for incoming messages
- Test the notification functionality by sending a test spot from HamAlert under configuration option **Simulate** and make sure the keyword *SOTA2TELEGRAM* is entered in the Comment field
- Try the Activation Zone Monitoring feature by entering an Alert prior to your next activation. Carry your APRS Tracker/Radio with you and you should receive a notification as soon as you are near the summit.
 
## File Structure

- `template.yaml`: AWS SAM template defining the Lambda functions and API Gateway.
- `samconfig.toml`: Basic AWS SAM stack configuration and user defined parameters
- `src`: Folder containing all Lambda functions and layers
- `ec2/aprs-listener`: Init code and python script for APRS data reception

## Contributing

If you would like to contribute to this project, please follow these steps:

1. Fork the repository.
2. Create a new branch (`git checkout -b feature-branch`).
3. Make your changes and commit them (`git commit -m 'Add some feature'`).
4. Push to the branch (`git push origin feature-branch`).
5. Create a new Pull Request.
