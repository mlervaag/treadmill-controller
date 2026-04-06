# Design: HR-sonestyrt trening (automatisk fart/stigningsjustering)

**Dato:** 2026-04-06
**Status:** Utkast — revidert etter subagent-review
**Bygger på:** `docs/future/hr-zone-controlled-training.md` (tidlig skisse)

## Sammendrag

Tredemøllen justerer automatisk fart (eller stigning) for å holde løperen i en bestemt HR-sone. Kontroll-loopen kjører server-side på RPi-en i `ble-service.js` for robusthet — uavhengig av nettleser eller iPad-tilkobling. Brukeren kan toggle sonestyring av/på per økt, og økter som er egnet for sonestyring markeres automatisk med en heuristikk.

**Bevisst scope-avgrensning:** Kontrolleren styrer enten fart ELLER stigning per segment, aldri begge samtidig. Originalskissen nevnte "begge" som et alternativ, men dette er kuttet for enkelhet — to variabler gjør kontrollalgoritmen mye vanskeligere å tune.

## Beslutninger fra brainstorming

| Spørsmål | Beslutning | Begrunnelse |
|----------|-----------|-------------|
| Hvor kjører kontroll-loopen? | **Server-side (RPi)** — i `ble-service.js` | Robusthet: RPi har native BLE til HRM + mølle, overlever browser-refresh, og åpner for fremtidig AI-integrasjon |
| Fart eller stigning? | **Per-segment konfigurasjon** | Noen segmenter styrer fart (flatt), andre styrer stigning (bakkeøkter). Feltet `hr_zone_control_mode` på segmentet bestemmer |
| Manuell overstyring? | **Pause kontrolleren 45s**, gjenoppta fra ny verdi | Puls trenger tid til å stabilisere |
| HRM-frakobling? | **Hold siste fart, varsle via TTS, sone-avhengig timeout** | HRM-frakoblinger er ofte kortvarige. Timeout 2 min for sone 1-3, 60s for sone 4-5 |
| Start uten HRM? | **Pre-flight sjekk blokkerer start** | Sonestyrt trening uten pulsdata er meningsløst |
| Toggle per økt? | **Ja — bruker velger ved start** | Selv en egnet økt kan kjøres uten sonestyring noen dager |
| Egnet-markering? | **Heuristikk beregnet ved template-sync + filter i UI** | Dobbel nytte: filter i øktliste + pre-flight-sjekk |

## Arkitektur

### Nye komponenter

```
ble-service/
  hr-zone-controller.js    ← NY: kontroll-loop klasse
  hr-utils.js              ← NY: delt getZone()-funksjon (brukes av både controller og coaching-engine)

server.js                  ← ENDRING: nytt DB-felt, heuristikk, API-utvidelse, INSERT-oppdateringer
coaching-engine.js         ← ENDRING: bruk hr-utils.js, suppress zone-violation under sonestyring
templates.json             ← ENDRING: nye templates + hr_zone_control-felt
ble-service/ble-service.js ← ENDRING: integrerer HRZoneController i executeSegment(), nye kommandoer
public/view.html           ← ENDRING: toggle, filter, sonestyrt-indikator, manuell speed/incline-knapper
public/app.js              ← ENDRING: filter, toggle, historikk-info
```

### Viktige integrasjonshensyn (fra review)

1. **`CoachingEngine.getZone()` utilgjengelig fra ble-service** — ble-service er en separat Node.js-prosess utenfor Docker. Løsning: ekstraher soneberegning til `ble-service/hr-utils.js` som importeres av hr-zone-controller.js. `coaching-engine.js` oppdateres til å bruke samme modul (kopieres/symlinkes ved deploy).

2. **`set_speed`/`set_incline` kommandoer eksisterer ikke** — ble-service har i dag ingen handler for manuell farts-/stigningsjustering via WebSocket. Disse må implementeres som nye kommandoer i `handleServerMessage()`. View.html har i dag heller ikke manuelle justeringsknapper under aktiv økt — disse må legges til.

