# 🔵 Web Bluetooth Oppsett

## ⚠️ Viktig: Web Bluetooth krever localhost eller HTTPS

Web Bluetooth API (som brukes for å koble til tredemølle) fungerer **kun** med:
- `https://` (HTTPS-tilkoblinger)
- `http://localhost` eller `http://127.0.0.1`

Den fungerer **IKKE** med:
- ❌ `http://192.168.1.12:3001` (IP-adresse over HTTP)
- ❌ `http://raspberrypi.local:3001` (hostname over HTTP)

---

## ✅ Løsning: SSH Tunnel til localhost

### Steg 1: Start SSH Tunnel

På din Windows PC, kjør:

```powershell
.\setup-localhost-tunnel.ps1
```

Dette skriptet:
- Lager en SSH-tunnel fra `localhost:3001` til `192.168.1.12:3001`
- Holder tunnelen åpen (la vinduet stå åpent)
- Web Bluetooth vil nå fungere!

### Steg 2: Åpne Appen via localhost

I stedet for `http://192.168.1.12:3001`, åpne:

```
http://localhost:3001
```

### Steg 3: Koble til Tredemølle

Nå vil "Koble til Tredemølle"-knappen fungere! 🎉

---

## 🔄 Daglig Bruk

### Metode 1: Med SSH Tunnel (Anbefalt)

```powershell
# Terminal 1: Start server på Pi
.\start-server.ps1

# Terminal 2: Start SSH tunnel
.\setup-localhost-tunnel.ps1

# Åpne i browser: http://localhost:3001
```

### Metode 2: Kombinert Script (Enklere)

La meg lage et kombinert script for deg:

```powershell
# Kommer snart: .\start-with-tunnel.ps1
```

---

## 🌐 Alternativer (Mer Avansert)

### Alternativ 1: HTTPS med Self-Signed Certificate

**Fordeler:**
- Kan bruke IP-adresse direkte
- Fungerer fra andre enheter

**Ulemper:**
- Krever sertifikat-oppsett på Pi
- Browser-advarsler om usikker tilkobling
- Mer komplisert

### Alternativ 2: mDNS med `.local` hostname

Edge/Chrome støtter også `.local` domener:

```
http://raspberrypi.local:3001
```

Men dette fungerer **IKKE** med Web Bluetooth uten HTTPS.

---

## 🖥️ Andre Enheter

### Android Mobil/Tablet

Android Chrome støtter Web Bluetooth også over HTTP via IP! 📱

Du kan koble direkte til:
```
http://192.168.1.12:3001
```

**Ingen tunnel nødvendig!**

### iOS/iPad

❌ Fungerer ikke - iOS støtter ikke Web Bluetooth i det hele tatt.

---

## 🔧 Feilsøking

### "Cannot read properties of undefined (reading 'requestDevice')"

**Problem:** `navigator.bluetooth` er undefined

**Årsak:** Du bruker HTTP via IP-adresse

**Løsning:** Bruk SSH tunnel og åpne `http://localhost:3001`

### "Tunnel kobler fra"

```powershell
# Sjekk at Pi er tilgjengelig
ping 192.168.1.12

# Sjekk SSH-tilgang
ssh pi@192.168.1.12 'echo "OK"'

# Start tunnel på nytt
.\setup-localhost-tunnel.ps1
```

### "Port 3001 er allerede i bruk"

```powershell
# Windows: Finn og drep prosessen
netstat -ano | findstr :3001
taskkill /F /PID [PID]

# Start tunnel på nytt
.\setup-localhost-tunnel.ps1
```

---

## 💡 Anbefalt Setup for Hjemmebruk

**For Windows PC (Bluetooth-enhet):**
```powershell
# Dag 1: Setup
1. .\start-server.ps1           # Start server på Pi
2. .\setup-localhost-tunnel.ps1  # Start tunnel (la stå åpent)
3. Åpne http://localhost:3001

# Dag 2+: Bruk
- Tunnelen kjører fortsatt (hvis PC ikke restartet)
- Bare åpne http://localhost:3001 og tren!

# Når ferdig:
- Ctrl+C i tunnel-vinduet
- .\stop-server.ps1
```

**For Android Mobil/Tablet:**
```
1. Start server: .\start-server.ps1
2. Åpne http://192.168.1.12:3001 direkte
3. Koble til tredemølle
4. Tren!
```

---

## 📝 Oppsummering

| Enhet | URL | Bluetooth | Trenger Tunnel? |
|-------|-----|-----------|-----------------|
| **Windows PC** | `http://localhost:3001` | ✅ | ✅ Ja |
| **Android** | `http://192.168.1.12:3001` | ✅ | ❌ Nei |
| **iOS/iPad** | N/A | ❌ | N/A |

**Huskeregel:** Windows = localhost med tunnel, Android = IP direkte! 🎯
