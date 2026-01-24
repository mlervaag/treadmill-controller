# Quick stop script for Treadmill Controller on Raspberry Pi
$PI_HOST = "192.168.1.12"

Write-Host "Stopping Treadmill Controller..." -ForegroundColor Yellow

# Check if running
$status = ssh pi@$PI_HOST 'docker ps --filter name=treadmill-controller --format "{{.Status}}"' 2>$null

if (-not $status) {
    Write-Host "Server is already stopped" -ForegroundColor Gray
    exit 0
}

# Stop container
ssh pi@$PI_HOST 'cd ~/treadmill-controller && docker compose stop'

Write-Host ""
Write-Host "Server stopped successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "This saves power on your Raspberry Pi" -ForegroundColor Gray
Write-Host "Run start-server.ps1 when you want to use it again" -ForegroundColor Gray
