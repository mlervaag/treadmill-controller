# Configuration
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
    $PI_USER = Read-Host "Enter Raspberry Pi Username (default: pi)"
    if (-not $PI_USER) { $PI_USER = "pi" }
}
if (-not $APP_DIR) {
    $APP_DIR = "/home/$PI_USER/treadmill-controller"
}

Write-Host "🚀 Deploying Treadmill Controller to Raspberry Pi..." -ForegroundColor Cyan

# Test SSH connection
Write-Host "Testing SSH connection to ${PI_USER}@${PI_HOST}..." -ForegroundColor Yellow
try {
    ssh -o ConnectTimeout=5 "${PI_USER}@${PI_HOST}" "echo 'SSH connection successful!'"
    if ($LASTEXITCODE -ne 0) { throw "SSH failed" }
    Write-Host "✅ SSH connection successful!" -ForegroundColor Green
}
catch {
    Write-Host "❌ Cannot connect to Raspberry Pi. Please check:" -ForegroundColor Red
    Write-Host "  - IP address is correct ($PI_HOST)" -ForegroundColor Red
    Write-Host "  - SSH is enabled on Pi" -ForegroundColor Red
    Write-Host "  - Pi is on the same network" -ForegroundColor Red
    Write-Host "  - You may need to install OpenSSH Client in Windows Features" -ForegroundColor Red
    exit 1
}

# Create app directory on Pi
Write-Host "📁 Creating application directory on Pi..." -ForegroundColor Yellow
ssh "${PI_USER}@${PI_HOST}" "mkdir -p ${APP_DIR}"

# Copy files using SCP
Write-Host "📦 Copying files to Pi..." -ForegroundColor Yellow

# Files to copy
$filesToCopy = @(
    "server.js",
    "package.json",
    "package-lock.json",
    "migrate.js",
    "Dockerfile",
    "docker-compose.yml",
    ".dockerignore",
    "templates.json"
)

foreach ($file in $filesToCopy) {
    if (Test-Path $file) {
        Write-Host "  Copying $file..." -ForegroundColor Gray
        scp $file "${PI_USER}@${PI_HOST}:${APP_DIR}/"
    }
}

# Copy public directory
Write-Host "  Copying public directory..." -ForegroundColor Gray
scp -r public "${PI_USER}@${PI_HOST}:${APP_DIR}/"

# Deploy and start with Docker
Write-Host "🐳 Building and starting Docker container..." -ForegroundColor Yellow
ssh "${PI_USER}@${PI_HOST}" @"
cd $APP_DIR
mkdir -p data
docker compose down 2>/dev/null || true
docker compose up -d --build
echo ''
echo '✅ Deployment complete!'
echo ''
echo '📊 Container status:'
docker compose ps
echo ''
echo '📝 Recent logs:'
docker compose logs --tail=20
"@

Write-Host ""
Write-Host "🎉 Deployment finished!" -ForegroundColor Green
Write-Host ""
Write-Host "🌐 Access the app at: https://192.168.1.12:3001" -ForegroundColor Cyan
Write-Host ""
Write-Host "⚠️  If HTTPS is not working yet, run: .\enable-https.ps1" -ForegroundColor Yellow
Write-Host ""
Write-Host "Useful commands:" -ForegroundColor Yellow
Write-Host "  View logs:    ssh pi@192.168.1.12 'cd ~/treadmill-controller && docker compose logs -f'"
Write-Host "  Restart:      ssh pi@192.168.1.12 'cd ~/treadmill-controller && docker compose restart'"
Write-Host "  Stop:         ssh pi@192.168.1.12 'cd ~/treadmill-controller && docker compose down'"
Write-Host "  View status:  ssh pi@192.168.1.12 'cd ~/treadmill-controller && docker compose ps'"
