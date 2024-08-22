#!/bin/bash

# Install necessary packages
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y python3.12-venv

# Install the required Python packages
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Change ownership of the .venv directory to the 'ubuntu' user
sudo chown -R ubuntu:ubuntu .venv

# Set permissions to 777 for the .venv directory (very permissive, consider 755 or 775 instead)
sudo chmod -R 777 .venv

# Copy the systemd service file to the appropriate location
sudo cp aprs-listener.service /etc/systemd/system/

# Reload systemd to recognize the new service
sudo systemctl daemon-reload

# Enable and start the service
sudo systemctl enable aprs-listener.service
sudo systemctl start aprs-listener.service