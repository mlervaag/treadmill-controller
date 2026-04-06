# Treadmill Controller - Roadmap

## ✅ Implementerte funksjoner

Følgende funksjoner er ferdig implementert:

### Strava Integration
**Status**: ✅ Implementert (2026-02)
- OAuth 2.0 med token refresh
- TCX-generering og opplasting
- Manuell og automatisk opplasting
- Duplicate-beskyttelse med external_id
- Se [STRAVA_INTEGRATION.md](STRAVA_INTEGRATION.md) for teknisk dokumentasjon

### Treningsdata-graf
**Status**: ✅ Implementert (2026-02)
- Chart.js med dual Y-akse (hastighet + puls)
- Interaktiv modal-visning
- Fargede segmentzoner som bakgrunn

### Lydvarsler
**Status**: ✅ Implementert (2026-02)
- Pip ved segmentbytte (Web Audio API, 440Hz)
- Stigende tone ved fullført økt (440→880Hz)
- Av/på-toggle i innstillinger

### Eksport
**Status**: ✅ Implementert (2026-02)
- JSON, CSV og TCX-format
- Nedlastingsknapper per økt

### Datofilter
**Status**: ✅ Implementert (2026-02)
- Quick-filtre: 7 dager, denne mnd, 3 mnd, alle
- Egendefinert datoperiode

### Workout-redigering
**Status**: ✅ Implementert (2026-02)
- Rediger egendefinerte økter
- PUT /api/workouts/:id

### Auto BLE-reconnect
**Status**: ✅ Implementert (2026-02)
- Eksponentiell backoff (2s → 30s)
- Maks 5 forsøk
- Toast-varsler under reconnect

### Per-segment feedback
**Status**: ✅ Implementert (2026-02)
- Gjennomsnittsfart, puls og tid per segment
- segment_index i session_data

### PWA
**Status**: ✅ Implementert (2026-02)
- manifest.json med norsk lokale
- Service Worker med offline-støtte
- Cache-first for statiske filer, network-first for API

### View-only Dashboard
**Status**: ✅ Implementert (2026-02)
- Sanntidsvisning for iPad/iPhone via WebSocket
- HR-sone-farger, tilkoblingsstatus
- Responsiv, dark theme

### TTS Voice Coaching
**Status**: ✅ Implementert (2026-04)
- Norsk stemme via OpenAI TTS API med aggressiv disk-caching
- Triggere: segment-overganger, sone-avvik (etter 60s), milepæler
- Brukerprofiler med maxHR for 5-sone-beregning
- Avspilling til iPhone/headset (AudioContext) eller tredemølle-høyttalere (A2DP)
- Graceful degradation: tekst-toast uten API-nøkkel

### Multi-user / Profile Tagging
**Status**: ✅ Implementert (2026-04)
- Lettvekts brukerprofiler (navn + maxHR)
- Profilvelger ved øktstart (index.html + view.html)
- Historikkfiltrering per profil
- Inline profil-tagging i etterkant (PATCH endpoint)
- Per-profil Strava-tilkoblinger (OAuth state-param)
- Auto-upload kun for profiler med Strava-kobling

### HR-sonestyrt trening (automatisk fartsjustering)
**Status**: ✅ Implementert (2026-04-06)
- Automatisk fart/stigning-justering for å holde løperen i målsone
- HR Zone Controller i `ble-service/hr-zone-controller.js` med hysterese, akkumulering og retningsskifte-cooldown
- Justering hvert 20. sekund, manuell overstyring pauser kontrolleren i 45s
- Støtter kontrollmodus: speed, incline, eller begge
- Sonestyrt-segmenter i vanlige workout templates (`hr_zone_control` felt på segmenter)
- TTS-meldinger via `hr_zone_status` WebSocket — coaching engine undertrykker sine egne sonevarsler
- Fullstendig designspesifikasjon: `docs/superpowers/specs/2026-04-06-hr-zone-controlled-training-design.md`

---

## 🎯 Planlagte funksjoner

### ~~HR-sonestyrt trening~~
**Status**: ✅ Implementert (2026-04-06)
- Se "HR-sonestyrt trening" i Implementerte funksjoner over

### Historisk plan (nå implementert)

### 1 (historisk). Heart Rate Zone Training & User Profile
**Status**: ✅ Implementert (2026-04-06)
**Hva ble implementert**: Brukerprofiler, HR-soner, coaching-varsler, MaxHR-test, alle 39 templates med målsoner, automatisk fartsjustering (HRZoneController)

