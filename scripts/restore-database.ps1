# Restore Treadmill Database to Raspberry Pi
param(
    [Parameter(Mandatory=$false)]
    [string]$BackupFile
)

$PI_HOST = "192.168.1.12"
$BACKUP_DIR = ".\backups"

Write-Host "🔄 Restore Treadmill Database" -ForegroundColor Cyan

# List available backups if no file specified
if (-not $BackupFile) {
    Write-Host ""
    Write-Host "Available backups:" -ForegroundColor Yellow
    $backups = Get-ChildItem $BACKUP_DIR -Filter "treadmill-backup-*.db" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending

    if ($backups.Count -eq 0) {
        Write-Host "No backups found in $BACKUP_DIR" -ForegroundColor Red
        Write-Host "Run backup-database.ps1 first" -ForegroundColor Red
        exit 1
    }

    for ($i = 0; $i -lt $backups.Count; $i++) {
        $backup = $backups[$i]
        $size = [math]::Round($backup.Length / 1KB, 2)
        Write-Host "  [$i] $($backup.Name) - $size KB - $($backup.LastWriteTime)" -ForegroundColor Gray
    }

    Write-Host ""
    $selection = Read-Host "Select backup number (or 'q' to quit)"

    if ($selection -eq 'q') {
        Write-Host "Cancelled" -ForegroundColor Yellow
        exit 0
    }

    $BackupFile = $backups[$selection].FullName
}

if (-not (Test-Path $BackupFile)) {
    Write-Host "❌ Backup file not found: $BackupFile" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "⚠️  WARNING: This will overwrite the current database!" -ForegroundColor Yellow
Write-Host "Current database on Pi will be replaced with: $BackupFile" -ForegroundColor Yellow
$confirm = Read-Host "Type 'YES' to confirm"

if ($confirm -ne 'YES') {
    Write-Host "Cancelled" -ForegroundColor Yellow
    exit 0
}

# Stop container first
Write-Host ""
Write-Host "Stopping container..." -ForegroundColor Yellow
ssh pi@$PI_HOST 'cd ~/treadmill-controller && docker compose stop'

# Upload database
Write-Host "Uploading backup to Raspberry Pi..." -ForegroundColor Yellow
scp $BackupFile pi@${PI_HOST}:/home/pi/treadmill-controller/data/treadmill.db

if ($LASTEXITCODE -eq 0) {
    # Restart container
    Write-Host "Restarting container..." -ForegroundColor Yellow
    ssh pi@$PI_HOST 'cd ~/treadmill-controller && docker compose start'

    Start-Sleep -Seconds 2

    Write-Host ""
    Write-Host "✅ Database restored successfully!" -ForegroundColor Green
    Write-Host "🌐 App is available at: http://192.168.1.12:3001" -ForegroundColor Cyan
} else {
    Write-Host "❌ Restore failed!" -ForegroundColor Red
    Write-Host "Starting container anyway..." -ForegroundColor Yellow
    ssh pi@$PI_HOST 'cd ~/treadmill-controller && docker compose start'
}