3. **Drift detection vil overskrive kontrollerens justeringer** — drift detection i ble-service.js (linje 941-984) sammenligner `currentTargetSpeed` med faktisk fart hvert 8. sekund. Løsning: HRZoneController oppdaterer `currentTargetSpeed`/`currentTargetIncline` ved hver justering, slik at drift detection "samarbeider" med kontrolleren.

4. **`profile_id` ikke videresendt i handleStartSession()** — `handleStartSession()` (linje 726-734) ignorerer `params.profileId`. Må oppdateres til å sende `profile_id` til server API, og hente `maxHR` fra server (GET /api/profiles/:id) for å gi til HRZoneController.

5. **Zone violation TTS vil dobbel-fyre** — `coaching-engine.js` trigger 2 (linje 84-126) genererer egne TTS-meldinger når brukeren er utenfor målsone. Under sonestyring er kontrolleren aktivt i gang med å korrigere — da skal coaching engine *ikke* også varsle om sonevarsler. Løsning: legg til `hrZoneControlActive`-flagg på state, og la coaching engine skippe trigger 2 når flagget er satt.

6. **API INSERT-statements mangler nye kolonner** — `POST /api/workouts` og `PUT /api/workouts/:id` i server.js inserter i `workout_segments` uten de nye kolonnene. Må oppdateres.

7. **app.js har egen `executeSegment()`** — browser-basert kontrolleren i app.js har sin egen `executeSegment()` (linje 1673). Denne brukes når index.html er kontrolleren (ikke ble-service). For MVP: sonestyring er kun tilgjengelig via native BLE-service (RPi). App.js sin executeSegment() trenger ikke endres i fase 1, men bør markeres som "ikke sonestyrt-klar" i koden.

### Dataflyt

```
HRM (BLE) → hrm-native.js → getCurrentHeartRate()
                                    ↓
                          HRZoneController.tick() (hvert sekund, justerer hvert 20. sekund)
                                    ↓
                          Beregn glidende snitt (siste 15 målinger)
                          Filtrer outliers (>15 BPM avvik)
                          Finn sone med hysterese → sammenlign med målsone
                                    ↓
                          Juster fart/stigning → ftms.setSpeed() / ftms.setIncline()
                          Oppdater currentTargetSpeed/currentTargetIncline
                                    ↓
                          State broadcast → server.js → view.html
                                    ↓
                          CoachingEngine → TTS (kun sonestyrt-meldinger, ikke zone-violation)
```

### Integrasjon med eksisterende flyt

`ble-service.js` sin `executeSegment()` (linje 861) er integrasjonspunktet:

```
executeSegment(index):
  segment = workout.segments[index]
  
  HVIS segment.hr_zone_control > 0 OG hrZoneControlEnabled:
    → Start HRZoneController med:
      - målsone = segment.target_max_zone
      - maxHR = profildata hentet ved session-start
      - kontrolltype = segment.hr_zone_control_mode ('speed' | 'incline')
      - startfart = segment.speed_kmh (brukes som utgangspunkt)
      - startstigning = segment.incline_percent
      - minFart / maksFart grenser
      - ringbuffer = arv fra forrige segment hvis også sonestyrt, ellers ny
    → Kontrolleren overtar: oppdaterer currentTargetSpeed ved justeringer
    → Segment-timer tikker fortsatt som normalt
    
  ELLERS:
    → Eksisterende logikk (fast fart/stigning)
    → Stopp eventuell aktiv HRZoneController
    
  Ved segment-overgang:
    → Hvis neste segment også er sonestyrt: behold ringbuffer
    → Ellers: stopp kontrolleren
```

## HRZoneController — detaljert design

### Klasse-API

