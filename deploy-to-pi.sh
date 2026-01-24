#!/bin/bash

# Configuration
PI_USER="pi"
PI_HOST="192.168.1.12"
APP_DIR="/home/pi/treadmill-controller"

echo "🚀 Deploying Treadmill Controller to Raspberry Pi..."

# Test SSH connection
echo "Testing SSH connection to ${PI_USER}@${PI_HOST}..."
ssh -o ConnectTimeout=5 ${PI_USER}@${PI_HOST} "echo 'SSH connection successful!'" || {
    echo "❌ Cannot connect to Raspberry Pi. Please check:"
    echo "  - IP address is correct (${PI_HOST})"
    echo "  - SSH is enabled on Pi"
    echo "  - Pi is on the same network"
    exit 1
}

# Create app directory on Pi
echo "📁 Creating application directory on Pi..."
ssh ${PI_USER}@${PI_HOST} "mkdir -p ${APP_DIR}"

# Copy files to Pi (excluding node_modules, db files, etc.)
echo "📦 Copying files to Pi..."
rsync -avz --progress \
    --exclude 'node_modules' \
    --exclude '*.db' \
    --exclude '*.db-shm' \
    --exclude '*.db-wal' \
    --exclude '.git' \
    --exclude 'data' \
    ./ ${PI_USER}@${PI_HOST}:${APP_DIR}/

# Deploy and start with Docker
echo "🐳 Building and starting Docker container..."
ssh ${PI_USER}@${PI_HOST} << 'ENDSSH'
cd /home/pi/treadmill-controller

# Create data directory for database
mkdir -p data

# Stop and remove old container if exists
docker-compose down 2>/dev/null || true

# Build and start container
docker-compose up -d --build

# Show logs
echo ""
echo "✅ Deployment complete!"
echo ""
echo "📊 Container status:"
docker-compose ps

echo ""
echo "📝 Recent logs:"
docker-compose logs --tail=20

echo ""
echo "🌐 Access the app at: http://192.168.1.12:3001"
echo ""
echo "Useful commands:"
echo "  View logs:    ssh pi@192.168.1.12 'cd ~/treadmill-controller && docker-compose logs -f'"
echo "  Restart:      ssh pi@192.168.1.12 'cd ~/treadmill-controller && docker-compose restart'"
echo "  Stop:         ssh pi@192.168.1.12 'cd ~/treadmill-controller && docker-compose down'"
echo "  View status:  ssh pi@192.168.1.12 'cd ~/treadmill-controller && docker-compose ps'"
ENDSSH

echo ""
echo "🎉 Deployment finished! App should be running at http://192.168.1.12:3001"
