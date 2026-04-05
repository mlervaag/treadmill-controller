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
- **Automatisk BLE-reconnect**: Kobler til igjen automatisk ved frakobling (eksponentiell backoff, maks 5 forsøk)
- **Drift-deteksjon**: Sender BLE-kommandoer på nytt hvis faktisk != mål

### 💪 Treningsøkter
- **39 profesjonelle treningsøkter** fordelt på 3 nivåer:
  - **Beginner (23)**: Couch to 5K (9 uker), Steady State, Standard intervaller, Motbakke intro
  - **Intermediate (9)**: VO2max 5x3, Threshold 2x10, Tempo 20 min, Hill Repeats, Pyramide
  - **Advanced (9)**: VO2max 6x4, Speed 400m x12, Threshold 3x12, Hill Sprints, Long Runs, MaxHR Test
- **Målsoner**: Alle templates har anbefalte HR-soner per segment for coaching
- **Egendefinerte økter**: Lag og rediger dine egne treningsøkter med flere segmenter
- **Automatisk kjøring**: Appen styrer hastighet og stigning automatisk gjennom segmentene
- **Lydvarsler**: Pip ved segmentbytte, stigende tone ved fullført økt (Web Audio API)
- **Smart filtrering**: Søk på difficulty, tags (c25k, vo2max, threshold, etc.) og varighet
- **Auto-stopp**: Når tredemøllen stoppes fysisk, avsluttes økten automatisk uten bekreftelse

### 🎙️ TTS-coaching
- **Talecoach**: Norsk stemme (OpenAI TTS) som gir informativ og adaptiv feedback under trening
- **Triggere**:
  - **Segment-overganger**: "Nytt segment: Intervall. 10 kilometer i timen, 3 prosent stigning, 5 minutter. Målsone er 4."
  - **Sone-avvik**: "Pulsen din har vært i sone 4 i 2 minutter. Målsonen er 3, vurder å senke farten." (etter 60 sekunder utenfor målsone)
  - **Milepæler**: "Halvveis! 10 minutter igjen.", "Du har løpt 2 kilometer.", "Ett minutt igjen."
- **Brukerprofiler**: Lettvekts profilliste med navn og maks hjertefrekvens, inline-redigering
- **Standard 5-soner**: Basert på prosent av maxHR (sone 1: <60%, sone 2: 60-70%, sone 3: 70-80%, sone 4: 80-90%, sone 5: 90-100%)
- **Avspilling**: Valgbart i view.html — "Denne enheten" (iPhone/headset), "Tredemølle" (A2DP-høyttalere), eller "Begge"
- **Aggressiv caching**: SHA256-hash av tekst → mp3 på disk (~10-50 KB). Cache hit på 1ms, API-kall ~2s
- **Graceful degradation**: Fungerer uten OpenAI API-nøkkel — viser tekst-toast i stedet for lyd
- **MaxHR-test**: Egen progressiv template for å finne maks hjertefrekvens (4→14 km/t + stigning)

### 📊 Historikk & Statistikk
- **Tre visninger**: Oversikt, Økter, og Trender
- **Total statistikk**: Samlet distanse, tid, kalorier og antall økter
- **Personlige rekorder**: Beste pace, lengste distanse, lengste økt, flest kalorier
- **Gjennomsnitt per økt**: Automatisk beregning av gjennomsnittsverdier
- **Treningsdata-graf**: Interaktiv graf med fart, puls og stigning over tid (Chart.js)
- **Datofilter**: Filtrer økter etter tidsperiode (7 dager, denne mnd, 3 mnd, egendefinert)
- **Per-segment feedback**: Se gjennomsnittsfart, puls og tid per segment etter fullført økt
- **Eksport**: Last ned øktdata som JSON, CSV eller TCX
- **Slett økter**: Fjern testøkter fra historikken

### 🔶 Strava-integrasjon
- **OAuth 2.0**: Koble til Strava-kontoen din direkte fra appen
- **Manuell opplasting**: Last opp enkeltøkter til Strava med ett klikk
- **Automatisk opplasting**: Aktiver auto-sync for å laste opp automatisk etter hver økt
- **TCX-format**: Genererer komplett TCX med hastighet, puls, distanse og tid
- **Duplicate-beskyttelse**: Bruker `external_id` for å unngå duplikater
- **Token refresh**: Automatisk fornyelse av utløpte tokens