```javascript
class HRZoneController {
  constructor({
    targetZone,        // 1-5
    maxHR,             // brukerens maxHR
    controlMode,       // 'speed' | 'incline'
    initialSpeed,      // startfart fra segment (km/h)
    initialIncline,    // startstigning fra segment (%)
    minSpeed,          // minimum tillatt fart (default 3.0 km/h)
    maxSpeed,          // maks tillatt fart (default 14.0 km/h)
    minIncline,        // minimum stigning (default 0%)
    maxIncline,        // maks stigning (default 12%)
    onSpeedChange,     // callback(newSpeed) → kaller ftms.setSpeed() + oppdaterer currentTargetSpeed
    onInclineChange,   // callback(newIncline) → kaller ftms.setIncline() + oppdaterer currentTargetIncline
    onStatusChange,    // callback({ action, fromValue, toValue, reason })
    existingBuffer,    // optional: ringbuffer fra forrige sonestyrt segment
  })

  tick(currentHR)     // Kalles hvert sekund med fersk HR-verdi fra hrm.getCurrentHeartRate()
  pause(durationMs)   // Pause kontrolleren (manuell overstyring)
  resume()            // Gjenoppta (kalles automatisk etter pause-timeout)
  updateBaseline(speed, incline)  // Sett ny baseline etter manuell override
  getState()          // { active, paused, pauseRemaining, currentSpeed, currentIncline, avgHR, currentZone, targetZone, adjustmentCount, lastAction }
  getRingBuffer()     // Returner ringbuffer for overføring til neste segment
  stop()              // Avslutt kontrolleren
}
```

### Kontroll-algoritme

```
TICK (kalles hvert sekund med fersk HR):
  1. Outlier-filter: ignorer HR hvis |HR - forrigeHR| > 15 BPM (med mindre 3 påfølgende bekrefter)
  2. Ignorer HR < 50 BPM eller < 40% maxHR (sensor-feil)
  3. Legg filtrert HR til ringbuffer (size 15)
  4. Hvis paused → dekrementér pauseteller, return
  5. Hvis ringbuffer < 8 gyldige målinger → return (vent på nok data)
  6. Hvert 20. sekund (adjustInterval), ELLER etter retningsskifte-cooldown (30s ekstra):
     a. Beregn glidende snitt av ringbuffer
     b. Beregn HR som prosent av maxHR
     c. Finn målsone-grenser: nedre = zoneLow, øvre = zoneHigh
        (Sone 3 eksempel: nedre=70%, øvre=80%)
     d. Anvend hysterese: +2% maxHR for overgang OPP, -0% for overgang NED
        (Dvs. for å trigge "over sone 3", kreves HR > 82% maxHR, ikke 80%)
     
     HVIS avgHR% > zoneHigh + 2% (over målsone med hysterese):
       soneAvvik = antall hele soner over
       stepSize = 0.2 + (soneAvvik - 1) * 0.15    // 1 sone: 0.2, 2 soner: 0.35
       stepSize = min(stepSize, 0.5)               // maks 0.5 km/h per justering
       akkumulertEndring += stepSize
       HVIS akkumulertEndring > 0.8 → pause 30s (vent på pulsrespons)
       IF controlMode == 'speed':
         nyFart = currentSpeed - stepSize
         nyFart = max(nyFart, minSpeed)
         onSpeedChange(nyFart) → ftms.setSpeed() + currentTargetSpeed = nyFart
       ELSE:  // 'incline'
         nyStigning = currentIncline - 0.5         // 0.5% per steg ned
         nyStigning = max(nyStigning, minIncline)
         onInclineChange(nyStigning)
     
     HVIS avgHR% < zoneLow - 2% (2+ soner under mål):
       stepSize = 0.2 km/h / 0.5% stigning
       [samme logikk som over, men med akkumuleringsgrense]
       
     HVIS avgHR% mellom zoneLow og zoneLow - 2% (1 sone under mål):
       stepSize = 0.1 km/h / 0.25% stigning (halv hastighet)
       adjustInterval = 30s i stedet for 20s (dobbel ventetid)
       [forsiktig nudge oppover]
     
     HVIS avgHR% mellom zoneLow og zoneHigh+2%:
       // I målsone (med hysterese) — ingen justering
       reset akkumulertEndring = 0
       
  7. Logg justering via onStatusChange for TTS/UI
  
  RETNINGSSKIFTE-COOLDOWN:
    Hvis kontrolleren bytter fra "senk" til "øk" (eller omvendt):
    → Tvungen 30s pause før neste justering
    → Forhindrer oscillering rundt sonegrenser
```

### Nøkkelparametere

