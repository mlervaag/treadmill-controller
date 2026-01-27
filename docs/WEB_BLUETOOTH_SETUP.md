# 🔵 Web Bluetooth Oppsett

## ⚠️ Viktig: Web Bluetooth krever HTTPS

Web Bluetooth API (som brukes for å koble til tredemølle) fungerer **kun** med:
- `https://` (HTTPS-tilkoblinger)
- `http://localhost` eller `http://127.0.0.1`

Den fungerer **IKKE** med:
- ❌ `http://[YOUR_PI_IP]:3001` (IP-adresse over HTTP)
- ❌ `http://raspberrypi.local:3001` (hostname over HTTP)

---

## ✅ Løsning: HTTPS med Self-Signed Certificate

### Steg 1: Aktiver HTTPS

På din Windows PC, kjør:

```powershell
.\scripts\enable-https.ps1
```

Dette skriptet:
- Lager et self-signed SSL-sertifikat på Raspberry Pi
- Restarter serveren med HTTPS aktivert
- Sertifikatet er gyldig for `[YOUR_PI_IP]`, `127.0.0.1`, og `raspberrypi.local`

### Steg 2: Åpne Appen via HTTPS

Åpne i nettleseren:

```
https://[YOUR_PI_IP]:3001
```

### Steg 3: Godta Sertifikatadvarsel

Første gang du åpner appen vil du se en sikkerhetsadvarsel. Dette er normalt for self-signed sertifikater.

**I Edge/Chrome:**
1. Klikk "Advanced" eller "Avansert"
2. Klikk "Continue to [YOUR_PI_IP] (unsafe)" eller "Fortsett til [YOUR_PI_IP] (usikkert)"
3. Web Bluetooth vil nå fungere! 🎉

**Hvorfor denne advarselen?**
- Self-signed sertifikater er ikke signert av en trusted Certificate Authority (CA)
- For lokal hjemmebruk er dette helt trygt
- Alternativet ville vært å betale for et kommersielt sertifikat (unødvendig)

### Steg 4: Koble til Tredemølle

Nå vil "Koble til Tredemølle"-knappen fungere uten feil!

---

## 🔄 Daglig Bruk

```powershell
# Start server på Pi
.\scripts\start-server.ps1

# Åpne i browser: https://[YOUR_PI_IP]:3001

# Stopp server når ferdig (spar strøm)
.\scripts\stop-server.ps1
```

---

## 🖥️ Andre Enheter

### Windows PC
✅ Full støtte med HTTPS
```
https://[YOUR_PI_IP]:3001
```

### Android Mobil/Tablet
✅ Full støtte med HTTPS
```
https://[YOUR_PI_IP]:3001
```

**Bonus:** Android Chrome støtter også Web Bluetooth over HTTP via IP-adresser, så du kan bruke `http://[YOUR_PI_IP]:3001` hvis du foretrekker det.

### iOS/iPad
❌ Fungerer ikke - iOS støtter ikke Web Bluetooth i det hele tatt.

Du kan fortsatt se historikk og statistikk, men ikke koble til tredemøllen.

---

## 🔧 Feilsøking

### "Cannot read properties of undefined (reading 'requestDevice')"

**Problem:** `navigator.bluetooth` er undefined

**Årsak:** Du bruker HTTP via IP-adresse

**Løsning:**
1. Kjør `.\scripts\enable-https.ps1` for å aktivere HTTPS
2. Åpne `https://[YOUR_PI_IP]:3001` (ikke `http://`)
3. Godta sertifikatadvarselen

### "Server kjører fortsatt på HTTP"

**Sjekk at sertifikatene eksisterer:**
```powershell
ssh pi@[YOUR_PI_IP] 'ls -la ~/treadmill-controller/certs/'
```

Du skal se `server.key` og `server.crt`.

**Sjekk server-logger:**
```powershell
ssh pi@[YOUR_PI_IP] 'cd ~/treadmill-controller && docker compose logs'
```

Du skal se:
```
🔒 HTTPS enabled
Server running on https://0.0.0.0:3001
WebSocket server running on wss://0.0.0.0:3001
```

**Hvis ikke, restart serveren:**
```powershell
.\scripts\stop-server.ps1
.\scripts\start-server.ps1
```

### "Sertifikatet er utløpt"

Self-signed sertifikater er gyldige i 365 dager. For å fornye:

```powershell
# Slett gamle sertifikater
ssh pi@[YOUR_PI_IP] 'rm ~/treadmill-controller/certs/server.*'

# Generer nye
.\scripts\enable-https.ps1
```

---

## 📝 Oppsummering

| Enhet | URL | Bluetooth | Sertifikatadvarsel? |
|-------|-----|-----------|---------------------|
| **Windows PC** | `https://[YOUR_PI_IP]:3001` | ✅ | Ja (kun første gang) |
| **Android** | `https://[YOUR_PI_IP]:3001` | ✅ | Ja (kun første gang) |
| **iOS/iPad** | `https://[YOUR_PI_IP]:3001` | ❌ | Ja (kun første gang) |

**Huskeregel:** HTTPS for alle enheter, godta sertifikat første gang! 🔒
