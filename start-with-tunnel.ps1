# All-in-one script: Start server and create tunnel
# This makes Web Bluetooth work by accessing via localhost

$PI_HOST = "192.168.1.12"
$PORT = "3001"

Write-Host "Starting Treadmill Controller with localhost tunnel..." -ForegroundColor Cyan
Write-Host ""

# Step 1: Start server on Pi
Write-Host "[1/3] Starting server on Raspberry Pi..." -ForegroundColor Yellow
$status = ssh pi@$PI_HOST 'docker ps --filter name=treadmill-controller --format "{{.Status}}"' 2>$null

if (-not ($status -match "Up")) {
    ssh pi@$PI_HOST 'cd ~/treadmill-controller && docker compose up -d'
    Write-Host "  Server started" -ForegroundColor Green
    Start-Sleep -Seconds 3
} else {
    Write-Host "  Server already running" -ForegroundColor Green
}

# Step 2: Check if port is already in use
Write-Host ""
Write-Host "[2/3] Checking local port..." -ForegroundColor Yellow
$portInUse = Get-NetTCPConnection -LocalPort $PORT -ErrorAction SilentlyContinue

if ($portInUse) {
    Write-Host "  Port $PORT already in use (tunnel may already be running)" -ForegroundColor Yellow
    Write-Host "  Killing existing process..." -ForegroundColor Yellow
    $processId = $portInUse[0].OwningProcess
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# Step 3: Start SSH tunnel
Write-Host ""
Write-Host "[3/3] Creating SSH tunnel..." -ForegroundColor Yellow
Write-Host "  localhost:$PORT -> $PI_HOST:$PORT" -ForegroundColor Gray
Write-Host ""
Write-Host "READY!" -ForegroundColor Green
Write-Host ""
Write-Host "Open in browser: http://localhost:$PORT" -ForegroundColor Cyan
Write-Host ""
Write-Host "This window must stay open for Web Bluetooth to work" -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop tunnel (server will keep running on Pi)" -ForegroundColor Gray
Write-Host ""

# Create SSH tunnel (blocks until Ctrl+C)
ssh -L ${PORT}:localhost:${PORT} pi@${PI_HOST} -N

# When tunnel stops
Write-Host ""
Write-Host "Tunnel stopped" -ForegroundColor Yellow
Write-Host "Server is still running on Pi. To stop it, run: .\stop-server.ps1" -ForegroundColor Gray