| Parameter | Verdi | Begrunnelse |
|-----------|-------|-------------|
| `adjustInterval` | 20 sekunder | Puls responderer med 30-60s forsinkelse. 20s gir 1.5-3 justeringer per respons-syklus — reduserer akkumulering og oscillering vs. 10s |
| `ringBufferSize` | 15 målinger | 15 sekunder med data gir bedre glatting enn 10 |
| `minDataPoints` | 8 | Ikke juster før vi har nok data for et pålitelig snitt |
| `maxSpeedStepDown` | 0.5 km/h | Maks nedsenking per justering |
| `maxSpeedStepUp` | 0.2 km/h | Forsiktig opptrapping |
| `maxInclineStepDown` | 0.5% | Redusert fra 1.0% — 1% inkline ≈ 0.6-0.8 km/h fartsekvivalent, for aggressivt |
| `maxInclineStepUp` | 0.5% | Symmetrisk for stigning |
| `accumulationCap` | 0.8 km/h | Maks akkumulert endring i én retning før tvungen pause |
| `directionChangeCooldown` | 30 sekunder | Ekstra ventetid ved retningsskifte — forhindrer oscillering |
| `manualOverridePause` | 45 sekunder | Etter manuell justering — nok tid for puls å stabilisere |
| `graduatedResumeInterval` | 30 sekunder | De 2-3 første justeringene etter pause bruker 30s intervall i stedet for 20s |
| `hrmTimeoutMs` | 120000 (sone 1-3) / 60000 (sone 4-5) | Sone-avhengig timeout — høyere soner er mer risikable å holde blindt |
| `hrmPrecautionaryReduction` | 0.3 km/h etter 30s (kun sone 4-5) | Sikkerhetstiltak ved HRM-frakobling i høy-intensitetssoner |
| `outlierThreshold` | 15 BPM | Ignorer HR-spikes større enn dette |
| `minHRFloor` | max(50, maxHR * 0.4) | Ignorer urealistisk lave HR-verdier |

### Sikkerhet

1. **Krever HRM-tilkobling** ved start av sonestyrt økt — pre-flight sjekk i `handleStartSession()`
2. **Minimum fart 3.0 km/h** — aldri under gang-tempo
3. **Maksimum fart 14.0 km/h** — FTMS-grense
4. **Asymmetrisk justering** — nedsenking (0.2-0.5 km/h) er raskere enn opptrapping (0.1-0.2 km/h)
5. **HRM-frakobling** (sone-avhengig):
   - Umiddelbar: hold nåværende fart/stigning
   - TTS: "Mistet pulssignal, holder nåværende fart"
   - Sone 4-5: etter 30s uten signal → senk fart 0.3 km/h som sikkerhetstiltak
   - Sone 1-3: etter 2 min → TTS "Sonestyring deaktivert", konverter til fast fart
   - Sone 4-5: etter 60s → TTS "Sonestyring deaktivert", konverter til fast fart
   - HRM tilbake: TTS "Pulssignal gjenopprettet", gjenoppta kontrolleren
   - Skille mellom BLE-frakobling og dårlig kontakt (intermitterende nullverdier): krever 5+ påfølgende nullverdier før dropout-modus
6. **Abnorm puls (>95% maxHR)** i alle soner: tvungen nedsenking 0.5 km/h + TTS-advarsel. Gjelder alle soner, ikke bare 2-3.
7. **Vedvarende overbelastning**: HR 2+ soner over mål i 3+ minutter trass justeringer → aggressiv nedsenking til minimumsfart + TTS "Pulsen er vedvarende høy, vurderer å stoppe"
8. **Manuell overstyring**: pause kontrolleren 45s, gjenoppta fra brukerens nye verdi med gradert re-engasjement (30s intervall de første 2-3 tickene)
9. **FTMS kommandofeil**: hvis ftms.setSpeed() feiler (write-feil, timeout), logg feilen og prøv igjen på neste tick. Ikke endre intern state — kontrolleren prøver på nytt.

## Database-endringer

### Ny kolonne på `workout_segments`

