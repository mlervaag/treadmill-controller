# Quick stop script for Treadmill Controller on Raspberry Pi
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

Write-Host "Stopping Treadmill Controller..." -ForegroundColor Yellow

# Check if running
$status = ssh $PI_USER@$PI_HOST 'docker ps --filter name=treadmill-controller --format "{{.Status}}"' 2>$null

if (-not $status) {
    Write-Host "Server is already stopped" -ForegroundColor Gray
    exit 0
}

# Stop container
ssh $PI_USER@$PI_HOST 'cd ~/treadmill-controller && docker compose stop'

Write-Host ""
Write-Host "Server stopped successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "This saves power on your Raspberry Pi" -ForegroundColor Gray
Write-Host "Run start-server.ps1 when you want to use it again" -ForegroundColor Gray
