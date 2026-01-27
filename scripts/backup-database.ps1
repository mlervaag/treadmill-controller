# Backup Treadmill Database from Raspberry Pi
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
$BACKUP_DIR = ".\backups"
$TIMESTAMP = Get-Date -Format "yyyy-MM-dd_HHmm"
$BACKUP_FILE = "$BACKUP_DIR\treadmill-backup-$TIMESTAMP.db"

Write-Host "Backing up Treadmill Database..." -ForegroundColor Cyan

# Create backup directory if it doesn't exist
if (-not (Test-Path $BACKUP_DIR)) {
    New-Item -ItemType Directory -Path $BACKUP_DIR | Out-Null
}

# Download database
Write-Host "Downloading from Raspberry Pi..." -ForegroundColor Yellow
scp $PI_USER@${PI_HOST}:/home/$PI_USER/treadmill-controller/data/treadmill.db $BACKUP_FILE

if ($LASTEXITCODE -eq 0) {
    $fileSize = (Get-Item $BACKUP_FILE).Length / 1KB
    Write-Host ""
    Write-Host "Backup completed successfully!" -ForegroundColor Green
    Write-Host "Saved to: $BACKUP_FILE" -ForegroundColor Cyan
    Write-Host "Size: $([math]::Round($fileSize, 2)) KB" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Tip: Keep backups before major updates or monthly" -ForegroundColor Gray

    # List recent backups
    Write-Host ""
    Write-Host "Recent backups:" -ForegroundColor Yellow
    Get-ChildItem $BACKUP_DIR -Filter "treadmill-backup-*.db" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 5 |
        ForEach-Object {
            $size = [math]::Round($_.Length / 1KB, 2)
            Write-Host "  $($_.Name) - $size KB - $($_.LastWriteTime)" -ForegroundColor Gray
        }
} else {
    Write-Host "Backup failed!" -ForegroundColor Red
    Write-Host "Check that the Raspberry Pi is accessible" -ForegroundColor Red
}