```sql
ALTER TABLE workout_segments ADD COLUMN hr_zone_control INTEGER DEFAULT 0;
-- 0 = vanlig segment (fast fart/stigning)
-- 1 = sonestyrt segment (fart/stigning justeres automatisk)

ALTER TABLE workout_segments ADD COLUMN hr_zone_control_mode TEXT DEFAULT 'speed';
-- 'speed' = kontrolleren justerer fart, holder stigning fast
-- 'incline' = kontrolleren justerer stigning, holder fart fast
```

### Ny kolonne på `workouts`

```sql
ALTER TABLE workouts ADD COLUMN hr_zone_eligible INTEGER DEFAULT 0;
-- 0 = ikke egnet for sonestyring
-- 1 = egnet (beregnet av heuristikk, kan overstyres manuelt)
```

### Ny kolonne på `workout_sessions`

```sql
ALTER TABLE workout_sessions ADD COLUMN hr_zone_control_enabled INTEGER DEFAULT 0;
-- 0 = økten ble kjørt uten sonestyring
-- 1 = sonestyring var aktivert for denne økten
-- Nyttig for analyse: "var denne økten sonestyrt?"
```

### Migrering

Oppdater **både** `server.js` (try/catch ALTER TABLE) og `migrate.js` (PRAGMA table_info sjekk).

### API-oppdateringer

Følgende eksisterende endpoints må oppdateres til å inkludere nye kolonner:
- `POST /api/workouts` — INSERT i `workout_segments` må inkludere `hr_zone_control`, `hr_zone_control_mode`
- `PUT /api/workouts/:id` — tilsvarende for segment-oppdatering
- `POST /api/sessions` — INSERT i `workout_sessions` må inkludere `hr_zone_control_enabled`
- `GET /api/workouts` — inkluder `hr_zone_eligible` i response

## Heuristikk for `hr_zone_eligible`

Beregnes ved template-sync (server oppstart) og ved lagring av egendefinerte økter:

```javascript
function calculateHRZoneEligible(segments) {
  return segments.some(seg => 
    seg.target_max_zone && 
    seg.target_max_zone > 0 &&
    seg.duration_seconds >= 180
  ) ? 1 : 0;
}
```

**Regler:**
- Minst ett segment med `target_max_zone` satt OG varighet >= 180s (3 min)
- Oppvarming/nedkjøling teller med (de kan teknisk sett sonestyres, men brukeren velger via toggle)
- Kan overstyres manuelt i workout-editoren
- Ved session-start: valider at minst ett segment har `hr_zone_control = 1` hvis toggle er på. Hvis ikke → kjør som vanlig økt uten sonestyring (silent fallthrough).

### Per-segment auto-markering

Når en økt opprettes/synces, markeres segmenter automatisk:

```javascript
function autoMarkSegments(segments) {
  return segments.map(seg => ({
    ...seg,
    hr_zone_control: (
      seg.target_max_zone && 
      seg.target_max_zone > 0 && 
      seg.duration_seconds >= 180
    ) ? 1 : 0,
    hr_zone_control_mode: seg.incline_percent > 2 ? 'incline' : 'speed'
  }));
}
```

**Logikk for `hr_zone_control_mode`:**
- Segment har stigning > 2% → `'incline'` (bakkeøkt: juster stigning). Terskel 2% fordi lavere stigning gir for lite justeringsrom.
- Segment har stigning <= 2% → `'speed'` (standard: juster fart)
- Kan overstyres per segment i workout-editoren

## Nye workout templates

Fem nye templates tagget med `hr-zone`, spesifikt designet for sonestyring:

### 1. Sone 2 Utholdenhet 45 min
```
Oppvarming: 5 min, 5.5 km/h, 0%, sone 2 — fast
Hoveddel:   35 min, 7.0 km/h (start), 0%, sone 2 — SONESTYRT fart
Nedkjøling: 5 min, 5.0 km/h, 0%, sone 1 — fast
Tags: hr-zone, endurance, long
Difficulty: beginner
```
*Startfart 7.0 km/h (ikke 8.0) — lavere for ekte nybegynnere som kan ha sone 2 ved gangfart.*