#### Beskrivelse
Implementere pulsbasert adaptiv trening hvor tredemøllen automatisk justerer tempo/stigning for å holde brukeren i ønsket puls-sone. Krever brukerprofil med fysiologiske data.

#### Komponenter

##### 1.1 Database Schema
```sql
-- User Profile table
CREATE TABLE user_profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  age INTEGER,
  gender TEXT, -- 'male', 'female', 'other'
  weight_kg REAL,
  max_heart_rate INTEGER,
  resting_heart_rate INTEGER,
  lactate_threshold_hr INTEGER,
  vo2max REAL,
  max_hr_source TEXT DEFAULT 'estimated', -- 'estimated', 'tested', 'manual'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- HR Zone definitions (can be customized per user)
CREATE TABLE hr_zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  zone_number INTEGER NOT NULL, -- 1-5
  zone_name TEXT NOT NULL, -- 'Recovery', 'Endurance', 'Tempo', 'Threshold', 'VO2max'
  min_percent INTEGER NOT NULL, -- % of max HR
  max_percent INTEGER NOT NULL,
  color TEXT, -- For UI visualization
  FOREIGN KEY (user_id) REFERENCES user_profile(id)
);

-- Update workouts table to support HR-controlled workouts
ALTER TABLE workouts ADD COLUMN workout_type TEXT DEFAULT 'manual';
-- 'manual', 'hr_controlled', 'max_hr_test'

ALTER TABLE workouts ADD COLUMN target_hr_zone INTEGER;
-- References hr_zones.zone_number

ALTER TABLE workouts ADD COLUMN hr_control_method TEXT DEFAULT 'speed';
-- 'speed', 'incline', 'both'

-- Track zone time in sessions
CREATE TABLE session_zone_time (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  zone_number INTEGER NOT NULL,
  seconds_in_zone INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES workout_sessions(id)
);
```

##### 1.2 Backend API Endpoints
**New endpoints to create:**

```javascript
// User Profile
GET    /api/profile              // Get current user profile
POST   /api/profile              // Create/update profile
GET    /api/profile/zones        // Get HR zones for user
PUT    /api/profile/zones        // Update HR zones

// Max HR Testing
POST   /api/profile/max-hr-test  // Start max HR test session
PUT    /api/profile/max-hr       // Update max HR from test results

// HR-controlled workouts
GET    /api/workouts/hr-controlled    // Get all HR-controlled workouts
POST   /api/workouts/hr-controlled    // Create new HR-controlled workout

// Session zone analytics
GET    /api/sessions/:id/zones   // Get time-in-zone breakdown
```

##### 1.3 Frontend Components

**New tab: "Profil" (Profile)**
```
- Personal Information
  - Name, age, gender, weight

- Heart Rate Data
  - Max HR (with "Test Now" button)
  - Resting HR
  - Lactate Threshold (optional)
  - VO2max (optional)

- HR Zones (visual chart)
  - Zone 1: Recovery (50-60%) - Gray
  - Zone 2: Endurance (60-70%) - Blue
  - Zone 3: Tempo (70-80%) - Green
  - Zone 4: Threshold (80-90%) - Orange
  - Zone 5: VO2max (90-100%) - Red

- Calculation methods
  - Manual input
  - Estimated (220 - age)
  - Field test (guided protocol)
```

**New workout type: "Puls-kontrollert økt"**
```
- Select target zone (1-5)
- Select duration
- Choose control method:
  - Hastighet (speed adjustment)
  - Stigning (incline adjustment)
  - Begge (both)

- Settings:
  - Adjustment interval (default: 15 seconds)
  - Adjustment step size (default: 0.5 km/t or 1%)
  - Max speed/incline limits
```

**New workout type: "Makspuls-test"**
```
Guided protocols:
1. "3-3-3 Test"
   - 3 min warmup
   - 3 min hard
   - 3 min all-out

2. "Ramp Test"
   - Start at 8 km/t
   - Increase 1 km/t every 2 minutes
   - Run until exhaustion

3. "Custom Test"
   - User-defined protocol
```

##### 1.4 Core Logic: HR Control Loop

