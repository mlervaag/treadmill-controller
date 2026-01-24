# Quick start script for Treadmill Controller on Raspberry Pi
$PI_HOST = "192.168.1.12"

Write-Host "🚀 Starting Treadmill Controller..." -ForegroundColor Cyan

# Check if already running
$status = ssh pi@$PI_HOST 'docker ps --filter name=treadmill-controller --format "{{.Status}}"' 2>$null

if ($status -match "Up") {
    Write-Host "✅ Server is already running!" -ForegroundColor Green
    Write-Host "🌐 Access at: http://192.168.1.12:3001" -ForegroundColor Cyan
    exit 0
}

Write-Host "Starting container..." -ForegroundColor Yellow
ssh pi@$PI_HOST 'cd ~/treadmill-controller && docker compose up -d'

# Wait for health check
Write-Host "Waiting for server to be ready..." -ForegroundColor Yellow
Start-Sleep -Seconds 3

$status = ssh pi@$PI_HOST 'docker ps --filter name=treadmill-controller --format "{{.Status}}"'

if ($status -match "Up") {
    Write-Host ""
    Write-Host "✅ Server started successfully!" -ForegroundColor Green
    Write-Host "🌐 Access at: http://192.168.1.12:3001" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Tip: Run stop-server.ps1 when done to save power" -ForegroundColor Gray
} else {
    Write-Host "❌ Failed to start. Check logs with:" -ForegroundColor Red
    Write-Host "  ssh pi@192.168.1.12 'cd ~/treadmill-controller && docker compose logs'" -ForegroundColor Red
}
