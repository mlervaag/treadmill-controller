#!/bin/bash

# Setup HTTPS on Raspberry Pi for Web Bluetooth support
# This creates a self-signed SSL certificate

echo "🔒 Setting up HTTPS for Treadmill Controller..."
echo ""

# Create certificates directory
mkdir -p /home/pi/treadmill-controller/certs
cd /home/pi/treadmill-controller/certs

# Check if certificate already exists
if [ -f "server.crt" ]; then
    echo "Certificate already exists. Delete certs/*.* to regenerate."
    exit 0
fi

# Generate self-signed certificate
echo "Generating self-signed SSL certificate..."
openssl req -x509 -newkey rsa:4096 -nodes \
    -keyout server.key \
    -out server.crt \
    -days 365 \
    -subj "/CN=raspberrypi.local" \
    -addext "subjectAltName=DNS:raspberrypi.local,IP:192.168.1.12,IP:127.0.0.1"

# Set proper permissions
chmod 600 server.key
chmod 644 server.crt

echo ""
echo "✅ SSL certificate created!"
echo ""
echo "Certificate valid for:"
echo "  - https://192.168.1.12:3001"
echo "  - https://raspberrypi.local:3001"
echo "  - https://127.0.0.1:3001"
echo ""
echo "Next steps:"
echo "1. Update server.js to use HTTPS"
echo "2. Redeploy with deploy-to-pi.ps1"
echo "3. Accept browser security warning (one-time)"
echo ""
