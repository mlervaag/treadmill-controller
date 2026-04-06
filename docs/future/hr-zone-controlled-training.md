# Feature: HR-sonestyrt trening (automatisk fartsjustering)

**Status:** Implementert 2026-04-06
**Prioritet:** Høy
**Sist oppdatert:** 2026-04-06

> **Merk:** Fullstendig designspesifikasjon: `docs/superpowers/specs/2026-04-06-hr-zone-controlled-training-design.md`

## Hva det er

En økttype der tredemøllen automatisk justerer farten for å holde løperen i en bestemt HR-sone over en gitt tid. Hvis pulsen stiger over målsonen, senkes farten automatisk til pulsen er tilbake i riktig sone. Tilsvarende økes farten forsiktig hvis pulsen er for lav.

## Hva som allerede finnes (byggeblokker)

Mye av infrastrukturen er på plass:

### HR-soner og profiler
- `user_profiles` tabell med `max_hr` per bruker
- `CoachingEngine.getZone(hr, maxHR)` i `coaching-engine.js:23-31` — beregner sone 1-5:
  - Sone 1: <60% av maxHR
  - Sone 2: 60-70%
  - Sone 3: 70-80%
  - Sone 4: 80-90%
  - Sone 5: 90-100%

### Sonevarsler (coaching)
- `coaching-engine.js:84-126` — trigger 2: zone violation
- Etter 60 sekunder utenfor målsone: TTS-melding "vurder å senke farten" / "øke intensiteten"
- Cooldown 120s mellom varsler
- Merker seg "tilbake i målsonen" og bekrefter med TTS

### Fartskontroll via BLE
- `treadmill.setSpeedAndConfirm(speedKmh)` i `ftms.js` — setter fart med FTMS bekreftelselogi
- `treadmill.setInclineAndConfirm(inclinePercent)` — tilsvarende for stigning
- `currentTargetSpeed` og `currentTargetIncline` i `app.js` — globaler som sporer nåværende mål
- Drift-deteksjon (`app.js:600-640`) — sjekker hvert 8. sekund at faktisk == mål, resender ved avvik
- FTMS speed range: 0.1-14.0 km/h, incline: 0-12%
- Minimum 400ms mellom BLE-writes

### Segmentbasert øktutførelse
- `executeSegment(index)` i `app.js:1673-1795` — setter fart/stigning per segment
- Hver segment har: `speed_kmh`, `incline_percent`, `duration_seconds`, `segment_name`, `target_max_zone`
- Timer teller ned per segment, kaller `executeSegment(index + 1)` ved overgang
- `workoutTimer` (1s interval) håndterer nedtelling og UI-oppdatering

### Pulsdata
- Pulsbelte (HRM) eller treadmill-innebygd — `activeHeartRateSource` i `app.js`
- HRM prioriteres over treadmill-puls
- HR tilgjengelig i `treadmillHeartRate` (fra FTMS) og `hrmHeartRate` (fra HRM)
- Rapporteres til server via `buildCurrentState()` → WebSocket broadcast

### TTS coaching-system
- `CoachingEngine` får state-updates hvert ~2 sekund via WebSocket
- `tts-service.js` — OpenAI TTS med caching
- Kan gi talebasert feedback under sonestyrt trening

## Hva som mangler (må implementeres)

### 1. HR Zone Controller (kontroll-loop)

En ny klasse/modul som:
- Tar inn: målsone (1-5), maxHR, kontrollmetode (fart/stigning/begge)
- Mottar pulsoppdateringer (~1/sek)
- Beregner om pulsen er over/under/i målsonen
- Returnerer fartsjusteringer

**Nøkkellogikk:**
```
Hvert X sekund (f.eks. 10-15s):
  1. Beregn glidende gjennomsnitt av siste N pulsmålinger (unngå spikes)
  2. Finn nåværende sone
  3. Hvis over målsone:
     - Senk fart med 0.2-0.5 km/h
     - Aggressivitet avhenger av hvor langt over (1 sone over = forsiktig, 2+ = raskere)
  4. Hvis under målsone (og har vært det en stund):
     - Øk fart med 0.2-0.3 km/h (forsiktigere enn nedsenking)
  5. Hvis i målsone:
     - Ikke gjør noe
  6. Respekter min/maks-fart (f.eks. 4.0-14.0 km/h)
```

**Viktige hensyn:**
- **Treghet:** Puls responderer med 30-60s forsinkelse på fartsendring. Ikke juster for ofte.
- **Glidende snitt:** Bruk 5-10 målinger for å unngå reaksjon på enkeltstående spikes
- **Asymmetrisk justering:** Nedsenking bør være raskere/aggressivere enn opptrapping (sikkerhet)
- **Maks steg per justering:** Unngå store hopp — maks 0.5 km/h per justering
- **Cooldown etter manuell override:** Brukeren kan overstyre manuelt, da bør kontrolleren pause 30-60s (lik drift-detection cooldown)

