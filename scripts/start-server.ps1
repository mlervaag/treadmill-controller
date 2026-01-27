# Quick start script for Treadmill Controller on Raspberry Pi
$EnvPath = Join-Path $PSScriptRoot "..\.env.local"
if (Test-Path $EnvPath) {
    Get-Content $EnvPath | ForEach-Object {
        if ($_ -match '^\s*([^#=]+)\s*=\s*(.*)$') {
            Set-Variable -Name $matches[1] -Value $matches[2] -Scope Script
        }
    }
}

if (-not $PI_HOST) {
    $PI_HOST = Read-Host "Enter Raspberry Pi IP address/Hostname (e.g. 192.168.1.12)"
}
if (-not $PI_USER) {
    $PI_USER = "pi"
}

Write-Host "Starting Treadmill Controller..." -ForegroundColor Cyan

# Check if already running
$status = ssh $PI_USER@$PI_HOST 'docker ps --filter name=treadmill-controller --format "{{.Status}}"' 2>$null

if ($status -match "Up") {
    Write-Host "Server is already running!" -ForegroundColor Green
    Write-Host "Access at: https://$PI_HOST:3001" -ForegroundColor Cyan
    exit 0
}

Write-Host "Starting container..." -ForegroundColor Yellow
ssh $PI_USER@$PI_HOST 'cd ~/treadmill-controller && docker compose up -d'

# Wait for health check
Write-Host "Waiting for server to be ready..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

$status = ssh $PI_USER@$PI_HOST 'docker ps --filter name=treadmill-controller --format "{{.Status}}"'

if ($status) {
    Write-Host ""
    Write-Host "✅ Server started successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Access at: https://${PI_HOST}:3001" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Tip: Run .\scripts\stop-server.ps1 when done to save power" -ForegroundColor Gray
} else {
    Write-Host "Failed to start. Check logs with:" -ForegroundColor Red
    Write-Host "  ssh $PI_USER@$PI_HOST 'cd ~/treadmill-controller && docker compose logs'" -ForegroundColor Red
}
