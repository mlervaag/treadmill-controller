# 🏠 Hjemmebruk Guide - Treadmill Controller

## 🎯 Optimalt Oppsett for Hjemmebruk

Du har nå et **perfekt oppsett** for hjemmebruk med multi-enhet støtte!

### ✨ Ditt Oppsett
- **Server**: Raspberry Pi (192.168.1.12) - alltid tilgjengelig på nettverket
- **Frontend**: Windows PC, mobil, tablet - alle kan koble til samtidig
- **Bluetooth**: Hver enhet kobler til tredemølle via sin egen Bluetooth
- **Data**: Sentralisert på Pi - alle enheter ser samme data

---

## 🔒 Første gangs oppsett - HTTPS

For at Web Bluetooth skal fungere må du aktivere HTTPS:

```powershell
.\enable-https.ps1
```

Dette gjøres **kun én gang**. Skriptet:
- Genererer SSL-sertifikat på Raspberry Pi
- Aktiverer HTTPS på serveren
- Sertifikatet varer i 365 dager

**Første gang du åpner appen:**
1. Gå til `https://192.168.1.12:3001`
2. Du får en sikkerhetsadvarsel (normalt for self-signed sertifikater)
3. Klikk "Advanced" → "Continue to 192.168.1.12 (unsafe)"
4. Du slipper å gjøre dette igjen!

---

## 🚀 Daglig Bruk

### Start Server (før trening)
```powershell
.\start-server.ps1
```
Serveren starter på ca 3 sekunder. Åpne deretter:
- **Windows**: https://192.168.1.12:3001 i Chrome/Edge
- **Mobil**: https://192.168.1.12:3001 i Chrome (Android)
- **Tablet**: https://192.168.1.12:3001 i Chrome/Safari

**Første gang:** Godta sertifikatadvarsel ("Advanced" → "Continue")

### Stopp Server (etter trening)
```powershell
.\stop-server.ps1
```
**Sparer strøm** på Raspberry Pi når du ikke bruker appen.

---

## 💾 Backup & Restore

### Ta Backup (før større endringer)
```powershell
.\backup-database.ps1
```
- Lager backup i `.\backups\` mappen
- Timestamp i filnavn: `treadmill-backup-2026-01-24_1430.db`
- Kjør dette månedlig eller før oppdateringer

### Gjenopprett fra Backup
```powershell
.\restore-database.ps1
```
- Velg backup fra liste
- Bekrefter før overskriving
- Automatisk restart av server

---

## 📊 Bruksscenarier

### Scenario 1: Quick Workout (mest vanlig for deg)
```powershell
# 1. Start server
.\start-server.ps1

# 2. Åpne https://192.168.1.12:3001 i browser
# 3. Koble til tredemølle
# 4. Tren!

# 5. Stopp server når ferdig (sparer strøm)
.\stop-server.ps1
```

### Scenario 2: Helg med flere økter
```powershell
# Fredag kveld:
.\start-server.ps1

# Tren lørdag og søndag uten å stoppe server

# Søndag kveld:
.\stop-server.ps1
```

### Scenario 3: 24/7 Drift (hvis du endrer mening)
Endre i `docker-compose.yml`:
```yaml
restart: "unless-stopped"  # Istedenfor "no"
```
Deretter:
```powershell
.\deploy-to-pi.ps1
```

---

## 🔧 Vedlikehold

### Månedlig
1. **Ta backup**: `.\backup-database.ps1`
2. **Sjekk diskplass** på Pi:
   ```powershell
   ssh pi@192.168.1.12 'df -h'
   ```

### Ved Oppdateringer
```powershell
# 1. Ta backup først
.\backup-database.ps1

# 2. Deploy ny versjon
.\deploy-to-pi.ps1

# 3. Test at alt fungerer
# 4. Slett gamle backups (behold siste 5-10)
```

---

## ⚡ Strømforbruk

### Med `restart: "no"` (nåværende oppsett)
- **Standby**: ~3-5W (kun Pi + Docker daemon)
- **Kjørende**: ~8-10W (Pi + container)
- **Estimert kostnad** ved sporadisk bruk: ~5-10 kr/måned

### Med 24/7 drift
- **Alltid på**: ~8-10W
- **Estimert kostnad**: ~20-30 kr/måned

**Konklusjon**: Nåværende oppsett med start/stopp sparer ~15-20 kr/måned 💰

---

## 📱 Multi-Enhet Tilgang

### Windows PC (Bluetooth-enhet)
✅ Perfekt for Web Bluetooth
- Chrome, Edge, eller Opera
- Kobler direkte til tredemølle via Bluetooth

### Android Mobil/Tablet
✅ Fungerer utmerket
- Chrome browser
- Samme Bluetooth-støtte som desktop
- Ideelt for iPad/Android tablet på stativet

### iOS/iPhone
⚠️ Begrenset (ingen Web Bluetooth)
- Kan se historikk og statistikk
- KAN IKKE koble til tredemølle
- Bruk Windows PC eller Android for trening

---

## 🔒 Sikkerhet

### Nettverkstilgang
- ✅ Kun tilgjengelig på lokalt nettverk (192.168.1.x)
- ✅ Ingen porter åpne til internett
- ✅ All data forblir hjemme

### Database
- ✅ Lagret kun på Raspberry Pi
- ✅ Persistent ved container-restart
- ✅ Kan backupes til Windows PC

---

## 💡 Tips & Triks

### Lag Desktop Shortcuts
**Windows**:
1. Høyreklikk på Desktop → New → Shortcut
2. Target: `powershell.exe -ExecutionPolicy Bypass -File "C:\Path\To\start-server.ps1"`
3. Navn: "Start Tredemølle Server"

### Legg til Favorites i Browser
Lagre https://192.168.1.12:3001 som bookmark for rask tilgang

### Sjekk Server Status
```powershell
ssh pi@192.168.1.12 'docker ps'
```

---

## 📈 Når Oppgradere?

Nåværende oppsett er **optimalt** for:
- ✅ 1-4 treninger per uke
- ✅ Multi-enhet tilgang
- ✅ Strømbesparende
- ✅ Enkel vedlikehold

Vurder **oppgradering** kun hvis:
- Du begynner å trene daglig (gå til 24/7)
- Du vil ha automatisk backup (sett opp cron job)
- Du vil ha cloud sync (krever betydelig mer arbeid)

---

## ✅ Oppsummering

**Ditt nåværende oppsett er OPTIMALT for hjemmebruk!**

### Styrker:
- 🎯 Multi-enhet støtte (PC, tablet, mobil)
- ⚡ Strømbesparende med manuell start/stopp
- 💾 Enkel backup og restore
- 🔒 100% privat - ingen cloud
- 🚀 Rask oppstart (3 sekunder)
- 📊 Sentralisert data på én server

### Daglig Bruk:
1. `.\start-server.ps1`
2. Tren på https://192.168.1.12:3001
3. `.\stop-server.ps1`

**Det er alt!** 🎉