```javascript
class HRZoneController {
  constructor(targetZone, controlMethod, maxSpeed, maxIncline) {
    this.targetZone = targetZone; // { min: 140, max: 160 }
    this.controlMethod = controlMethod; // 'speed', 'incline', 'both'
    this.maxSpeed = maxSpeed;
    this.maxIncline = maxIncline;
    this.adjustmentInterval = 15000; // 15 seconds
    this.lastAdjustment = Date.now();
    this.consecutiveReadings = [];
  }

  update(heartRate, currentSpeed, currentIncline) {
    this.consecutiveReadings.push(heartRate);
    if (this.consecutiveReadings.length > 3) {
      this.consecutiveReadings.shift();
    }

    const now = Date.now();
    if (now - this.lastAdjustment < this.adjustmentInterval) {
      return null;
    }

    const avgHR = this.consecutiveReadings.reduce((a, b) => a + b) / this.consecutiveReadings.length;

    if (avgHR < this.targetZone.min) {
      return this.increaseIntensity(currentSpeed, currentIncline);
    } else if (avgHR > this.targetZone.max) {
      return this.decreaseIntensity(currentSpeed, currentIncline);
    }
    return null;
  }
}
```

##### 1.5 Implementation Steps

1. **Phase 1: Database & Profile** (2-3 timer)
   - Update migrate.js with new tables
   - Update server.js with profile endpoints
   - Create profile UI tab

2. **Phase 2: HR Zones** (2-3 timer)
   - Implement zone calculation logic
   - Create zone visualization UI
   - Add zone editing capability

3. **Phase 3: HR Control Loop** (3-4 timer)
   - Implement HRZoneController class
   - Integrate with treadmill control
   - Add safety limits and edge case handling

4. **Phase 4: Max HR Testing** (2-3 timer)
   - Create test protocols
   - Implement test UI flow
   - Add test result analysis

5. **Phase 5: Templates & Testing** (2-3 timer)
   - Add HR-controlled workout templates
   - Test with real HRM device
   - Fine-tune adjustment algorithms

**Total estimated time**: 11-16 timer

##### 1.6 Technical Considerations

**Safety**
- Always require HRM connection for HR-controlled workouts
- Implement max speed/incline limits
- Add emergency stop functionality
- Monitor for abnormal HR patterns
- Require user confirmation before max HR tests

**Performance**
- Use moving average for HR readings (avoid reacting to single spikes)
- Implement minimum adjustment interval (avoid constant changes)
- Gradual adjustments only (0.5 km/h, 1% incline)

**Edge Cases**
- HRM disconnection during workout → pause and alert user
- HR not reaching target zone → warn user after 5 minutes
- HR exceeding safety threshold → automatic slowdown
- No HR data available → cannot start HR-controlled workout

---

## 📊 Andre planlagte funksjoner

### Workout Builder
**Status**: Planlagt
**Prioritet**: Medium
- Visual drag-and-drop segment creator
- Save custom workouts
- Share workouts via JSON export

### Advanced Analytics
**Status**: Planlagt
**Prioritet**: Medium
- Training load tracking (TSS/TRIMP)
- Fitness & Fatigue trends
- Weekly/monthly volume charts
- PR tracking (distance, speed, elevation)
- Sone-statistikk: tid i hver sone per økt, sone-progresjon over tid

### ~~Multi-user Support~~
**Status**: ✅ Implementert (2026-04)
- Se "Multi-user / Profile Tagging" over

### ~~Voice Feedback~~
**Status**: ✅ Implementert (2026-04)
- Se "TTS Voice Coaching" over

### Push Notifications
**Status**: Planlagt
**Prioritet**: Lav
- Varslinger ved treningsplanlagte økter
- Påminnelser om treningsfrekvens
- Krever PWA (allerede implementert)

### Periodiske TTS-oppsummeringer
**Status**: Planlagt
**Prioritet**: Lav
- TTS hvert 5. minutt med snitt-puls, distanse, tempo
- Talt økt-oppsummering ved slutt

---

## 🐛 Kjente problemer & forbedringer

### Kjente problemer
- Drift-deteksjon kan konflikte med manuelle hastighetsjusteringer under økt
- `JSON.parse(workout.tags)` i GET /api/workouts mangler try-catch
- Strava-opplastingsstatus forblir "uploading" — ingen polling for endelig status implementert
- Service Worker-cache må kanskje tømmes manuelt etter deploy (bump versjon i sw.js)

### Mulige forbedringer
- Forhåndsvisning av økt før start
- Pause/gjenoppta økt
- Manuell segment-overstyring under økt
- Notater/kommentarer per økt

---

*Sist oppdatert: 2026-04-06*
