# 🍓 Raspberry Pi Deployment Guide

## ✅ Status: DEPLOYED AND RUNNING

Your Treadmill Controller is now running on your Raspberry Pi!

**Access URL**: http://[YOUR_PI_IP]:3001

---

## 📋 Quick Reference

### System Info
- **Pi IP**: [YOUR_PI_IP]
- **User**: pi
- **App Directory**: /home/pi/treadmill-controller
- **Container Name**: treadmill-controller
- **Port**: 3001

### Common Commands

```bash
# View logs (real-time)
ssh [YOUR_USER]@[YOUR_PI_IP] 'cd ~/treadmill-controller && docker compose logs -f'

# View last 50 log lines
ssh [YOUR_USER]@[YOUR_PI_IP] 'cd ~/treadmill-controller && docker compose logs --tail=50'

# Restart container
ssh [YOUR_USER]@[YOUR_PI_IP] 'cd ~/treadmill-controller && docker compose restart'

# Stop container
ssh [YOUR_USER]@[YOUR_PI_IP] 'cd ~/treadmill-controller && docker compose down'

# Start container
ssh [YOUR_USER]@[YOUR_PI_IP] 'cd ~/treadmill-controller && docker compose up -d'

# Check container status
ssh [YOUR_USER]@[YOUR_PI_IP] 'cd ~/treadmill-controller && docker compose ps'

# View container resource usage
ssh [YOUR_USER]@[YOUR_PI_IP] 'docker stats treadmill-controller --no-stream'
```

---

## 🔄 Redeployment

When you make changes to the code, redeploy using:

```powershell
# From Windows (in treadmill-controller directory)
powershell.exe -ExecutionPolicy Bypass -File deploy-to-pi.ps1
```

Or from Git Bash:
```bash
bash deploy-to-pi.sh
```

---

## 🖥️ Using from Windows

### 1. Access the App
Open your browser (Chrome, Edge, or Opera) and go to:
```
http://[YOUR_PI_IP]:3001
```

### 2. Connect to Treadmill
1. Click "Koble til Tredemølle"
2. Select your treadmill from the Bluetooth dialog
3. Windows PC handles the Bluetooth connection
4. Raspberry Pi handles all data processing and storage

### 3. Architecture
```
┌─────────────────┐     Bluetooth      ┌──────────────────┐
│                 │ ◄─────────────────► │                  │
│  Windows PC     │                     │   Treadmill      │
│  (Frontend +    │                     │   (FTMS Device)  │
│   Bluetooth)    │                     │                  │
│                 │                     └──────────────────┘
└────────┬────────┘
         │ HTTP/WebSocket
         │ ([YOUR_PI_IP]:3001)
         ▼
┌─────────────────┐
│  Raspberry Pi   │
│  (Backend +     │
│   Database)     │
└─────────────────┘
```

---

## 🗄️ Database

The SQLite database is stored at:
```
/home/pi/treadmill-controller/data/treadmill.db
```

This is persisted outside the Docker container, so your data survives container restarts.

### Backup Database
```bash
# Backup to your Windows machine
scp [YOUR_USER]@[YOUR_PI_IP]:/home/pi/treadmill-controller/data/treadmill.db ./backup-treadmill.db

# Restore database
scp ./backup-treadmill.db [YOUR_USER]@[YOUR_PI_IP]:/home/pi/treadmill-controller/data/treadmill.db
ssh [YOUR_USER]@[YOUR_PI_IP] 'cd ~/treadmill-controller && docker compose restart'
```

---

## 🔧 Troubleshooting

### Container won't start
```bash
# Check logs
ssh [YOUR_USER]@[YOUR_PI_IP] 'cd ~/treadmill-controller && docker compose logs'

# Rebuild and restart
ssh [YOUR_USER]@[YOUR_PI_IP] 'cd ~/treadmill-controller && docker compose up -d --build'
```

### Can't access from Windows
1. Check Pi is on same network: `ping [YOUR_PI_IP]`
2. Check container is running: `ssh [YOUR_USER]@[YOUR_PI_IP] 'docker ps'`
3. Check port is open: `ssh [YOUR_USER]@[YOUR_PI_IP] 'netstat -tuln | grep 3001'`

### Database issues
```bash
# Check database file exists
ssh [YOUR_USER]@[YOUR_PI_IP] 'ls -lh ~/treadmill-controller/data/'

# Check file permissions
ssh [YOUR_USER]@[YOUR_PI_IP] 'chmod 666 ~/treadmill-controller/data/treadmill.db'
```

---

## 🚀 Auto-start on Boot

The container is configured with `restart: unless-stopped`, so it will:
- ✅ Start automatically when Pi boots
- ✅ Restart automatically if it crashes
- ❌ NOT restart if you manually stop it

---

## 📊 Monitoring

### Check if healthy
```bash
ssh [YOUR_USER]@[YOUR_PI_IP] 'docker inspect treadmill-controller | grep -A 5 Health'
```

### View resource usage
```bash
ssh [YOUR_USER]@[YOUR_PI_IP] 'docker stats treadmill-controller'
```

---

## 🔒 Security Notes

- App is accessible on local network only (192.168.1.x)
- No external ports exposed to internet
- Database is local to Raspberry Pi
- No cloud services used
- All data stays on your network

---

## 📝 Configuration

Edit environment variables in `docker-compose.yml`:
```yaml
environment:
  - NODE_ENV=production
  - DATABASE_PATH=/app/data/treadmill.db
  - PORT=3001  # Change port if needed
```

After editing, redeploy:
```bash
ssh pi@[YOUR_PI_IP] 'cd ~/treadmill-controller && docker compose up -d'
```

---

## 🎉 You're All Set!

Your treadmill controller is now running 24/7 on your Raspberry Pi!

Just open **http://[YOUR_PI_IP]:3001** in Chrome/Edge on any device on your network and start training! 🏃‍♂️