### 2. Sone 3 Tempo 30 min
```
Oppvarming: 5 min, 6.0 km/h, 0%, sone 2 — fast
Hoveddel:   20 min, 9.5 km/h (start), 0%, sone 3 — SONESTYRT fart
Nedkjøling: 5 min, 5.0 km/h, 0%, sone 1 — fast
Tags: hr-zone, tempo, medium
Difficulty: intermediate
```

### 3. Sone 4 Terskel 3x8 min
```
Oppvarming:    5 min, 6.0 km/h, 0%, sone 2 — fast
Arbeid 1:      8 min, 10.5 km/h (start), 0%, sone 4 — SONESTYRT fart
Aktiv hvile 1: 3 min, 6.5 km/h, 0%, sone 2 — fast
Arbeid 2:      8 min, 10.5 km/h (start), 0%, sone 4 — SONESTYRT fart
Aktiv hvile 2: 3 min, 6.5 km/h, 0%, sone 2 — fast
Arbeid 3:      8 min, 10.5 km/h (start), 0%, sone 4 — SONESTYRT fart
Nedkjøling:    5 min, 5.0 km/h, 0%, sone 1 — fast
Tags: hr-zone, threshold, interval
Difficulty: advanced
```

### 4. Progressiv Sonetrening 40 min
```
Oppvarming: 5 min, 5.5 km/h, 0%, sone 1 — fast
Sone 2:     10 min, 7.0 km/h (start), 0%, sone 2 — SONESTYRT fart
Sone 3:     10 min, 9.5 km/h (start), 0%, sone 3 — SONESTYRT fart
Sone 4:     10 min, 10.5 km/h (start), 0%, sone 4 — SONESTYRT fart
Nedkjøling: 5 min, 5.0 km/h, 0%, sone 1 — fast
Tags: hr-zone, progressive, endurance
Difficulty: intermediate
```

### 5. Sone 2 Bakketrening 35 min
```
Oppvarming: 5 min, 6.0 km/h, 0%, sone 1 — fast
Hoveddel:   25 min, 6.0 km/h, 4% (start), sone 2 — SONESTYRT stigning
Nedkjøling: 5 min, 5.0 km/h, 0%, sone 1 — fast
Tags: hr-zone, hill, incline, endurance
Difficulty: beginner
```

## Frontend-endringer

### view.html (iPad — hoveddashboard)

**Øktliste:**
- Nytt filter "Sonestyrt" i workout-velgeren — viser kun økter med `hr_zone_eligible = 1`
- Sonestyrt-egnede økter markeres med ikon/badge

**Øktstart (ready-state):**
- Toggle "Sonestyring" — vises kun for egnede økter
- Hvis toggle er på og HRM ikke tilkoblet → feilmelding, blokker start
- Toggle-valg sendes med i `start_session` WebSocket-melding

**Under aktiv økt:**
- Sonestyrt-indikator: "Sone 3 — Sonestyrt" med pulserende ikon
- Vis "Justerer fart..." midlertidig når kontrolleren endrer fart
- Vis nåværende kontrollert fart vs segment-startfart
- **NYE manuell-justeringsknapper** (+/- fart, +/- stigning) — sender `set_speed`/`set_incline`-kommando via WebSocket → trigger manuell override pause (45s)
- Indikator: "Sonestyring pauset (35s)" etter manuell override

### app.js / index.html (controller)

- Sonestyrt-filter i øktliste (samme som view.html)
- Sonestyrt-info i økt-detaljer (Historikk): vise om økten var sonestyrt
- Ved opprettelse av egendefinerte økter: toggle per segment for sonestyring
- **Fase 1: sonestyring kun via native BLE-service.** App.js sin `executeSegment()` endres ikke nå — sonestyrt-segmenter kjøres som faste segmenter i browser-modus. Kommentar i koden markerer dette.

## Nye WebSocket-kommandoer (ble-service.js)

Følgende kommandoer må legges til i `handleServerMessage()`:

