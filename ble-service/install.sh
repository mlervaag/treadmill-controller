#!/bin/bash
set -e

echo "=== Treadmill BLE Service Installer ==="

# Ensure bluetooth and D-Bus packages are installed
echo "Installing system packages..."
sudo apt-get update
sudo apt-get install -y bluetooth bluez

# Install npm dependencies (no native bindings needed)
echo "Installing npm dependencies..."
cd "$(dirname "$0")"
npm install --production

# Install D-Bus permissions for node-ble
echo "Installing D-Bus config..."
sudo cp dbus-node-ble.conf /etc/dbus-1/system.d/node-ble.conf
sudo systemctl reload dbus

# Ensure bluetooth service is running (node-ble uses BlueZ via D-Bus)
sudo systemctl enable bluetooth
sudo systemctl start bluetooth

# Add pi user to bluetooth group
sudo usermod -aG bluetooth pi

# Install systemd service
echo "Installing systemd service..."
sudo cp treadmill-ble.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable treadmill-ble

echo ""
echo "=== Installation complete ==="
echo "Start:   sudo systemctl start treadmill-ble"
echo "Stop:    sudo systemctl stop treadmill-ble"
echo "Status:  sudo systemctl status treadmill-ble"
echo "Logs:    journalctl -u treadmill-ble -f"