> **Merk**: Strava API støtter ikke å sette aktivitetsprivacy. Sett "Default Activity Privacy" til "Only You" i Strava-innstillingene for private økter.

### ❤️ Pulsmåling & HR-soner
- **FTMS puls-støtte**: Mottar pulsdata fra FTMS-protokollen
- **Separat pulsbelte**: Koble til Bluetooth-pulsbelte (f.eks. Polar H10) for bedre nøyaktighet
- **Smart visning**: Skjuler pulsvisning automatisk når ingen gyldig puls er tilgjengelig
- **Gjennomsnittspuls**: Beregner gjennomsnitt kun fra gyldige målinger
- **5 HR-soner**: Automatisk soneberegning basert på brukerprofils maks hjertefrekvens
- **Flerbruker**: Lettvekts profiler med navn + maxHR, velges ved økt-start

### 📱 Mobil, Tablet & iPad
- **Fullt responsiv**: Optimalisert for mobil, tablet (iPad) og desktop
- **Fjernkontroll + dashboard** (`/view.html`): Sanntidsvisning og kontroll for iPad/iPhone
  - Mottar data via WebSocket fra kontrollpanelet
  - Viser hastighet, stigning, puls, distanse, tid, kalorier
  - HR-sone-farger basert på brukerprofils maks puls
  - **TTS-coaching**: Profilvelger, coach-toggle, lyd-mål (enhet/tredemølle/begge)
  - Last inn og start økter direkte fra telefonen
  - Tilkoblingsstatus med feilmelding
- **PWA-støtte**: Installerbar som app med offline-støtte (Service Worker)
- **Apple Web App**: Fungerer som standalone app på iOS/iPadOS
- **Touch-optimalisert**: Store knapper (min 44x44px), bedre spacing

### 🔒 Sikkerhet & Personvern
- **100% lokal**: Kjører kun lokalt på ditt hjemmenettverk
- **Ingen cloud**: Ingen data sendes til eksterne servere (unntatt valgfri Strava-sync)
- **Lokal database**: Alt lagres i SQLite på din maskin
- **Web Bluetooth sikkerhet**: Krever brukerinteraksjon for tilkobling
- **HTTPS**: Selvgenerert SSL-sertifikat for sikker kommunikasjon

## 📋 Forutsetninger

### Nødvendig
- **Node.js** versjon 14 eller nyere
- **Tredemølle** med Bluetooth FTMS-støtte (f.eks. Ronning x27 Pro, kompatibel med Zwift/Kinomap)

### Støttede plattformer
| Plattform | Nettleser | Web Bluetooth | Status |
|-----------|-----------|---------------|--------|
| **Windows** | Chrome, Edge, Opera | ✅ | Full kontroll |
| **macOS** | Chrome, Edge, Opera | ✅ | Full kontroll |
| **Linux** | Chrome, Edge, Opera | ✅ | Full kontroll |
| **Android** | Chrome, Edge, Opera | ✅ | Full kontroll |
| **Chrome OS** | Chrome | ✅ | Full kontroll |
| **iOS/iPadOS** | Safari, Chrome | ❌ | Bruk `/view.html` for sanntidsvisning* |

*iOS støtter ikke Web Bluetooth API. Bruk view-only dashboard (`/view.html`) for å se sanntidsdata fra en aktiv økt. Kontroll og historikk er tilgjengelig via nettleser.

## 🚀 Installasjon

### Enkel installasjon (Anbefalt for de fleste)

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

### Raspberry Pi deployment (produksjon)

<details>
<summary><strong>Vis Raspberry Pi installasjon</strong></summary>

#### Forutsetninger
- Raspberry Pi med Docker installert
- SSH-tilgang til Raspberry Pi

#### Installasjon
1. **Klon på Pi eller kopier filer**:
```bash
# Fra Windows:
scp -r . pi@192.168.1.12:~/treadmill-controller/
```

2. **Generer SSL-sertifikat** (nødvendig for Web Bluetooth):
```bash
ssh pi@192.168.1.12
cd ~/treadmill-controller
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -nodes -out certs/server.crt -keyout certs/server.key -days 365
```

