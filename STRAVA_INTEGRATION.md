# Strava Integration - Technical Analysis

> **Status: ✅ IMPLEMENTERT** (februar 2026). OAuth, TCX-upload og auto-sync er live. Se server.js for implementasjonen.

## 🎯 Mål
Automatisk synkronisering av tredemølle-økter til Strava, med komplett data inkludert puls, hastighet, stigning, distanse og kalorier.

## ⚠️ Viktig: Privacy-begrensning
Strava API v3 støtter **IKKE** å sette aktivitetsprivacy via API (fjernet av Strava). Brukere må sette "Default Activity Privacy" til "Only You" i Strava → Settings → Privacy Controls for å sikre at opplastede økter er private.

## ✅ Er det mulig?
**JA!** Strava har et offentlig API (v3) som støtter:
- OAuth 2.0 autentisering
- Opplasting av aktiviteter (FIT, TCX, GPX format)
- Indoor/treadmill aktiviteter (uten GPS)
- Metadata: puls, tempo, stigning, kalorier
- Rate limit: 200 requests/15 min, 2000/dag

## 📚 Kilder
- [Strava API Authentication](https://developers.strava.com/docs/authentication/)
- [Strava API Uploads](https://developers.strava.com/docs/uploads/)
- [Strava API Reference](https://developers.strava.com/docs/reference/)

---

## 🏗️ Arkitektur

### Overordnet flyt:
```
1. Bruker kobler Strava-konto (OAuth 2.0)
2. Bruker fullfører en økt
3. App genererer TCX/FIT fil med øktdata
4. App laster opp fil til Strava API
5. Strava prosesserer og viser aktivitet
```

---

## 🔐 OAuth 2.0 Autentisering

### Steg 1: Registrere app hos Strava
**URL**: https://www.strava.com/settings/api

Opprette app og få:
- `client_id`: Offentlig ID for appen
- `client_secret`: Hemmelig nøkkel (ALDRI commit til git!)

**Registreringsdetaljer:**
```
Application Name: Treadmill Controller
Category: Training
Club: (optional)
Website: https://github.com/user/treadmill-controller
Authorization Callback Domain: 192.168.1.12:3001 (eller localhost:3001)
```

### Steg 2: Authorization Flow

#### 2.1 Bruker klikker "Koble til Strava"
App redirecter til:
```
https://www.strava.com/oauth/authorize?
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://192.168.1.12:3001/auth/strava/callback&
  response_type=code&
  scope=activity:write,activity:read
```

**Scopes:**
- `activity:read`: Les brukerens aktiviteter
- `activity:write`: Last opp nye aktiviteter
- `profile:read_all`: Les profil (vekt, etc.)

#### 2.2 Strava redirecter tilbake med kode
```
https://192.168.1.12:3001/auth/strava/callback?code=AUTHORIZATION_CODE&scope=activity:write,activity:read
```

#### 2.3 Exchange code for tokens
```javascript
POST https://www.strava.com/oauth/token

Body:
{
  "client_id": "YOUR_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET",
  "code": "AUTHORIZATION_CODE",
  "grant_type": "authorization_code"
}

Response:
{
  "access_token": "a9b723...",       // Short-lived (expires in ~6 hours)
  "refresh_token": "b5c234...",      // Long-lived, use to get new access_token
  "expires_at": 1738012345,          // Unix timestamp
  "athlete": {
    "id": 12345,
    "username": "johndoe",
    "firstname": "John",
    "lastname": "Doe"
  }
}
```

#### 2.4 Refresh access token (når utløpt)
```javascript
POST https://www.strava.com/oauth/token

Body:
{
  "client_id": "YOUR_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET",
  "refresh_token": "b5c234...",
  "grant_type": "refresh_token"
}
```

---

## 📤 Laste opp aktivitet

### Metode 1: TCX Format (Anbefalt)
**Training Center XML** - utviklet av Garmin, støttes godt av Strava.

#### Eksempel TCX-fil for tredemølle-økt:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Running">
      <Id>2026-01-27T18:30:00Z</Id>
      <Lap StartTime="2026-01-27T18:30:00Z">
        <TotalTimeSeconds>1800</TotalTimeSeconds>
        <DistanceMeters>5000</DistanceMeters>
        <Calories>450</Calories>
        <AverageHeartRateBpm>
          <Value>155</Value>
        </AverageHeartRateBpm>
        <MaximumHeartRateBpm>
          <Value>178</Value>
        </MaximumHeartRateBpm>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
          <!-- Trackpoint for hvert datapunkt (1 per sekund) -->
          <Trackpoint>
            <Time>2026-01-27T18:30:00Z</Time>
            <DistanceMeters>0</DistanceMeters>
            <HeartRateBpm>
              <Value>120</Value>
            </HeartRateBpm>
            <Cadence>0</Cadence>
            <Extensions>
              <TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
                <Speed>2.22</Speed> <!-- m/s (8 km/h) -->
                <RunCadence>160</RunCadence>
              </TPX>
            </Extensions>
          </Trackpoint>
          <Trackpoint>
            <Time>2026-01-27T18:30:01Z</Time>
            <DistanceMeters>2.22</DistanceMeters>
            <HeartRateBpm>
              <Value>125</Value>
            </HeartRateBpm>
            <Extensions>
              <TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
                <Speed>2.78</Speed> <!-- m/s (10 km/h) -->
                <RunCadence>165</RunCadence>
              </TPX>
            </Extensions>
          </Trackpoint>
          <!-- ... fortsett for hver sekund ... -->
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
```

#### API Upload Request:
```javascript
POST https://www.strava.com/api/v3/uploads

Headers:
  Authorization: Bearer {access_token}

Form Data (multipart/form-data):
  file: (TCX file content)
  name: "Tredemølle 30 min Steady State"
  description: "Sone 2 trening, gjennomsnittspuls 155 bpm"
  trainer: true                    // Markerer som indoor
  commute: false
  data_type: "tcx"
  external_id: "treadmill_12345"   // Unik ID for å unngå duplikater

Response:
{
  "id": 987654321,
  "id_str": "987654321",
  "external_id": "treadmill_12345",
  "error": null,
  "status": "Your activity is still being processed.",
  "activity_id": null              // Blir satt når prosessert
}
```

#### Sjekke upload status:
```javascript
GET https://www.strava.com/api/v3/uploads/{upload_id}

Response (når ferdig):
{
  "id": 987654321,
  "external_id": "treadmill_12345",
  "error": null,
  "status": "Your activity is ready.",
  "activity_id": 123456789         // Strava activity ID
}
```

### Metode 2: FIT Format
**Flexible and Interoperable Data Transfer** - binært format, mer komplisert men mer kompakt.

**Fordeler:**
- Mindre filstørrelse
- Native format for Garmin/Polar
- Bedre støtte for avanserte data

**Ulemper:**
- Krever FIT SDK eller bibliotek
- Mer komplisert å generere

**NPM bibliotek**: `easy-fit` eller `fit-file-writer`

### Metode 3: GPX Format
**GPS Exchange Format** - XML-basert, primært for GPS data.

**Ikke optimal for tredemølle** fordi:
- Designet for GPS-koordinater
- Strava forventer lat/lng per punkt
- Mangler støtte for puls i standard format

---

## 🗄️ Database Schema

```sql
-- Strava connection table
CREATE TABLE strava_auth (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  athlete_id INTEGER NOT NULL,        -- Strava athlete ID
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,        -- Unix timestamp
  scope TEXT NOT NULL,                -- "activity:write,activity:read"
  athlete_name TEXT,
  athlete_username TEXT,
  connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_sync DATETIME,
  FOREIGN KEY (user_id) REFERENCES user_profile(id)
);

-- Track which sessions have been uploaded
ALTER TABLE workout_sessions ADD COLUMN strava_activity_id INTEGER;
ALTER TABLE workout_sessions ADD COLUMN strava_upload_status TEXT DEFAULT 'pending';
-- 'pending', 'uploading', 'success', 'failed'
ALTER TABLE workout_sessions ADD COLUMN strava_error TEXT;

-- Sync log
CREATE TABLE strava_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  upload_id INTEGER,                  -- Strava upload ID
  activity_id INTEGER,                -- Strava activity ID
  status TEXT NOT NULL,               -- 'pending', 'processing', 'success', 'failed'
  error_message TEXT,
  attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (session_id) REFERENCES workout_sessions(id)
);
```

---

## 💻 Implementation

### Backend API Endpoints

```javascript
// In server.js

// Strava OAuth routes
app.get('/auth/strava', (req, res) => {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const redirectUri = `${process.env.APP_URL}/auth/strava/callback`;
  const scope = 'activity:write,activity:read';

  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}`;

  res.redirect(authUrl);
});

app.get('/auth/strava/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect('/?error=strava_auth_failed');
  }

  try {
    // Exchange code for tokens
    const response = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code'
      })
    });

    const data = await response.json();

    // Save tokens to database
    db.prepare(`
      INSERT INTO strava_auth (athlete_id, access_token, refresh_token, expires_at, scope, athlete_name, athlete_username)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(athlete_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        last_sync = CURRENT_TIMESTAMP
    `).run(
      data.athlete.id,
      data.access_token,
      data.refresh_token,
      data.expires_at,
      'activity:write,activity:read',
      `${data.athlete.firstname} ${data.athlete.lastname}`,
      data.athlete.username
    );

    res.redirect('/?strava_connected=true');
  } catch (error) {
    console.error('Strava auth error:', error);
    res.redirect('/?error=strava_auth_failed');
  }
});

// Get Strava connection status
app.get('/api/strava/status', (req, res) => {
  const auth = db.prepare('SELECT * FROM strava_auth ORDER BY connected_at DESC LIMIT 1').get();

  if (!auth) {
    return res.json({ connected: false });
  }

  res.json({
    connected: true,
    athlete_name: auth.athlete_name,
    athlete_username: auth.athlete_username,
    connected_at: auth.connected_at,
    last_sync: auth.last_sync
  });
});

// Disconnect Strava
app.delete('/api/strava/disconnect', (req, res) => {
  db.prepare('DELETE FROM strava_auth').run();
  res.json({ success: true });
});

// Upload session to Strava
app.post('/api/strava/upload/:sessionId', async (req, res) => {
  const sessionId = parseInt(req.params.sessionId);

  try {
    // Get valid access token
    const accessToken = await getValidStravaToken();

    // Get session data
    const session = db.prepare(`
      SELECT s.*, w.name as workout_name
      FROM workout_sessions s
      LEFT JOIN workouts w ON s.workout_id = w.id
      WHERE s.id = ?
    `).get(sessionId);

    const dataPoints = db.prepare(`
      SELECT * FROM session_data
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `).all(sessionId);

    // Generate TCX file
    const tcxContent = generateTCX(session, dataPoints);

    // Upload to Strava
    const formData = new FormData();
    formData.append('file', new Blob([tcxContent]), 'activity.tcx');
    formData.append('name', session.workout_name || 'Tredemølle-økt');
    formData.append('description', `${Math.round(session.total_distance_km * 1000)}m, ${Math.floor(session.total_time_seconds / 60)} min`);
    formData.append('trainer', 'true');
    formData.append('data_type', 'tcx');
    formData.append('external_id', `treadmill_${sessionId}`);

    const uploadResponse = await fetch('https://www.strava.com/api/v3/uploads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      },
      body: formData
    });

    const uploadData = await uploadResponse.json();

    // Log upload
    db.prepare(`
      INSERT INTO strava_sync_log (session_id, upload_id, status)
      VALUES (?, ?, 'processing')
    `).run(sessionId, uploadData.id);

    // Update session
    db.prepare(`
      UPDATE workout_sessions
      SET strava_upload_status = 'uploading'
      WHERE id = ?
    `).run(sessionId);

    res.json({
      success: true,
      upload_id: uploadData.id,
      status: uploadData.status
    });

  } catch (error) {
    console.error('Strava upload error:', error);

    db.prepare(`
      UPDATE workout_sessions
      SET strava_upload_status = 'failed', strava_error = ?
      WHERE id = ?
    `).run(error.message, sessionId);

    res.status(500).json({ error: error.message });
  }
});

// Helper: Get valid access token (refresh if expired)
async function getValidStravaToken() {
  const auth = db.prepare('SELECT * FROM strava_auth ORDER BY connected_at DESC LIMIT 1').get();

  if (!auth) {
    throw new Error('Not connected to Strava');
  }

  const now = Math.floor(Date.now() / 1000);

  // Token still valid
  if (auth.expires_at > now + 300) { // 5 min buffer
    return auth.access_token;
  }

  // Refresh token
  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: auth.refresh_token,
      grant_type: 'refresh_token'
    })
  });

  const data = await response.json();

  // Update tokens
  db.prepare(`
    UPDATE strava_auth
    SET access_token = ?, refresh_token = ?, expires_at = ?
    WHERE id = ?
  `).run(data.access_token, data.refresh_token, data.expires_at, auth.id);

  return data.access_token;
}

// Helper: Generate TCX file
function generateTCX(session, dataPoints) {
  const startTime = new Date(session.started_at).toISOString();

  let trackpoints = '';
  dataPoints.forEach(point => {
    const time = new Date(point.timestamp).toISOString();
    const distance = (point.distance_km || 0) * 1000; // km to meters
    const speed = (point.speed_kmh || 0) / 3.6; // km/h to m/s
    const hr = point.heart_rate || 0;

    trackpoints += `
          <Trackpoint>
            <Time>${time}</Time>
            <DistanceMeters>${distance.toFixed(2)}</DistanceMeters>
            ${hr > 0 ? `<HeartRateBpm><Value>${hr}</Value></HeartRateBpm>` : ''}
            <Extensions>
              <TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
                <Speed>${speed.toFixed(2)}</Speed>
              </TPX>
            </Extensions>
          </Trackpoint>`;
  });

  const avgHR = session.avg_heart_rate || 0;
  const maxHR = Math.max(...dataPoints.map(p => p.heart_rate || 0));

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Running">
      <Id>${startTime}</Id>
      <Lap StartTime="${startTime}">
        <TotalTimeSeconds>${session.total_time_seconds || 0}</TotalTimeSeconds>
        <DistanceMeters>${(session.total_distance_km || 0) * 1000}</DistanceMeters>
        <Calories>${session.calories_burned || 0}</Calories>
        ${avgHR > 0 ? `<AverageHeartRateBpm><Value>${avgHR}</Value></AverageHeartRateBpm>` : ''}
        ${maxHR > 0 ? `<MaximumHeartRateBpm><Value>${maxHR}</Value></MaximumHeartRateBpm>` : ''}
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>${trackpoints}
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;
}
```

### Frontend UI

**New tab: "Strava"**
```html
<div class="strava-connection-card">
  <div id="stravaDisconnected" class="hidden">
    <h3>🔗 Koble til Strava</h3>
    <p>Synkroniser treningsøktene dine automatisk til Strava</p>
    <button id="connectStravaBtn" class="btn btn-primary">
      Koble til Strava
    </button>
  </div>

  <div id="stravaConnected" class="hidden">
    <h3>✅ Koblet til Strava</h3>
    <p>
      <strong id="stravaAthleteName"></strong> (@<span id="stravaUsername"></span>)
    </p>
    <p class="text-secondary">
      Koblet til: <span id="stravaConnectedAt"></span>
    </p>
    <button id="disconnectStravaBtn" class="btn btn-danger">
      Koble fra
    </button>
  </div>

  <div class="strava-sync-options">
    <h4>Synkroniseringsinnstillinger</h4>
    <label>
      <input type="checkbox" id="autoSyncStrava" checked>
      Automatisk synkronisering etter økter
    </label>
    <label>
      <input type="checkbox" id="stravaPrivate">
      Marker økter som private
    </label>
  </div>
</div>

<!-- Add to session history -->
<div class="session-strava-status">
  <span class="strava-badge strava-synced">
    ✓ Synkronisert til Strava
  </span>
  <!-- or -->
  <button class="btn-small btn-primary upload-to-strava" data-session-id="123">
    Last opp til Strava
  </button>
</div>
```

**JavaScript**
```javascript
// In app.js

async function checkStravaConnection() {
  const response = await fetch('/api/strava/status');
  const data = await response.json();

  if (data.connected) {
    document.getElementById('stravaDisconnected').classList.add('hidden');
    document.getElementById('stravaConnected').classList.remove('hidden');
    document.getElementById('stravaAthleteName').textContent = data.athlete_name;
    document.getElementById('stravaUsername').textContent = data.athlete_username;
    document.getElementById('stravaConnectedAt').textContent = new Date(data.connected_at).toLocaleDateString('nb-NO');
  } else {
    document.getElementById('stravaDisconnected').classList.remove('hidden');
    document.getElementById('stravaConnected').classList.add('hidden');
  }
}

document.getElementById('connectStravaBtn').addEventListener('click', () => {
  window.location.href = '/auth/strava';
});

document.getElementById('disconnectStravaBtn').addEventListener('click', async () => {
  if (confirm('Er du sikker på at du vil koble fra Strava?')) {
    await fetch('/api/strava/disconnect', { method: 'DELETE' });
    checkStravaConnection();
  }
});

// Auto-upload after session end
async function endSession() {
  // ... existing code ...

  // Check if auto-sync is enabled
  const autoSync = document.getElementById('autoSyncStrava')?.checked;
  if (autoSync && currentSession) {
    await uploadToStrava(currentSession);
  }
}

async function uploadToStrava(sessionId) {
  try {
    const response = await fetch(`/api/strava/upload/${sessionId}`, {
      method: 'POST'
    });
    const data = await response.json();

    if (data.success) {
      alert('✅ Økten lastes opp til Strava!');
    }
  } catch (error) {
    console.error('Strava upload failed:', error);
    alert('❌ Kunne ikke laste opp til Strava: ' + error.message);
  }
}
```

---

## 🔒 Sikkerhet & Beste Praksis

### Miljøvariabler (.env.local)
```bash
# NEVER commit these to git!
STRAVA_CLIENT_ID=12345
STRAVA_CLIENT_SECRET=abc123def456...
APP_URL=https://192.168.1.12:3001
```

### .gitignore
```
.env.local
*.db
strava_tokens.json
```

### Sikkerhetstiltak
1. **Aldri commit client_secret til git**
2. **Krypter tokens i database** (vurder SQLCipher)
3. **Valider alle inputs**
4. **Rate limiting** - respekter Stravas 200/15min limit
5. **Retry logic** - håndter midlertidige feil
6. **Error logging** - logg feil uten å eksponere tokens

---

## ⚠️ Utfordringer & Løsninger

### Utfordring 1: OAuth på lokalt nettverk
**Problem**: Strava krever HTTPS for callback URL, men vi kjører på lokalt nettverk.

**Løsninger**:
- ✅ **HTTPS med self-signed cert** (allerede implementert!)
- ✅ **Bruk localhost:3001** for utvikling
- 🔄 **ngrok/cloudflared tunnel** for ekstern tilgang
- 🔄 **Registrer lokalt hostname** i Strava API settings

### Utfordring 2: Token utløp
**Problem**: Access tokens utløper etter ~6 timer.

**Løsning**:
- ✅ **Refresh token automatisk** før hver upload
- ✅ **Lagre expires_at timestamp**
- ✅ **Retry upload ved 401 Unauthorized**

### Utfordring 3: Duplikater
**Problem**: Samme økt kan lastes opp flere ganger.

**Løsning**:
- ✅ **Bruk external_id** (`treadmill_{session_id}`)
- ✅ **Track strava_activity_id** i database
- ✅ **Deaktiver upload-knapp** hvis allerede synkronisert

### Utfordring 4: Manglende GPS data
**Problem**: Tredemølle har ikke GPS-koordinater.

**Løsning**:
- ✅ **Marker som "trainer: true"** i upload
- ✅ **TCX støtter aktiviteter uten GPS**
- ✅ Strava viser som "Indoor Run" automatisk

### Utfordring 5: Rate limiting
**Problem**: 200 requests/15 min kan overskrides ved batch upload.

**Løsning**:
- ✅ **Queue system** for uploads
- ✅ **Respekter X-RateLimit-* headers**
- ✅ **Exponential backoff** ved 429 Too Many Requests

---

## 📊 Hva Strava vil vise

### Data som overføres:
- ✅ **Tid** (total duration)
- ✅ **Distanse** (total distance)
- ✅ **Puls** (avg, max, time series)
- ✅ **Tempo/pace** (beregnet fra distanse/tid)
- ✅ **Kalorier**
- ✅ **Type**: Running (Indoor)
- ✅ **Equipment**: "Treadmill" (auto-detected)

### Data som IKKE overføres:
- ❌ GPS-koordinater (ingen kart)
- ❌ Stigning/elevation (TCX støtter det ikke for indoor)
- ❌ Kadans (kan legges til i Extensions)
- ❌ Power data (ikke relevant for løping)

### Slik ser det ut i Strava:
```
🏃 Indoor Run
📍 Location: Indoor
⏱️ Time: 30:00
📏 Distance: 5.00 km
⚡ Pace: 6:00 /km
❤️ Avg HR: 155 bpm (Max: 178 bpm)
🔥 Calories: 450 kcal
```

---

## 🚀 Implementation Plan

### Phase 1: OAuth Setup (2-3 timer)
1. Registrere app hos Strava
2. Lagre credentials i .env.local
3. Implementere OAuth flow (authorize, callback, token storage)
4. Lage Strava connection UI

### Phase 2: TCX Generator (2-3 timer)
1. Implementere generateTCX() function
2. Teste TCX format med sample data
3. Validere mot TCX schema

### Phase 3: Upload Logic (2-3 timer)
1. Implementere upload endpoint
2. Token refresh logic
3. Error handling & retry
4. Status tracking

### Phase 4: UI Integration (1-2 timer)
1. "Last opp til Strava" knapp i historikk
2. Auto-sync toggle
3. Upload status indicators
4. Strava-tab med connection status

### Phase 5: Testing & Refinement (2-3 timer)
1. Test med ekte Strava account
2. Verify data accuracy
3. Handle edge cases
4. Add rate limiting

**Total estimat: 9-14 timer**

---

## 🎯 MVP vs Full Feature

### MVP (Minimum Viable Product)
- ✅ OAuth connection
- ✅ Manual upload av fullførte økter
- ✅ Basic TCX generation (time, distance, HR)
- ✅ Connection status UI

### Full Feature
- ✅ Auto-sync toggle
- ✅ Batch upload (sync alle økter)
- ✅ Upload queue med retry
- ✅ Detailed error messages
- ✅ Private/public toggle per activity
- ✅ Activity name/description customization
- ✅ Strava gear selection
- ✅ Upload progress indicator

---

## 🔮 Fremtidige muligheter

### Bi-directional sync
- Hent planned workouts fra Strava
- Sync external runs tilbake til app

### Advanced analytics
- Compare treadmill vs outdoor performance
- Track fitness trends from Strava data

### Social features
- Share workouts directly to Strava feed
- Kudos integration
- Club challenges

---

## 📝 Konklusjon

**Strava-integrasjon er definitivt mulig og gjennomførbart!**

**Fordeler:**
- ✅ Veldig verdi for brukere (de fleste løpere bruker Strava)
- ✅ Profesjonell feeling
- ✅ Automatisk backup av treningsdata
- ✅ Sosial motivasjon

**Ulemper:**
- ⚠️ OAuth complexity (men godt dokumentert)
- ⚠️ Rate limiting (men sjelden problem for single user)
- ⚠️ Token management (men standardisert)
- ⚠️ Krever Strava-konto (gratis)

**Anbefaling**: Implementer dette! Start med MVP, utvid etterhvert.

---

*Sist oppdatert: 2026-02-25 — Implementasjon fullført*
