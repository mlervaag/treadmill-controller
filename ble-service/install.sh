#!/usr/bin/env bash
# install.sh — Set up the Treadmill BLE Service on a Raspberry Pi / Linux host
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="treadmill-ble"
SERVICE_FILE="${SCRIPT_DIR}/treadmill-ble.service"

echo "=== Treadmill BLE Service Installer ==="

# 1. Install system dependencies
echo ""
echo "--- Installing apt dependencies ---"
sudo apt-get update
sudo apt-get install -y bluetooth bluez libbluetooth-dev libudev-dev build-essential

# 2. Install Node.js dependencies
echo ""
echo "--- Installing npm packages ---"
cd "${SCRIPT_DIR}"
npm install --production

# 3. Enable bluetooth systemd service
echo ""
echo "--- Enabling bluetooth service ---"
sudo systemctl enable bluetooth
sudo systemctl start bluetooth

# 4. Copy and enable the systemd unit
echo ""
echo "--- Installing systemd service ---"
sudo cp "${SERVICE_FILE}" /etc/systemd/system/${SERVICE_NAME}.service
sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}.service

echo ""
echo "=== Installation complete ==="
echo ""
echo "Edit ble-config.json to set your server URL if needed."
echo ""
echo "Commands:"
echo "  sudo systemctl start ${SERVICE_NAME}    # Start the service"
echo "  sudo systemctl stop ${SERVICE_NAME}     # Stop the service"
echo "  sudo systemctl status ${SERVICE_NAME}   # Check status"
echo "  journalctl -u ${SERVICE_NAME} -f        # Follow logs"