3. **Opprett .env fil** (valgfritt, for Strava):
```bash
cp .env.example .env
# Rediger med dine Strava API-nøkler
```

4. **Start med Docker**:
```bash
docker compose build
docker compose up -d
```

5. **Åpne i nettleser**:
- PC: `https://192.168.1.12:3001` — Full Bluetooth-kontroll
- iPad/iPhone: `https://192.168.1.12:3001/view.html` — Sanntidsvisning
- Godta sertifikatadvarsel første gang

</details>

### Strava-oppsett (valgfritt)

<details>
<summary><strong>Vis Strava-konfigurasjon</strong></summary>

1. Gå til [Strava API Settings](https://www.strava.com/settings/api)
2. Opprett en ny app med disse innstillingene:
   - **Application Name**: Treadmill Controller
   - **Category**: Training
   - **Authorization Callback Domain**: `192.168.1.12` (din Pi's IP)
3. Kopier `Client ID` og `Client Secret`
4. Opprett `.env`-fil:
```bash
STRAVA_CLIENT_ID=din_client_id
STRAVA_CLIENT_SECRET=din_client_secret
APP_URL=https://192.168.1.12:3001
```
5. Restart Docker: `docker compose build && docker rm -f treadmill-controller; docker compose up -d`
6. Klikk "Koble til Strava" i Historikk-fanen

**Privacy-tips**: Strava API støtter ikke å sette aktivitetsprivacy. Sett "Default Activity Privacy" til "Only You" i Strava → Settings → Privacy Controls.

</details>

## 🎯 Bruk

### Lokal bruk
1. **Start serveren**: `npm start`
2. **Åpne appen**: `http://localhost:3001` i Chrome/Edge/Opera
3. **Koble til**: Klikk "Koble til Tredemølle" og velg din tredemølle
4. **Tren!**: Du er klar til å kjøre

### Multi-enhet (Raspberry Pi)
- **PC med Bluetooth**: `https://192.168.1.12:3001` — Kontroller tredemøllen
- **iPad/iPhone**: `https://192.168.1.12:3001/view.html` — Se sanntidsdata
- **Android**: `https://192.168.1.12:3001` — Full kontroll

### View-only Dashboard (iPad/iPhone)
For enheter uten Web Bluetooth-støtte:
1. Åpne `https://192.168.1.12:3001` i Safari og godta sertifikatet
2. Gå til `https://192.168.1.12:3001/view.html`
3. Tilkoblingsstatus:
   - 🟢 **Tilkoblet** — WebSocket fungerer, venter på aktiv økt
   - 🟡 **Kobler til...** — Prøver å koble til serveren
   - 🔴 **Frakoblet** — Sjekk at sertifikatet er godkjent i nettleseren

### Treningsøkter
1. **Velg mal**: Gå til "Treningsøkter" → velg fra 38 profesjonelle maler
2. **Lag din egen**: Klikk "+ Ny Økt" og definer segmenter
3. **Rediger**: Klikk "Rediger" på egendefinerte økter for å endre
4. **Start**: Klikk "Last økt" på en mal, deretter "Start" i Kontroll-fanen
5. **Lydvarsler**: Appen piper ved segmentbytte og spiller en melodi ved fullføring

### Historikk & Eksport
- **Graf**: Klikk "📊 Graf" for å se fart/puls over tid
- **Eksport**: JSON, CSV eller TCX per økt
- **Strava**: Klikk "🔶 Strava" for å laste opp enkeltøkter
- **Segmenter**: Se detaljert feedback per segment

## 📁 Prosjektstruktur

```
treadmill-controller/
├── server.js                  # Express server (~1500 linjer): API, WebSocket, Strava, TTS coaching
├── coaching-engine.js         # HR-soner, trigger-evaluering, norske meldinger
├── tts-service.js             # OpenAI TTS API, SHA256-caching, A2DP-avspilling
├── package.json               # npm konfigurasjon
├── templates.json             # 39 treningsøkter med target_max_zone
├── migrate.js                 # Database migrations (ALTER TABLE)
├── deploy-to-pi.sh            # Bash deploy-skript for Raspberry Pi
├── Dockerfile                 # Docker container build
├── docker-compose.yml         # Docker Compose med volumes og env
├── .env.example               # Miljøvariabel-mal
├── LICENSE                    # ISC lisens
├── CLAUDE.md                  # AI-instrukser for Claude Code
├── .cursorrules               # AI-instrukser for Cursor
├── .windsurfrules             # AI-instrukser for Windsurf
├── .github/
│   └── copilot-instructions.md # AI-instrukser for GitHub Copilot
├── STRAVA_INTEGRATION.md      # Teknisk Strava-dokumentasjon
├── ROADMAP.md                 # Planlagte funksjoner og veikart
├── data/                      # Database (git-ignored)
│   └── treadmill.db           # SQLite database
├── tts-cache/                 # Cachede TTS-lydfiler (git-ignored)
├── certs/                     # SSL-sertifikater (git-ignored)
│   ├── server.key
│   └── server.crt
├── docs/                      # Brukerveiledninger
│   ├── HOME_USAGE_GUIDE.md    # Komplett bruksanvisning
│   ├── WEB_BLUETOOTH_SETUP.md # Web Bluetooth oppsettguide
│   └── RASPBERRY_PI_SETUP.md  # Raspberry Pi deployment guide
├── scripts/                   # Hjelpeskript (PowerShell)
│   ├── deploy-to-pi.ps1       # Deploy til Raspberry Pi
│   ├── enable-https.ps1       # Aktiver HTTPS-sertifikater
│   ├── start-server.ps1       # Start serveren
│   ├── stop-server.ps1        # Stopp serveren
│   ├── backup-database.ps1    # Sikkerhetskopier database
│   └── restore-database.ps1   # Gjenopprett database fra backup
└── public/                    # Frontend
    ├── index.html             # Hovedside med full UI
    ├── style.css              # Responsiv dark-theme styling
    ├── app.js                 # Frontend logikk (~3000 linjer)
    ├── ftms.js                # FTMS Bluetooth-protokoll
    ├── hrm.js                 # Heart Rate Monitor Bluetooth
    ├── view.html              # View-only dashboard for iPad/iPhone
    ├── manifest.json          # PWA manifest
    └── sw.js                  # Service Worker for offline
```

## 🗃️ Database Schema

### `workouts`
```sql
id, name, description, difficulty, is_template, tags, target_max_zone, created_at
```

### `workout_segments`
```sql
id, workout_id, segment_order, duration_seconds, speed_kmh, incline_percent, segment_name, target_max_zone
```

### `workout_sessions`
```sql
id, workout_id, started_at, completed_at, total_distance_km, total_time_seconds,
avg_heart_rate, calories_burned, heart_rate_source, strava_activity_id, strava_upload_status, profile_id
```

### `session_data`
```sql
id, session_id, timestamp, speed_kmh, incline_percent, distance_km, heart_rate, segment_index
```

### `user_profiles`
```sql
id, name (UNIQUE), max_hr, created_at
```

### `strava_auth`
```sql
id, athlete_id (UNIQUE), access_token, refresh_token, expires_at, scope, athlete_name, connected_at
```

## 🔌 API Endepunkter

### Workouts
| Metode | Endepunkt | Beskrivelse |
|--------|-----------|-------------|
| GET | `/api/workouts` | Hent alle treningsøkter |
| GET | `/api/workouts/templates` | Hent kun maler |
| GET | `/api/workouts/:id` | Hent spesifikk økt med segmenter |
| POST | `/api/workouts` | Opprett ny treningsøkt |
| PUT | `/api/workouts/:id` | Oppdater treningsøkt |
| DELETE | `/api/workouts/:id` | Slett treningsøkt |

### Profiles
| Metode | Endepunkt | Beskrivelse |
|--------|-----------|-------------|
| GET | `/api/profiles` | Hent alle brukerprofiler |
| GET | `/api/profiles/:id` | Hent spesifikk profil |
| POST | `/api/profiles` | Opprett ny profil `{ name, max_hr }` |
| PUT | `/api/profiles/:id` | Oppdater profil |
| DELETE | `/api/profiles/:id` | Slett profil |

### Sessions
| Metode | Endepunkt | Beskrivelse |
|--------|-----------|-------------|
| GET | `/api/sessions?startDate=&endDate=` | Hent historikk (med datofilter) |
| GET | `/api/sessions/:id/details` | Hent økt med alle datapunkter |
| GET | `/api/sessions/:id/segments` | Per-segment feedback |
| GET | `/api/sessions/:id/export/json` | Eksporter som JSON |
| GET | `/api/sessions/:id/export/csv` | Eksporter som CSV |
| GET | `/api/sessions/:id/export/tcx` | Eksporter som TCX |
| POST | `/api/sessions` | Start ny økt |
| PUT | `/api/sessions/:id` | Oppdater økt (avslutt) |
| POST | `/api/sessions/:id/data` | Registrer datapunkt |
| DELETE | `/api/sessions/:id` | Slett økt |

### Strava
| Metode | Endepunkt | Beskrivelse |
|--------|-----------|-------------|
| GET | `/auth/strava` | OAuth redirect til Strava |
| GET | `/auth/strava/callback` | OAuth callback |
| GET | `/api/strava/status` | Tilkoblingsstatus |
| DELETE | `/api/strava/disconnect` | Koble fra Strava |
| POST | `/api/strava/upload/:sessionId` | Last opp økt til Strava |

### Statistics
| Metode | Endepunkt | Beskrivelse |
|--------|-----------|-------------|
| GET | `/api/stats/overall` | Total statistikk, rekorder, gjennomsnitt |
| GET | `/api/stats/weekly` | Ukentlig statistikk (siste 12 uker) |
| GET | `/api/stats/monthly` | Månedlig statistikk (siste 12 måneder) |

## 🔧 FTMS (Fitness Machine Service)

Applikasjonen bruker Bluetooth Low Energy FTMS-standarden, samme som brukes av Zwift, Kinomap, Peloton, etc.

### UUID Referanse
```
FTMS Service:         00001826-0000-1000-8000-00805f9b34fb
Treadmill Data:       00002acd-0000-1000-8000-00805f9b34fb
Control Point:        00002ad9-0000-1000-8000-00805f9b34fb
Machine Status:       00002ada-0000-1000-8000-00805f9b34fb
Heart Rate Service:   0000180d-0000-1000-8000-00805f9b34fb
```

## 🔍 Feilsøking

### Tredemølle vises ikke i Bluetooth-dialogen
- ✅ Sørg for at tredemøllen er slått på og Bluetooth aktivert
- ✅ Sjekk at tredemøllen ikke er koblet til annen enhet/app
- ✅ Prøv "Scan alle enheter"-knappen

### Web Bluetooth fungerer ikke
- ❌ Safari/Firefox støtter ikke Web Bluetooth
- ❌ iOS støtter ikke Web Bluetooth — bruk `/view.html` i stedet
- ✅ **Lokal bruk**: `http://localhost:3001`
- ✅ **Raspberry Pi**: `https://PI-IP:3001` med HTTPS

### View dashboard viser "Frakoblet"
- ✅ Åpne `https://PI-IP:3001` i Safari først og godta sertifikatet
- ✅ Deretter åpne `https://PI-IP:3001/view.html`
- ✅ Sjekk at det er en aktiv økt på kontroll-PCen

### Strava-opplasting feiler
- ✅ Sjekk at Strava er koblet til (grønt i Historikk-fanen)
- ✅ Økten må ha datapunkter (tomme økter kan ikke lastes opp)
- ✅ Sjekk at `.env` har riktig `STRAVA_CLIENT_ID` og `STRAVA_CLIENT_SECRET`
- ✅ Sjekk at "Authorization Callback Domain" i Strava er satt til Pi-ens IP

## 🎨 Teknologi Stack

- **Backend**: Node.js, Express 5, WebSocket (ws), better-sqlite3
- **Frontend**: Vanilla JavaScript (ES6+), HTML5, CSS3, Chart.js 4
- **Bluetooth**: Web Bluetooth API (BLE), Bluetooth Classic (A2DP), FTMS Protocol, Heart Rate Service
- **TTS Coaching**: OpenAI TTS API (`tts-1`), norsk stemme, SHA256-filcaching, AudioContext (iOS)
- **Integrasjoner**: Strava API v3 (OAuth 2.0, TCX upload)
- **Infrastruktur**: Docker, Raspberry Pi, PulseAudio (A2DP), HTTPS (self-signed)
- **PWA**: Service Worker, Web App Manifest
- **Lyd**: Web Audio API (varsler), AudioContext (TTS), A2DP (tredemølle-høyttalere)
- **Design**: Responsive, Mobile-first, Dark theme

## 📚 Dokumentasjon

- **[HOME_USAGE_GUIDE.md](docs/HOME_USAGE_GUIDE.md)** — Komplett bruksanvisning for daglig bruk
- **[WEB_BLUETOOTH_SETUP.md](docs/WEB_BLUETOOTH_SETUP.md)** — Guide for å sette opp Web Bluetooth
- **[RASPBERRY_PI_SETUP.md](docs/RASPBERRY_PI_SETUP.md)** — Raspberry Pi deployment og drift
- **[STRAVA_INTEGRATION.md](STRAVA_INTEGRATION.md)** — Teknisk dokumentasjon for Strava-integrasjonen
- **[ROADMAP.md](ROADMAP.md)** — Planlagte funksjoner og fremtidig utvikling
- **[CLAUDE.md](CLAUDE.md)** — AI-instrukser for Claude Code
- **[.cursorrules](.cursorrules)** — AI-instrukser for Cursor
- **[.windsurfrules](.windsurfrules)** — AI-instrukser for Windsurf
- **[copilot-instructions.md](.github/copilot-instructions.md)** — AI-instrukser for GitHub Copilot

## 🛠️ Hjelpeskript

PowerShell-skript i `scripts/`-mappen for vanlige oppgaver:

| Skript | Beskrivelse |
|--------|-------------|
| `deploy-to-pi.ps1` | Deploy applikasjonen til Raspberry Pi |
| `enable-https.ps1` | Generer og aktiver SSL-sertifikater |
| `start-server.ps1` | Start serveren lokalt |
| `stop-server.ps1` | Stopp serveren |
| `backup-database.ps1` | Ta backup av databasen |
| `restore-database.ps1` | Gjenopprett database fra backup |

## 🗺️ Veikart

Se [ROADMAP.md](ROADMAP.md) for komplett veikart. Oppsummering:

### ✅ Implementert
- Strava-integrasjon (OAuth, TCX-opplasting, auto-sync)
- Treningsdata-graf (Chart.js med fart/puls/stigning)
- Lydvarsler (segmentbytte, fullføring)
- Eksport (JSON, CSV, TCX)
- Datofilter for historikk
- Workout-redigering
- Auto BLE-reconnect
- Per-segment feedback
- PWA med offline-støtte
- Fjernkontroll + dashboard for iPad/iPhone
- TTS-coaching med OpenAI (norsk stemme, segment/sone/milepæl-triggere)
- HR-soner med brukerprofiler (5-soner basert på maxHR)
- Flerbruker-støtte (lettvekts profiler med navn + maxHR)
- Målsoner på alle 39 templates
- MaxHR-test-økt
- A2DP-lydavspilling til tredemølle-høyttalere

### 🔜 Planlagt
- **Workout Builder** — Visuell drag-and-drop segment-creator
- **Avansert Analyse** — Treningsbelastning (TSS/TRIMP), fitness-trender
- **Sone-statistikk** — Tid i hver sone per økt, sone-progresjon over tid
- **Periodiske oppsummeringer** — TTS hvert 5. minutt med snitt-puls, distanse, tempo
- **Økt-oppsummering** — Talt oppsummering ved økt-slutt

## 📄 Lisens

ISC License — se [LICENSE](LICENSE) for detaljer.

## 🙏 Anerkjennelser

- [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) for trådløs tredemøllekontroll
- [FTMS-standarden](https://www.bluetooth.com/specifications/specs/fitness-machine-service-1-0/) for Bluetooth fitness-maskin-kommunikasjon
- [Chart.js](https://www.chartjs.org/) for interaktive grafer
- [Strava API v3](https://developers.strava.com/) for treningssynkronisering

## ⚠️ Ansvarsfraskrivelse

Denne applikasjonen kontrollerer fysisk treningsutstyr. Bruk på eget ansvar. Sørg alltid for at du har kontroll over tredemøllen og at nødstoppfunksjonen er tilgjengelig. Forfatteren er ikke ansvarlig for skader eller uhell som følge av bruk av denne programvaren.

---

**Laget med ❤️ for løpere som elsker tech**
