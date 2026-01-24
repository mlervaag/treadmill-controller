# Enable HTTPS on Raspberry Pi for Web Bluetooth support
$PI_HOST = "192.168.1.12"

Write-Host "Enabling HTTPS for Treadmill Controller..." -ForegroundColor Cyan
Write-Host ""

# Step 1: Generate SSL certificate on Pi
Write-Host "[1/3] Generating SSL certificate on Raspberry Pi..." -ForegroundColor Yellow

ssh pi@$PI_HOST @'
cd ~/treadmill-controller
mkdir -p certs
cd certs

# Check if certificate already exists
if [ -f "server.crt" ]; then
    echo "Certificate already exists"
else
    echo "Generating self-signed SSL certificate..."
    openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout server.key \
        -out server.crt \
        -days 365 \
        -subj "/CN=192.168.1.12" \
        -addext "subjectAltName=IP:192.168.1.12,IP:127.0.0.1,DNS:raspberrypi.local"

    chmod 600 server.key
    chmod 644 server.crt
    echo "Certificate created!"
fi
'@

# Step 2: Restart container with new configuration
Write-Host ""
Write-Host "[2/3] Restarting server with HTTPS..." -ForegroundColor Yellow

ssh pi@$PI_HOST 'cd ~/treadmill-controller && docker compose restart'

Start-Sleep -Seconds 5

# Step 3: Test HTTPS connection
Write-Host ""
Write-Host "[3/3] Testing HTTPS connection..." -ForegroundColor Yellow

$testResult = Invoke-WebRequest -Uri "https://192.168.1.12:3001" -SkipCertificateCheck -UseBasicParsing -ErrorAction SilentlyContinue

if ($testResult.StatusCode -eq 200) {
    Write-Host ""
    Write-Host "SUCCESS! HTTPS is now enabled!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Access the app at: https://192.168.1.12:3001" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "IMPORTANT: Your browser will show a security warning" -ForegroundColor Yellow
    Write-Host "This is normal for self-signed certificates." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "In Edge/Chrome:" -ForegroundColor Gray
    Write-Host "  1. Click 'Advanced'" -ForegroundColor Gray
    Write-Host "  2. Click 'Continue to 192.168.1.12 (unsafe)'" -ForegroundColor Gray
    Write-Host "  3. Web Bluetooth will now work!" -ForegroundColor Gray
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "Could not verify HTTPS. Check logs:" -ForegroundColor Red
    Write-Host "  ssh pi@192.168.1.12 'cd ~/treadmill-controller && docker compose logs'" -ForegroundColor Red
}
