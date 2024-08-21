#!/bin/bash

# Install the required Python packages
pip3 install -r requirements.txt

# Copy the systemd service file to the appropriate location
sudo cp aprs-listener.service /etc/systemd/system/

# Reload systemd to recognize the new service
sudo systemctl daemon-reload

# Enable and start the service
sudo systemctl enable aprs-listener.service
sudo systemctl start aprs-listener.service