```javascript
case 'set_speed':
  // NY: Manuell fartsjustering fra view.html
  currentTargetSpeed = params.speed;
  await ftms.setSpeed(params.speed);
  // Hvis HRZoneController aktiv → trigger pause(45000)
  if (activeHRZoneController) {
    activeHRZoneController.pause(45000);
    activeHRZoneController.updateBaseline(params.speed, currentTargetIncline);
  }
  sendCommandResponse(commandId, 'set_speed', true);
  break;

case 'set_incline':
  // NY: Manuell stigningsjustering fra view.html
  currentTargetIncline = params.incline;
  await ftms.setIncline(params.incline);
  if (activeHRZoneController) {
    activeHRZoneController.pause(45000);
    activeHRZoneController.updateBaseline(currentTargetSpeed, params.incline);
  }
  sendCommandResponse(commandId, 'set_incline', true);
  break;
```

## TTS-meldinger for sonestyring

Nye meldinger, levert via `onStatusChange`-callback → server → coaching-engine / view.html:

| Hendelse | Melding | Prioritet |
|----------|---------|-----------|
| Sonestyring starter | "Sonestyrt trening aktivert. Målsone er {zone}." | 2 |
| Fart senkes | "Senker farten til {speed} for å holde deg i sone {zone}." | 2 |
| Fart økes | "Øker farten til {speed}." | 2 |
| Stigning senkes | "Senker stigningen til {incline} prosent." | 2 |
| Stigning økes | "Øker stigningen til {incline} prosent." | 2 |
| Tilbake i sone | "Bra, du er i sone {zone}." | 2 |
| HRM mistet | "Mistet pulssignal. Holder nåværende fart." | 1 |
| HRM timeout | "Sonestyring deaktivert, ingen pulsdata." | 1 |
| HRM tilbake | "Pulssignal gjenopprettet, gjenopptar sonestyring." | 1 |
| Manuell override | "Manuell justering registrert. Sonestyring pauser i 45 sekunder." | 3 |
| Abnorm puls | "Pulsen er svært høy. Senker farten for sikkerhet." | 1 |
| Vedvarende overbelastning | "Pulsen er vedvarende høy. Vurder å stoppe." | 1 |

**TTS-cooldown for justeringsmeldinger:** Ikke annonsere hvert 20. sekund — kun ved første justering etter en stabil periode, eller ved signifikante endringer (>0.5 km/h akkumulert). Ellers blir det irriterende.

**Coaching engine-koordinering:** Når `hrZoneControlActive = true` i state-broadcasten, skal `coaching-engine.js` skippe trigger 2 (zone violation). Sonestyrt-spesifikke TTS-meldinger kommer fra kontrollerens onStatusChange-callback i stedet.

## WebSocket-protokoll utvidelser

### Utvidet treadmill_state (ble-service → server)

```javascript
{
  type: 'treadmill_state',
  // ... eksisterende felter ...
  hrZoneControl: {                   // NY blokk, null hvis ikke aktiv
    active: true,
    paused: false,
    pauseRemaining: 0,               // sekunder til gjenopptakelse
    targetZone: 3,
    currentZone: 4,
    avgHR: 162,
    controlMode: 'speed',            // 'speed' | 'incline'
    currentControlledValue: 9.3,     // nåværende fart/stigning satt av kontrolleren
    adjustmentCount: 5,              // antall justeringer i dette segmentet
    lastAction: 'decrease_speed',    // siste handling
    hrmStatus: 'connected'           // 'connected' | 'dropout' | 'timeout'
  }
}
```

### Start-session med sonestyring (view.html → server → ble-service)

```javascript
{
  type: 'command',
  commandId: 'uuid',
  command: 'start_session',          // NB: 'command', ikke 'action'
  params: {
    workout_id: 7,
    profile_id: 1,
    hr_zone_control_enabled: true    // NY
  }
}
```

### Manuell justering (view.html → server → ble-service)

```javascript
// Ny kommando — eksisterer ikke i dag
{
  type: 'command',
  commandId: 'uuid',
  command: 'set_speed',              // NY
  params: { speed: 8.5 }
}

{
  type: 'command',
  commandId: 'uuid',
  command: 'set_incline',            // NY
  params: { incline: 3.0 }
}
```

## Eksisterende økter — auto-markering

Basert på gjennomgang av alle 57 økter i databasen (RPi):

