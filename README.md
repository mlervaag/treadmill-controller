# 🏃 Tredemølle Kontroller

En moderne, fullstendig webapplikasjon for å kontrollere tredemøllen din via Bluetooth (FTMS) og spore treningsøkter. Optimalisert for desktop, tablet og mobil.

![License](https://img.shields.io/badge/license-ISC-blue.svg)
![Node.js](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen.svg)
![Web Bluetooth](https://img.shields.io/badge/Web%20Bluetooth-FTMS-orange.svg)

## ✨ Funksjoner

### 🎮 Kontroll & Sanntid
- **Bluetooth FTMS-kontroll**: Koble til tredemølle via FTMS (Fitness Machine Service)
- **Manuell kontroll**: Juster hastighet (0.1-14.0 km/t) og stigning (0-12%) i sanntid
- **Tre visningsmoduser**: Fokus, Oversikt, og Minimal for ulike preferanser
- **Live statistikk**: Se hastighet, distanse, tid, puls, kalorier og effekt

### 💪 Treningsøkter
- **Forhåndsdefinerte maler**: 5 profesjonelle treningsøkter inkludert:
  - Couch to 5K (nybegynner)
  - HIIT - High Intensity Interval Training
  - Hill Climbing - Fjelltrening
  - Steady State - Langkjøring
  - Pyramid Intervals - Pyramidetrening
- **Egendefinerte økter**: Lag dine egne treningsøkter med flere segmenter
- **Automatisk kjøring**: Start forhåndsdefinerte økter som kjører automatisk
- **Segment-støtte**: Hvert segment med egen varighet, hastighet og stigning

### 📊 Historikk & Statistikk
- **Tre visninger**: Oversikt, Økter, og Trender
- **Total statistikk**: Samlet distanse, tid, kalorier og antall økter
- **Personlige rekorder**: Beste pace, lengste distanse, lengste økt, flest kalorier
- **Gjennomsnitt per økt**: Automatisk beregning av gjennomsnittsverdier
- **Siste 7 dager**: Detaljert aktivitetsoversikt
- **Ukentlig/månedlig utvikling**: Se fremgang over tid
- **Slett økter**: Fjern testøkter fra historikken

### ❤️ Pulsmåling
- **FTMS puls-støtte**: Mottar pulsdata fra FTMS-protokollen
- **Smart visning**: Skjuler pulsvisning automatisk når ingen gyldig puls er tilgjengelig
- **Pulsbelte-kompatibel**: Fungerer med Bluetooth-pulsbelte (f.eks. Polar H10)
- **Gjennomsnittspuls**: Beregner gjennomsnitt kun fra gyldige målinger

### 📱 Mobil & Tablet
- **Fullt responsiv**: Optimalisert for mobil, tablet (iPad) og desktop
- **Touch-optimalisert**: Store knapper (min 44x44px), bedre spacing
- **Apple Web App**: Fungerer som standalone app på iOS/iPadOS
- **Landscape-støtte**: Spesialtilpasset for mobil i liggende modus
- **Breakpoints**: 480px, 768px, 1024px for optimal opplevelse

### 🔒 Sikkerhet & Personvern
- **100% lokal**: Kjører kun lokalt på din PC/enhet
- **Ingen cloud**: Ingen data sendes til eksterne servere
- **Lokal database**: Alt lagres i SQLite på din maskin
- **Web Bluetooth sikkerhet**: Krever brukerinteraksjon for tilkobling

## 📋 Forutsetninger

### Nødvendig
- **Node.js** versjon 14 eller nyere
- **Tredemølle** med Bluetooth FTMS-støtte (f.eks. Ronning x27 Pro, kompatibel med Zwift/Kinomap)

### Støttede plattformer
| Plattform | Nettleser | Web Bluetooth | Status |
|-----------|-----------|---------------|--------|
| **Windows** | Chrome, Edge, Opera | ✅ | Fullt støttet |
| **macOS** | Chrome, Edge, Opera | ✅ | Fullt støttet |
| **Linux** | Chrome, Edge, Opera | ✅ | Fullt støttet |
| **Android** | Chrome, Edge, Opera | ✅ | Fullt støttet |
| **Chrome OS** | Chrome | ✅ | Fullt støttet |
| **iOS/iPadOS** | Safari, Chrome | ❌ | Kun visning* |

*iOS støtter ikke Web Bluetooth API. Du kan se historikk og statistikk, men ikke kontrollere tredemøllen.

## 🚀 Installasjon

### Enkel installasjon (Anbefalt for de fleste)

Den raskeste måten å komme i gang:

1. **Klon repositoryet**:
```bash
git clone https://github.com/mlervaag/treadmill-controller.git
cd treadmill-controller
```

2. **Installer avhengigheter**:
```bash
npm install
```

3. **Start serveren**:
```bash
npm start
```

4. **Åpne i nettleser**:
- Gå til `http://localhost:3001` i Chrome/Edge/Opera
- Koble til tredemøllen via Bluetooth
- Begynn å trene!

**Det er alt!** Serveren kjører på din PC, og Web Bluetooth fungerer via localhost.

### Avansert: Raspberry Pi deployment (Multi-enhet tilgang)

Hvis du vil kjøre serveren på en Raspberry Pi og få tilgang fra flere enheter (PC, mobil, tablet) på hjemmenetverket:

<details>
<summary><strong>Vis Raspberry Pi installasjon</strong></summary>

#### Forutsetninger
- Raspberry Pi med Docker installert
- Windows PC med PowerShell (for deploy-skriptene)
- SSH-tilgang til Raspberry Pi

#### Installasjon
1. **Klon repositoryet på din Windows PC**:
```bash
git clone https://github.com/mlervaag/treadmill-controller.git
cd treadmill-controller
```

2. **Deploy til Raspberry Pi**:
```powershell
.\deploy-to-pi.ps1
```

3. **Aktiver HTTPS** (nødvendig for Web Bluetooth):
```powershell
.\enable-https.ps1
```

4. **Åpne i nettleser**:
- Gå til `https://192.168.1.12:3001` (erstatt med din Pi's IP-adresse)
- Godta sikkerhetsadvarselen for self-signed sertifikat (klikk "Advanced" → "Continue")
- Web Bluetooth vil nå fungere!

#### Daglig bruk
```powershell
# Start server
.\start-server.ps1

# Stopp server (spar strøm)
.\stop-server.ps1

# Backup database
.\backup-database.ps1
```

#### Fordeler med Raspberry Pi-oppsett
- ✅ Multi-enhet tilgang (PC, mobil, tablet)
- ✅ Sentralisert data - alle enheter ser samme historikk
- ✅ Kan slå av/på serveren for å spare strøm
- ✅ Automatisk backup-løsning

</details>

## 🎯 Bruk

### Lokal bruk (enklest)
1. **Start serveren**: Kjør `npm start` i terminalen
2. **Åpne appen**: Gå til `http://localhost:3001` i Chrome/Edge/Opera
3. **Slå på tredemøllen**: Sørg for at Bluetooth er aktivert
4. **Koble til**: Klikk "Koble til Tredemølle" og velg din tredemølle
5. **Tren!**: Du er klar til å kjøre!

### Raspberry Pi bruk (multi-enhet)
Hvis du har satt opp Raspberry Pi-deployment:

1. **Første gang**:
   - Åpne `https://[PI-IP]:3001` i Chrome/Edge/Opera
   - Godta sertifikatadvarsel (klikk "Advanced" → "Continue")

2. **Multi-enhet tilgang**:
   - **Windows PC**: `https://192.168.1.12:3001` - Full Bluetooth-kontroll
   - **Android mobil/tablet**: `https://192.168.1.12:3001` - Full Bluetooth-kontroll
   - **iOS/iPad**: `https://192.168.1.12:3001` - Kun visning (ingen Bluetooth-støtte)

### Visningsmoduser
- **🎯 Fokus**: Store tall for hastighet og tid - perfekt under trening
- **📊 Oversikt**: Alle stats synlige samtidig
- **⚡ Minimal**: Rask oversikt med essentials

### Treningsøkter
1. **Gå til "Treningsøkter"**: Se forhåndsdefinerte maler eller lag din egen
2. **Velg mal**: Prøv f.eks. "HIIT" eller "Couch to 5K"
3. **Start økt**: Velg fra nedtrekksmenyen i Kontroll-fanen og klikk "Start Økt"
4. **Automatisk kjøring**: Appen styrer hastighet og stigning automatisk gjennom segmentene

### Historikk
- **📊 Oversikt**: Se total statistikk, personlige rekorder, og gjennomsnitt
- **📋 Økter**: Liste over alle økter med mulighet til å se detaljer eller slette
- **📈 Trender**: Ukentlig og månedlig utvikling

## 🔧 FTMS (Fitness Machine Service)

Applikasjonen bruker Bluetooth Low Energy FTMS-standarden, samme som brukes av Zwift, Kinomap, Peloton, etc.

### Støttede funksjoner
| Funksjon | Status | Beskrivelse |
|----------|--------|-------------|
| Lesing av data | ✅ | Hastighet, stigning, distanse, tid, puls, kalorier, effekt |
| Hastighet | ✅ | Juster 0.1-14.0 km/t |
| Stigning | ✅ | Juster 0-12% |
| Start/Pause/Stopp | ✅ | Full kontroll over tredemølle |
| Reset | ✅ | Nullstill alle verdier |

### UUID Referanse
```
FTMS Service:         00001826-0000-1000-8000-00805f9b34fb
Treadmill Data:       00002acd-0000-1000-8000-00805f9b34fb
Control Point:        00002ad9-0000-1000-8000-00805f9b34fb
Machine Status:       00002ada-0000-1000-8000-00805f9b34fb
```

## 📁 Prosjektstruktur

```
treadmill-controller/
├── server.js                  # Express server med HTTPS, WebSocket og API
├── package.json               # npm konfigurasjon og dependencies
├── Dockerfile                 # Docker container build
├── docker-compose.yml         # Docker Compose konfigurasjon
├── .gitignore                 # Git ignore-fil
├── LICENSE                    # ISC lisens
├── README.md                  # Denne filen
├── HOME_USAGE_GUIDE.md        # Guide for hjemmebruk
├── deploy-to-pi.ps1           # Deploy til Raspberry Pi
├── enable-https.ps1           # Aktiver HTTPS med SSL-sertifikat
├── start-server.ps1           # Start server på Pi
├── stop-server.ps1            # Stopp server på Pi
├── backup-database.ps1        # Backup database fra Pi
├── restore-database.ps1       # Gjenopprett database til Pi
├── data/
│   └── treadmill.db           # SQLite database (opprettes automatisk)
├── certs/                     # SSL-sertifikater (git-ignored)
│   ├── server.key             # Private key
│   └── server.crt             # Self-signed certificate
└── public/
    ├── index.html             # Hovedside med full UI
    ├── style.css              # Moderne, responsiv styling
    ├── app.js                 # Frontend logikk og UI-kontroll
    └── ftms.js                # FTMS Bluetooth-implementasjon
```

## 🗃️ Database Schema

### `workouts`
Lagrer treningsøkter (både maler og egendefinerte)
```sql
id, name, description, difficulty, is_template, created_at
```

### `workout_segments`
Segmenter for hver treningsøkt
```sql
id, workout_id, segment_order, duration_seconds, speed_kmh,
incline_percent, segment_name
```

### `workout_sessions`
Fullførte treningsøkter (historikk)
```sql
id, workout_id, started_at, completed_at, total_distance_km,
total_time_seconds, avg_heart_rate, calories_burned
```

### `session_data`
Detaljerte datapunkter fra hver økt (hvert sekund)
```sql
id, session_id, timestamp, speed_kmh, incline_percent,
distance_km, heart_rate
```

## 🔌 API Endepunkter

### Workouts
- `GET /api/workouts` - Hent alle treningsøkter
- `GET /api/workouts/templates` - Hent kun maler
- `GET /api/workouts/:id` - Hent spesifikk økt med segmenter
- `POST /api/workouts` - Opprett ny treningsøkt
- `DELETE /api/workouts/:id` - Slett treningsøkt (cascade)

### Sessions
- `GET /api/sessions` - Hent treningshistorikk (siste 50)
- `GET /api/sessions/:id/details` - Hent økt med alle datapunkter
- `POST /api/sessions` - Start ny treningsøkt
- `PUT /api/sessions/:id` - Oppdater treningsøkt (avslutt)
- `POST /api/sessions/:id/data` - Legg til datapunkt
- `DELETE /api/sessions/:id` - Slett treningsøkt fra historikk

### Statistics
- `GET /api/stats/overall` - Total statistikk, rekorder, gjennomsnitt
- `GET /api/stats/weekly` - Ukentlig statistikk (siste 12 uker)
- `GET /api/stats/monthly` - Månedlig statistikk (siste 12 måneder)

## 🔍 Feilsøking

### Tredemølle vises ikke i Bluetooth-dialogen
- ✅ Sørg for at tredemøllen er slått på
- ✅ Sjekk at tredemøllen ikke allerede er koblet til annen enhet
- ✅ Prøv å restarte tredemøllen
- ✅ Sjekk at Bluetooth er aktivert på PC/mobil
- ✅ Prøv "Scan alle enheter"-knappen

### Kan ikke kontrollere tredemøllen
- ✅ Bekreft tilkobling (status viser "Tilkoblet")
- ✅ Noen tredemøller krever manuell start først
- ✅ Prøv å koble fra og koble til igjen
- ✅ Sjekk at du bruker støttet nettleser (Chrome/Edge/Opera)

### Puls viser ikke
- ✅ Tredemøllen må motta pulsdata fra pulsbelte (f.eks. Polar H10)
- ✅ Koble pulsbeltet til tredemøllen (ikke appen)
- ✅ Sjekk at pulsbeltet er aktivt (fuktig elektroder)
- ✅ Verdien 255 betyr "ingen puls tilgjengelig" - dette er normalt uten pulsbelte

### Web Bluetooth fungerer ikke
- ❌ Safari støtter ikke Web Bluetooth (bruk Chrome/Edge/Opera)
- ❌ Firefox støtter ikke Web Bluetooth
- ❌ iOS støtter ikke Web Bluetooth (bruk Android eller desktop)
- ✅ **Lokal bruk**: Bruk `http://localhost:3001` (ikke IP-adresse)
- ✅ **Raspberry Pi**: Bruk HTTPS (`.\enable-https.ps1` hvis ikke aktivert) og godta sertifikatadvarsel
- ✅ Sjekk Bluetooth-tillatelser i nettleseren

### Port 3001 er opptatt
```bash
# Windows
netstat -ano | findstr :3001
taskkill /F /PID [PID]

# Mac/Linux
lsof -i :3001
kill -9 [PID]
```

## 🎨 Teknologi Stack

- **Backend**: Node.js, Express 5, WebSocket (ws)
- **Database**: SQLite 3 (better-sqlite3)
- **Frontend**: Vanilla JavaScript (ES6+), HTML5, CSS3
- **Bluetooth**: Web Bluetooth API, FTMS Protocol
- **Design**: Responsive, Mobile-first, Dark theme

## 🛣️ Roadmap

### Planlagt
- [ ] Graf-visualisering av treningsdata (Chart.js)
- [ ] Export til TCX/GPX/FIT-format
- [ ] Pulssone-trening med varsler
- [ ] Intervalltrening-builder med lydvarsler
- [ ] PWA-støtte (installérbar app)
- [ ] Multi-språk støtte (engelsk, norsk)

### Under vurdering
- [ ] Integrasjon med Strava/Garmin Connect
- [ ] Native iOS-app for Bluetooth-støtte
- [ ] Automatisk bakkedeteksjon med kart-API
- [ ] Social features (del økter, utfordringer)

## 🤝 Bidra

Bidrag er velkomne! Føl deg fri til å:
1. Fork prosjektet
2. Lag en feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit dine endringer (`git commit -m 'Add some AmazingFeature'`)
4. Push til branchen (`git push origin feature/AmazingFeature`)
5. Åpne en Pull Request

## 📄 Lisens

Dette prosjektet er lisensiert under ISC License - se [LICENSE](LICENSE) filen for detaljer.

## 🙏 Anerkjennelser

- **FTMS Protocol**: [Bluetooth SIG Fitness Machine Service Specification](https://www.bluetooth.com/specifications/specs/fitness-machine-service-1-0/)
- **Treningsøkt-inspirasjoner**: Couch to 5K, Tabata, Maffetone, Jack Daniels Running Formula
- **Design-inspirasjon**: Apple Fitness+, Strava, Zwift

## ⚠️ Ansvarsfraskrivelse

Dette er et hobbyprosjekt for personlig bruk. Bruk på eget ansvar. Konsulter lege før du starter et nytt treningsprogram.

---

**Laget med ❤️ for løpere som elsker tech**