### 2. Økt-type / workout template

Kan gjøres som vanlige workout_segments med en ny egenskap, eller som en ny økttype. Enkleste tilnærming:

**Alternativ A: Nytt felt på segment**
```sql
ALTER TABLE workout_segments ADD COLUMN hr_zone_control INTEGER DEFAULT 0;
-- 0 = vanlig segment (fast fart), 1 = sonestyrt (fart justeres automatisk)
```
Segmentet har `speed_kmh` som startfart, `target_max_zone` som målsone. Kontrolleren justerer farten rundt startverdien.

**Alternativ B: Dedikert økttype**
Ny kolonne `workout_type` på `workouts` — 'manual' (default) eller 'hr_controlled'. Hele økten er sonestyrt med definert varighet per sone.

**Anbefaling:** Alternativ A er enklere og mer fleksibelt — du kan mikse faste og sonestyrtesegmenter i samme økt (f.eks. fast oppvarming → sonestyrt hoveddel → fast nedkjøling).

### 3. Templates

Eksempler på sonestyrt-økter:
- **Sone 2 Utholdenhet** (45 min): 5 min oppvarming (fast) → 35 min sone 2 (sonestyrt) → 5 min nedkjøling (fast)
- **Sone 3 Tempo** (30 min): 5 min oppvarming → 20 min sone 3 → 5 min nedkjøling
- **Sone 4 Terskel** (25 min): 5 min oppvarming → 3x5 min sone 4 med 2 min sone 2 pause → 5 min nedkjøling
- **Progressiv Sonetrening** (40 min): oppvarming → 10 min sone 2 → 10 min sone 3 → 10 min sone 4 → nedkjøling

### 4. Frontend-endringer

**I `executeSegment()` (`app.js:1673`):**
- Sjekk om segmentet har `hr_zone_control = 1`
- Hvis ja: start HR zone controller i stedet for bare å sette fast fart
- Kontrolleren kjører inni segmenttimeren (1s tick) og kaller `treadmill.setSpeed()` ved behov

**I UI (workout progress):**
- Vis "Sone X" som mål i stedet for fast fart
- Vis nåværende sone med farge
- Vis "Justerer fart..." når kontrolleren endrer

**I view.html:**
- Vis at økten er sonestyrt (sone-indikator)
- HR-sone-fargen er allerede implementert

### 5. Sikkerhet

- **Krever HRM-tilkobling** — sonestyrt trening uten pulsdata er meningsløst
- **Minimum fart:** Ikke senk under 3-4 km/h (gange)
- **Maksimum fart:** Respekter brukerens komfortsone / FTMS-grensen (14 km/h)
- **HRM-frakobling under økt:** Pause sonestyring, gi varsel, gå tilbake til sist kjente fart
- **Abnorm puls (>95% maxHR i sone 2-økt):** Tvungen nedsenking + TTS-advarsel

## Integrasjonspunkter i eksisterende kode

| Hva | Hvor | Linje(r) |
|-----|------|----------|
| Soneberegning | `coaching-engine.js` | `getZone()` linje 23-31 |
| Sonevarsler | `coaching-engine.js` | Trigger 2, linje 84-126 |
| Fartskontroll | `public/ftms.js` | `setSpeedAndConfirm()` |
| Segmentutførelse | `public/app.js` | `executeSegment()` linje 1673 |
| Drift-deteksjon | `public/app.js` | Linje 600-640, 8s intervall |
| Manuell override cooldown | `public/app.js` | `MANUAL_OVERRIDE_COOLDOWN` = 15s |
| currentTargetSpeed | `public/app.js` | Global, linje 44 |
| Pulsmålinger | `public/app.js` | `hrmHeartRate`, `treadmillHeartRate` |
| State broadcast | `public/app.js` | `buildCurrentState()` → WS hvert 2s |
| Segment-skjema | `server.js` | `workout_segments` tabell |
| Template-lasting | `server.js` | `templates.json` → DB sync |

## Forslag til implementeringsrekkefølge

1. **Database:** Legg til `hr_zone_control` kolonne på `workout_segments`
2. **HRZoneController klasse:** Ren logikk — tar puls inn, gir fartsjustering ut. Testbar isolert
3. **Integrer i `executeSegment()`:** Bruk kontrolleren for segmenter med `hr_zone_control = 1`
4. **Lag 2-3 templates** i `templates.json`
5. **UI:** Vis sonemål i stedet for fast fart under sonestyrt segment
6. **TTS-integrasjon:** Coaching-meldinger tilpasset sonestyring ("Senker farten for å holde deg i sone 3")
7. **Test med ekte pulsbelte** på tredemøllen