**Automatisk markert som egnet (`hr_zone_eligible = 1`) av heuristikken:**
- ID 4, 7, 8, 9, 22, 24, 25, 26, 27, 34 (beginner steady-state, langkjøring, restitusjon)
- ID 38-43 (C25K uke 4-9 — har segmenter >= 180s med target_zone)
- ID 44, 45 (Langkjøring 50/60 min)
- ID 48, 49 (Tempo 20/30 min)
- ID 50, 51 (VO2max — har 180s+ segmenter)
- ID 52, 53 (Threshold 2x10, 3x12)
- ID 55 (Long Run Progressive)

**Automatisk markert som ikke egnet (`hr_zone_eligible = 0`):**
- ID 1, 36, 37 (C25K uke 1-3 — ingen segmenter >= 180s med target_zone)
- ID 2, 12, 13, 17, 19, 20, 31, 32 (korte intervaller, 15-60s)
- ID 3, 5, 10, 11, 14, 15, 18, 23, 28, 29, 30, 33, 35, 46, 47, 54, 56, 57 (for korte arbeidssegmenter eller feil formål)
- ID 16 (4x4 min — 240s men mangler target_zone i DB)
- ID 21 (Progressive Sett — 15s elementer)
- ID 58 (Lactate Tolerance — 120s+ men formålet er pace)
- ID 59 (MaxHR Test — formålet er å finne maxHR)

**Viktig:** Noen økter som *burde* ha `target_max_zone` satt på segmentene mangler dette i databasen (ID 2-5, 12-13, 16-17, 19-21, 27-35). Heuristikken fanger dette korrekt — uten `target_max_zone` er de ikke egnet. Eventuelt bør disse berikes med soneverdier i en fremtidig opprydding.

## Implementeringsrekkefølge

1. **Delt soneberegning** — flytt `getZone()` til `ble-service/hr-utils.js`, oppdater coaching-engine.js
2. **Database-migrering** — nye kolonner på `workout_segments`, `workouts`, `workout_sessions` (begge migreringsfiler)
3. **API-oppdateringer** — oppdater POST/PUT workout-endpoints og POST session til å inkludere nye kolonner
4. **HRZoneController klasse** (`ble-service/hr-zone-controller.js`) — ren logikk, testbar isolert
5. **Heuristikk + auto-markering** i `server.js` — beregn `hr_zone_eligible` ved template-sync
6. **Nye WebSocket-kommandoer** — `set_speed`/`set_incline` i ble-service.js
7. **Integrer i `ble-service.js`** — HRZoneController i `executeSegment()`, profil-flow, drift-koordinering
8. **Nye templates** — 5 sonestyrt-økter i `templates.json`
9. **Frontend: view.html** — filter, toggle, sonestyrt-indikator, manuelle justeringsknapper
10. **Frontend: app.js/index.html** — filter, historikk-info, segment-editor toggle
11. **TTS-integrasjon** — coaching-engine suppress zone-violation under sonestyring + nye meldinger
12. **Test med ekte HRM på RPi**

## Risiko og kjente utfordringer

1. **Oscillering** — kontrolleren kan "jage" pulsen. Mitigasjoner: 20s intervall (ikke 10), hysteresebånd (+2% maxHR), akkumuleringsgrense (0.8 km/h), retningsskifte-cooldown (30s). Krever tuning med ekte HRM.
2. **Puls-lag** — 30-60s forsinkelse mellom fartsendring og pulsrespons. Mitigasjon: akkumuleringsgrense stopper justeringer etter 0.8 km/h samlet endring og venter på pulsrespons.
3. **Ulike brukere, ulik respons** — Magnus og Nansy har forskjellig maxHR og pulsrespons. Mitigasjon: `maxHR` fra profil brukes, og parameterne er konservative nok for begge.
4. **FTMS rate-limiting** — 400ms mellom BLE-writes. Kontrolleren justerer maks hvert 20. sekund, så dette er ikke et problem.
5. **Oppvarming av kontrolleren** — de første 8-15 sekundene har ikke nok HR-data. Kontrolleren venter på `minDataPoints` (8) før den starter.
6. **Profil-bytte under økt** — ikke støttet. Profil velges ved øktstart og er låst under kjøring.
