# Setup localhost tunnel to Raspberry Pi
# This allows Web Bluetooth to work by accessing via localhost

$PI_HOST = "192.168.1.12"
$PI_PORT = "3001"
$LOCAL_PORT = "3001"

Write-Host "Setting up localhost tunnel to Raspberry Pi..." -ForegroundColor Cyan
Write-Host ""
Write-Host "This creates a tunnel from localhost:$LOCAL_PORT to $PI_HOST:$PI_PORT" -ForegroundColor Gray
Write-Host "This enables Web Bluetooth (which requires localhost or HTTPS)" -ForegroundColor Gray
Write-Host ""

# Check if port is already in use
$portInUse = Get-NetTCPConnection -LocalPort $LOCAL_PORT -ErrorAction SilentlyContinue

if ($portInUse) {
    Write-Host "Port $LOCAL_PORT is already in use. Stopping existing tunnel..." -ForegroundColor Yellow
    # Find and kill the process
    $processId = $portInUse[0].OwningProcess
    Stop-Process -Id $processId -Force
    Start-Sleep -Seconds 1
}

Write-Host "Starting SSH tunnel..." -ForegroundColor Yellow
Write-Host ""
Write-Host "Press Ctrl+C to stop the tunnel" -ForegroundColor Gray
Write-Host ""

# Create SSH tunnel
# -L : Local port forwarding
# -N : Don't execute remote command
# -v : Verbose (optional, remove for less output)
ssh -L ${LOCAL_PORT}:localhost:${PI_PORT} pi@${PI_HOST} -N

# This will run until Ctrl+C
Write-Host ""
Write-Host "Tunnel stopped" -ForegroundColor Yellow
