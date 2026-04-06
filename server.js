const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const Database = require('better-sqlite3');

const crypto = require('crypto');
const TTSService = require('./tts-service');
const CoachingEngine = require('./coaching-engine');

const app = express();

// --- Dual HTTP / HTTPS server setup ---
const HTTP_PORT = parseInt(process.env.HTTP_PORT, 10) || 3000;
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 3001;
const HOST = '0.0.0.0';

const httpServer = http.createServer(app);

const certsExist = fs.existsSync('./certs/server.key') && fs.existsSync('./certs/server.crt');
let httpsServer = null;
if (certsExist) {
  const httpsOptions = {
    key: fs.readFileSync('./certs/server.key'),
    cert: fs.readFileSync('./certs/server.crt')
  };
  httpsServer = https.createServer(httpsOptions, app);
}

// WebSocket servers — one per HTTP(S) server
const wssHTTP = new WebSocket.Server({ server: httpServer });
const wssHTTPS = httpsServer ? new WebSocket.Server({ server: httpsServer }) : null;

// --- Shared client tracking across both WS servers ---
// Map<ws, { role: string|null, registeredAt: Date|null, bleBackend: string|null }>
const clients = new Map();
const pendingCommands = new Map(); // Map<commandId, { viewer: ws, timer: Timeout }>

let latestTreadmillState = null;
let latestDeviceStatus = null;

// Middleware
app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);
        // Allow local network and localhost
        if (origin.match(/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/)) {
            return callback(null, true);
        }
        callback(new Error('Not allowed by CORS'));
    }
}));
app.use(express.json({ limit: '1mb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.static('public'));
app.use('/audio', express.static(path.join(__dirname, 'tts-cache')));

// Database setup
const dbPath = process.env.DATABASE_PATH || './data/treadmill.db';
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS workouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    difficulty TEXT DEFAULT 'beginner',
    is_template INTEGER DEFAULT 0,
    tags TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workout_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_id INTEGER NOT NULL,
    segment_order INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL,
    speed_kmh REAL NOT NULL,
    incline_percent REAL DEFAULT 0,
    segment_name TEXT,
    FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workout_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_id INTEGER,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    total_distance_km REAL,
    total_time_seconds INTEGER,
    avg_heart_rate INTEGER,
    calories_burned INTEGER,
    heart_rate_source TEXT DEFAULT 'none',
    FOREIGN KEY (workout_id) REFERENCES workouts(id)
  );

  CREATE TABLE IF NOT EXISTS session_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    speed_kmh REAL,
    incline_percent REAL,
    distance_km REAL,
    heart_rate INTEGER,
    calories INTEGER,
    FOREIGN KEY (session_id) REFERENCES workout_sessions(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS strava_auth (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    athlete_id INTEGER UNIQUE NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    scope TEXT,
    athlete_name TEXT,
    connected_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_session_data_session_id ON session_data(session_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_workout_sessions_started_at ON workout_sessions(started_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_workout_segments_workout_id ON workout_segments(workout_id)`);

// Add Strava columns to workout_sessions if missing
try { db.exec('ALTER TABLE workout_sessions ADD COLUMN strava_activity_id INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE workout_sessions ADD COLUMN strava_upload_status TEXT'); } catch(e) {}

// Add segment_index column to session_data if missing
try { db.exec('ALTER TABLE session_data ADD COLUMN segment_index INTEGER'); } catch(e) {}

// User profiles for TTS coaching
db.exec(`
  CREATE TABLE IF NOT EXISTS user_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    max_hr INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Add target_max_zone and profile_id columns
try { db.exec('ALTER TABLE workouts ADD COLUMN target_max_zone INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE workout_segments ADD COLUMN target_max_zone INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE workout_sessions ADD COLUMN profile_id INTEGER'); } catch(e) {}

// Add profile_id to strava_auth for per-profile Strava connections
try { db.exec('ALTER TABLE strava_auth ADD COLUMN profile_id INTEGER'); } catch(e) {}

// HR zone control columns
try { db.exec('ALTER TABLE workout_segments ADD COLUMN hr_zone_control INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec("ALTER TABLE workout_segments ADD COLUMN hr_zone_control_mode TEXT DEFAULT 'speed'"); } catch(e) {}
try { db.exec('ALTER TABLE workouts ADD COLUMN hr_zone_eligible INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE workout_sessions ADD COLUMN hr_zone_control_enabled INTEGER DEFAULT 0'); } catch(e) {}

// --- TTS and Coaching setup ---
const ttsService = new TTSService({
  apiKey: process.env.OPENAI_API_KEY || null,
  voice: process.env.TTS_VOICE || 'nova',
  a2dpSink: process.env.A2DP_SINK || null
});

let activeCoachingEngine = null;
const ttsConfigs = new Map(); // Map<ws, { enabled, target, profileId }>

// HR zone eligibility heuristic
function calculateHRZoneEligible(segments) {
  if (!segments || !Array.isArray(segments)) return 0;
  return segments.some(seg =>
    (seg.target_max_zone || 0) > 0 &&
    (seg.duration_seconds || seg.duration || 0) >= 180
  ) ? 1 : 0;
}

// API Routes
app.get('/api/workouts', (req, res) => {
  const workouts = db.prepare(`
    SELECT 
      w.*, 
      COUNT(ws.id) as segment_count,
      COALESCE(SUM(ws.duration_seconds), 0) as total_duration_seconds,
      COALESCE(SUM(ws.duration_seconds * ws.speed_kmh / 3600.0), 0) as total_distance_km
    FROM workouts w
    LEFT JOIN workout_segments ws ON w.id = ws.workout_id
    GROUP BY w.id
    ORDER BY w.created_at DESC
  `).all();

  // Parse tags from JSON string
  const workoutsWithTags = workouts.map(w => {
    try { w.tags = JSON.parse(w.tags); } catch { w.tags = []; }
    return { ...w };
  });

  res.json(workoutsWithTags);
});

// Get template workouts - MUST come before /api/workouts/:id
app.get('/api/workouts/templates', (req, res) => {
  const templates = db.prepare(`
    SELECT 
      w.*, 
      COUNT(ws.id) as segment_count,
      COALESCE(SUM(ws.duration_seconds), 0) as total_duration_seconds,
      COALESCE(SUM(ws.duration_seconds * ws.speed_kmh / 3600.0), 0) as total_distance_km
    FROM workouts w
    LEFT JOIN workout_segments ws ON w.id = ws.workout_id
    WHERE w.is_template = 1
    GROUP BY w.id
    ORDER BY w.id ASC
  `).all();

  const templatesWithTags = templates.map(t => {
    try { t.tags = JSON.parse(t.tags); } catch { t.tags = []; }
    return { ...t };
  });

  res.json(templatesWithTags);
});

app.get('/api/workouts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Ugyldig ID' });
    }

    const workout = db.prepare('SELECT * FROM workouts WHERE id = ?').get(id);
    if (!workout) {
      return res.status(404).json({ error: 'Treningsøkt ikke funnet' });
    }

    // Parse tags if present
    if (workout.tags) {
      try {
        workout.tags = JSON.parse(workout.tags);
      } catch (e) {
        workout.tags = [];
      }
    }

    const segments = db.prepare('SELECT * FROM workout_segments WHERE workout_id = ? ORDER BY segment_order').all(id);
    res.json({ ...workout, segments });
  } catch (error) {
    console.error('Error fetching workout:', error);
    res.status(500).json({ error: 'Kunne ikke hente treningsøkt' });
  }
});

app.post('/api/workouts', (req, res) => {
  try {
    const { name, description, difficulty, segments } = req.body;

    // Validation
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Navn er påkrevd' });
    }

    if (name.length > 200) {
      return res.status(400).json({ error: 'Navn kan ikke være lengre enn 200 tegn' });
    }

    const validDifficulties = ['beginner', 'intermediate', 'advanced'];
    const validatedDifficulty = validDifficulties.includes(difficulty) ? difficulty : 'beginner';

    const insert = db.prepare('INSERT INTO workouts (name, description, difficulty) VALUES (?, ?, ?)');
    const result = insert.run(
      name.trim(),
      description ? description.trim().substring(0, 1000) : '',
      validatedDifficulty
    );
    const workoutId = result.lastInsertRowid;

    if (segments && Array.isArray(segments) && segments.length > 0) {
      const insertSegment = db.prepare(`
        INSERT INTO workout_segments (workout_id, segment_order, duration_seconds, speed_kmh, incline_percent, segment_name, target_max_zone, hr_zone_control, hr_zone_control_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      segments.forEach((segment, index) => {
        // Validate segment data
        const duration = parseInt(segment.duration_seconds) || 60;
        const speed = parseFloat(segment.speed_kmh) || 0;
        const incline = parseFloat(segment.incline_percent) || 0;

        // Bounds checking
        const validDuration = Math.max(1, Math.min(7200, duration)); // 1 sec to 2 hours
        const validSpeed = Math.max(0, Math.min(14, speed)); // 0-14 km/h
        const validIncline = Math.max(0, Math.min(12, incline)); // 0-12%

        insertSegment.run(
          workoutId,
          index,
          validDuration,
          validSpeed,
          validIncline,
          segment.segment_name ? segment.segment_name.substring(0, 100) : null,
          segment.target_max_zone || null,
          segment.hr_zone_control || 0,
          segment.hr_zone_control_mode || 'speed'
        );
      });
    }

    // Calculate and set hr_zone_eligible
    const hrEligible = calculateHRZoneEligible(segments);
    db.prepare('UPDATE workouts SET hr_zone_eligible = ? WHERE id = ?').run(hrEligible, workoutId);

    res.json({ id: workoutId, name: name.trim(), description, difficulty: validatedDifficulty });
  } catch (error) {
    console.error('Error creating workout:', error);
    res.status(500).json({ error: 'Kunne ikke opprette treningsøkt' });
  }
});

app.put('/api/workouts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Ugyldig ID' });
    }

    const { name, description, difficulty, segments } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Navn er påkrevd' });
    }

    if (name.length > 200) {
      return res.status(400).json({ error: 'Navn kan ikke være lengre enn 200 tegn' });
    }

    const existing = db.prepare('SELECT id FROM workouts WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Treningsøkt ikke funnet' });
    }

    const validDifficulties = ['beginner', 'intermediate', 'advanced'];
    const validatedDifficulty = validDifficulties.includes(difficulty) ? difficulty : 'beginner';

    const updateWorkout = db.prepare('UPDATE workouts SET name = ?, description = ?, difficulty = ? WHERE id = ?');
    const deleteSegments = db.prepare('DELETE FROM workout_segments WHERE workout_id = ?');
    const insertSegment = db.prepare(`
      INSERT INTO workout_segments (workout_id, segment_order, duration_seconds, speed_kmh, incline_percent, segment_name, target_max_zone, hr_zone_control, hr_zone_control_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      updateWorkout.run(name.trim(), description ? description.trim().substring(0, 1000) : '', validatedDifficulty, id);
      deleteSegments.run(id);

      if (segments && Array.isArray(segments) && segments.length > 0) {
        segments.forEach((segment, index) => {
          const duration = parseInt(segment.duration_seconds) || 60;
          const speed = parseFloat(segment.speed_kmh) || 0;
          const incline = parseFloat(segment.incline_percent) || 0;

          const validDuration = Math.max(1, Math.min(7200, duration));
          const validSpeed = Math.max(0, Math.min(14, speed));
          const validIncline = Math.max(0, Math.min(12, incline));

          insertSegment.run(
            id,
            index,
            validDuration,
            validSpeed,
            validIncline,
            segment.segment_name ? segment.segment_name.substring(0, 100) : null,
            segment.target_max_zone || null,
            segment.hr_zone_control || 0,
            segment.hr_zone_control_mode || 'speed'
          );
        });
      }
    })();

    // Recalculate hr_zone_eligible
    const freshSegments = db.prepare('SELECT target_max_zone, duration_seconds FROM workout_segments WHERE workout_id = ?').all(id);
    const hrEligible = calculateHRZoneEligible(freshSegments);
    db.prepare('UPDATE workouts SET hr_zone_eligible = ? WHERE id = ?').run(hrEligible, id);

    const updated = db.prepare('SELECT * FROM workouts WHERE id = ?').get(id);
    if (updated.tags) {
      try { updated.tags = JSON.parse(updated.tags); } catch { updated.tags = []; }
    }
    const updatedSegments = db.prepare('SELECT * FROM workout_segments WHERE workout_id = ? ORDER BY segment_order').all(id);
    res.json({ ...updated, segments: updatedSegments });
  } catch (error) {
    console.error('Error updating workout:', error);
    res.status(500).json({ error: 'Kunne ikke oppdatere treningsøkt' });
  }
});

app.delete('/api/workouts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Ugyldig ID' });
    }

    const result = db.prepare('DELETE FROM workouts WHERE id = ?').run(id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Treningsøkt ikke funnet' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting workout:', error);
    res.status(500).json({ error: 'Kunne ikke slette treningsøkt' });
  }
});

// --- Profile API routes ---

app.get('/api/profiles', (req, res) => {
  const profiles = db.prepare('SELECT * FROM user_profiles ORDER BY name ASC').all();
  res.json(profiles);
});

app.get('/api/profiles/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Ugyldig ID' });
  const profile = db.prepare('SELECT * FROM user_profiles WHERE id = ?').get(id);
  if (!profile) return res.status(404).json({ error: 'Profil ikke funnet' });
  res.json(profile);
});

app.post('/api/profiles', (req, res) => {
  try {
    const { name, max_hr } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Navn er påkrevd' });
    const hr = parseInt(max_hr);
    if (isNaN(hr) || hr < 100 || hr > 250) return res.status(400).json({ error: 'MaxHR må være mellom 100 og 250' });
    const result = db.prepare('INSERT INTO user_profiles (name, max_hr) VALUES (?, ?)').run(name.trim(), hr);
    res.json({ id: result.lastInsertRowid, name: name.trim(), max_hr: hr });
  } catch (error) {
    if (error.message && error.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'En profil med dette navnet finnes allerede' });
    }
    console.error('Error creating profile:', error);
    res.status(500).json({ error: 'Kunne ikke opprette profil' });
  }
});

app.put('/api/profiles/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Ugyldig ID' });
  const { name, max_hr } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Navn er påkrevd' });
  const hr = parseInt(max_hr);
  if (isNaN(hr) || hr < 100 || hr > 250) return res.status(400).json({ error: 'MaxHR må være mellom 100 og 250' });
  try {
    const result = db.prepare('UPDATE user_profiles SET name = ?, max_hr = ? WHERE id = ?').run(name.trim(), hr, id);
    if (result.changes === 0) return res.status(404).json({ error: 'Profil ikke funnet' });
    res.json({ id, name: name.trim(), max_hr: hr });
  } catch (error) {
    if (error.message && error.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'En profil med dette navnet finnes allerede' });
    }
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Kunne ikke oppdatere profil' });
  }
});

app.delete('/api/profiles/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Ugyldig ID' });
  const result = db.prepare('DELETE FROM user_profiles WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Profil ikke funnet' });
  res.json({ success: true });
});

app.delete('/api/sessions/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Ugyldig ID' });
    }

    const result = db.prepare('DELETE FROM workout_sessions WHERE id = ?').run(id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Økt ikke funnet' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).json({ error: 'Kunne ikke slette økt' });
  }
});

app.get('/api/sessions', (req, res) => {
  const { limit: limitParam, offset: offsetParam, startDate, endDate, profileId } = req.query;
  const limit = Math.min(parseInt(limitParam) || 50, 100);
  const offset = parseInt(offsetParam) || 0;

  // Build WHERE clause dynamically for date and profile filtering
  const conditions = [];
  const params = [];

  if (startDate) {
    conditions.push('s.started_at >= ?');
    params.push(startDate);
  }
  if (endDate) {
    conditions.push('s.started_at <= ?');
    params.push(endDate);
  }
  if (profileId) {
    conditions.push('s.profile_id = ?');
    params.push(parseInt(profileId));
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) as count FROM workout_sessions s ${whereClause}`).get(...params).count;

  const sessions = db.prepare(`
    SELECT s.*, w.name as workout_name, p.name as profile_name
    FROM workout_sessions s
    LEFT JOIN workouts w ON s.workout_id = w.id
    LEFT JOIN user_profiles p ON s.profile_id = p.id
    ${whereClause}
    ORDER BY s.started_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  res.json({ sessions, total, limit, offset });
});

app.post('/api/sessions', (req, res) => {
  try {
    const { workout_id, heart_rate_source, profile_id } = req.body;
    const validWorkoutId = workout_id && !isNaN(parseInt(workout_id)) ? parseInt(workout_id) : null;
    const validHRSource = heart_rate_source || 'none';
    const validProfileId = profile_id && !isNaN(parseInt(profile_id)) ? parseInt(profile_id) : null;

    const insert = db.prepare('INSERT INTO workout_sessions (workout_id, heart_rate_source, profile_id, hr_zone_control_enabled) VALUES (?, ?, ?, ?)');
    const result = insert.run(validWorkoutId, validHRSource, validProfileId, req.body.hr_zone_control_enabled ? 1 : 0);
    console.log(`Session ${result.lastInsertRowid} created (workout: ${validWorkoutId || 'manual'}, HR source: ${validHRSource}, profile: ${validProfileId || 'none'})`);
    res.json({ id: result.lastInsertRowid });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ error: 'Kunne ikke opprette økt' });
  }
});

app.put('/api/sessions/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Ugyldig ID' });
    }

    const existing = db.prepare('SELECT completed_at FROM workout_sessions WHERE id = ?').get(id);
    if (existing && existing.completed_at) {
        return res.status(409).json({ error: 'Session already completed' });
    }

    const { total_distance_km, total_time_seconds, avg_heart_rate, calories_burned } = req.body;

    // Validate and sanitize data
    const distance = parseFloat(total_distance_km) || 0;
    const time = parseInt(total_time_seconds) || 0;
    const hr = avg_heart_rate && !isNaN(parseInt(avg_heart_rate)) ? parseInt(avg_heart_rate) : null;
    const calories = parseInt(calories_burned) || 0;

    const result = db.prepare(`
      UPDATE workout_sessions
      SET completed_at = CURRENT_TIMESTAMP,
          total_distance_km = ?,
          total_time_seconds = ?,
          avg_heart_rate = ?,
          calories_burned = ?
      WHERE id = ?
    `).run(Math.max(0, distance), Math.max(0, time), hr, Math.max(0, calories), id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Økt ikke funnet' });
    }

    console.log(`Session ${id} completed: ${distance}km, ${time}s, HR:${hr || 'n/a'}, Cal:${calories}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating session:', error);
    res.status(500).json({ error: 'Kunne ikke oppdatere økt' });
  }
});

// Update session profile (works on both active and completed sessions)
app.patch('/api/sessions/:id/profile', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Ugyldig ID' });
    }

    const { profile_id } = req.body;
    const validProfileId = profile_id && !isNaN(parseInt(profile_id)) ? parseInt(profile_id) : null;

    const existing = db.prepare('SELECT id FROM workout_sessions WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Økt ikke funnet' });
    }

    db.prepare('UPDATE workout_sessions SET profile_id = ? WHERE id = ?').run(validProfileId, id);

    const profileName = validProfileId
      ? (db.prepare('SELECT name FROM user_profiles WHERE id = ?').get(validProfileId)?.name || null)
      : null;

    console.log(`Session ${id} profile updated to: ${profileName || 'none'} (${validProfileId})`);
    res.json({ success: true, profile_id: validProfileId, profile_name: profileName });
  } catch (error) {
    console.error('Error updating session profile:', error);
    res.status(500).json({ error: 'Kunne ikke oppdatere profil' });
  }
});

app.post('/api/sessions/:id/data', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Ugyldig ID' });
    }

    const { speed_kmh, incline_percent, distance_km, heart_rate, calories, segment_index } = req.body;
    if (speed_kmh !== undefined && (typeof speed_kmh !== 'number' || speed_kmh < 0 || speed_kmh > 30)) {
        console.warn(`Rejected data for session ${id}: invalid speed_kmh`, JSON.stringify(req.body));
        return res.status(400).json({ error: 'Invalid speed_kmh' });
    }
    if (incline_percent !== undefined && (typeof incline_percent !== 'number' || incline_percent < -5 || incline_percent > 20)) {
        console.warn(`Rejected data for session ${id}: invalid incline_percent`, JSON.stringify(req.body));
        return res.status(400).json({ error: 'Invalid incline_percent' });
    }
    if (heart_rate !== undefined && heart_rate !== null && (typeof heart_rate !== 'number' || heart_rate < 0 || heart_rate > 250)) {
        console.warn(`Rejected data for session ${id}: invalid heart_rate`, JSON.stringify(req.body));
        return res.status(400).json({ error: 'Invalid heart_rate' });
    }

    // Validate and sanitize
    const speed = parseFloat(speed_kmh) || 0;
    const incline = parseFloat(incline_percent) || 0;
    const distance = parseFloat(distance_km) || 0;
    const hr = heart_rate && !isNaN(parseInt(heart_rate)) ? parseInt(heart_rate) : null;
    const cal = calories && !isNaN(parseInt(calories)) ? parseInt(calories) : null;
    const segIdx = (segment_index !== undefined && segment_index !== null && !isNaN(parseInt(segment_index))) ? parseInt(segment_index) : null;

    db.prepare(`
      INSERT INTO session_data (session_id, speed_kmh, incline_percent, distance_km, heart_rate, calories, segment_index)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, Math.max(0, speed), Math.max(0, incline), Math.max(0, distance), hr, cal, segIdx);

    res.json({ success: true });
  } catch (error) {
    console.error('Error adding session data:', error);
    res.status(500).json({ error: 'Kunne ikke lagre data' });
  }
});

// Get detailed session data
// Get session stats calculated from data points
app.get('/api/sessions/:id/stats', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Ugyldig ID' });
    }

    // Calculate stats from actual data points
    const stats = db.prepare(`
      SELECT
        MAX(distance_km) as max_distance,
        COUNT(*) as total_seconds,
        AVG(CASE WHEN heart_rate > 0 AND heart_rate < 255 THEN heart_rate ELSE NULL END) as avg_heart_rate,
        MAX(calories) as max_calories
      FROM session_data
      WHERE session_id = ?
    `).get(id);

    res.json({
      max_distance: stats.max_distance || 0,
      total_seconds: stats.total_seconds || 0,
      avg_heart_rate: stats.avg_heart_rate ? Math.round(stats.avg_heart_rate) : null,
      max_calories: stats.max_calories || 0
    });
  } catch (error) {
    console.error('Error calculating session stats:', error);
    res.status(500).json({ error: 'Kunne ikke beregne øktstatistikk' });
  }
});

app.get('/api/sessions/:id/details', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Ugyldig ID' });
    }

    const session = db.prepare(`
      SELECT s.*, w.name as workout_name
      FROM workout_sessions s
      LEFT JOIN workouts w ON s.workout_id = w.id
      WHERE s.id = ?
    `).get(id);

    if (!session) {
      return res.status(404).json({ error: 'Økt ikke funnet' });
    }

    const dataPoints = db.prepare(`
      SELECT * FROM session_data
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `).all(id);

    res.json({ ...session, dataPoints });
  } catch (error) {
    console.error('Error fetching session details:', error);
    res.status(500).json({ error: 'Kunne ikke hente øktdetaljer' });
  }
});

// Export session as JSON
app.get('/api/sessions/:id/export/json', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Ugyldig ID' });
    }

    const session = db.prepare(`
      SELECT s.*, w.name as workout_name
      FROM workout_sessions s
      LEFT JOIN workouts w ON s.workout_id = w.id
      WHERE s.id = ?
    `).get(id);

    if (!session) {
      return res.status(404).json({ error: 'Økt ikke funnet' });
    }

    const dataPoints = db.prepare(`
      SELECT * FROM session_data
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `).all(id);

    const exportData = { ...session, dataPoints };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="session_${id}.json"`);
    res.json(exportData);
  } catch (error) {
    console.error('Error exporting session as JSON:', error);
    res.status(500).json({ error: 'Kunne ikke eksportere økt' });
  }
});

// Export session as CSV
app.get('/api/sessions/:id/export/csv', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Ugyldig ID' });
    }

    const session = db.prepare('SELECT * FROM workout_sessions WHERE id = ?').get(id);
    if (!session) {
      return res.status(404).json({ error: 'Økt ikke funnet' });
    }

    const dataPoints = db.prepare(`
      SELECT * FROM session_data
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `).all(id);

    let csv = 'Timestamp,Speed (km/h),Incline (%),Distance (km),Heart Rate (bpm),Calories\n';
    dataPoints.forEach(point => {
      csv += `${point.timestamp},${point.speed_kmh || 0},${point.incline_percent || 0},${point.distance_km || 0},${point.heart_rate || ''},${point.calories || ''}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="session_${id}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting session as CSV:', error);
    res.status(500).json({ error: 'Kunne ikke eksportere økt' });
  }
});

// Export session as TCX
app.get('/api/sessions/:id/export/tcx', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Ugyldig ID' });
    }

    const session = db.prepare(`
      SELECT s.*, w.name as workout_name
      FROM workout_sessions s
      LEFT JOIN workouts w ON s.workout_id = w.id
      WHERE s.id = ?
    `).get(id);

    if (!session) {
      return res.status(404).json({ error: 'Økt ikke funnet' });
    }

    const dataPoints = db.prepare(`
      SELECT * FROM session_data
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `).all(id);

    const tcxContent = generateTCX(session, dataPoints);

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="session_${id}.tcx"`);
    res.send(tcxContent);
  } catch (error) {
    console.error('Error exporting session as TCX:', error);
    res.status(500).json({ error: 'Kunne ikke eksportere økt' });
  }
});

// Get per-segment feedback for a session
app.get('/api/sessions/:id/segments', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: 'Ugyldig ID' });
    }

    const session = db.prepare('SELECT * FROM workout_sessions WHERE id = ?').get(id);
    if (!session) {
      return res.status(404).json({ error: 'Økt ikke funnet' });
    }

    const segments = db.prepare(`
      SELECT
        segment_index,
        AVG(speed_kmh) as avg_speed,
        AVG(CASE WHEN heart_rate > 0 AND heart_rate < 255 THEN heart_rate ELSE NULL END) as avg_heart_rate,
        MAX(CASE WHEN heart_rate > 0 AND heart_rate < 255 THEN heart_rate ELSE NULL END) as max_heart_rate,
        MAX(distance_km) - MIN(distance_km) as distance,
        COUNT(*) as time_seconds
      FROM session_data
      WHERE session_id = ? AND segment_index IS NOT NULL
      GROUP BY segment_index
      ORDER BY segment_index ASC
    `).all(id);

    const segmentSummaries = segments.map(seg => ({
      segment_index: seg.segment_index,
      avg_speed: seg.avg_speed ? Math.round(seg.avg_speed * 100) / 100 : 0,
      avg_heart_rate: seg.avg_heart_rate ? Math.round(seg.avg_heart_rate) : null,
      max_heart_rate: seg.max_heart_rate || null,
      distance: seg.distance ? Math.round(seg.distance * 1000) / 1000 : 0,
      time_seconds: seg.time_seconds || 0
    }));

    res.json(segmentSummaries);
  } catch (error) {
    console.error('Error fetching segment data:', error);
    res.status(500).json({ error: 'Kunne ikke hente segmentdata' });
  }
});

// Strava OAuth: Redirect to Strava authorize
app.get('/auth/strava', (req, res) => {
  const clientId = process.env.STRAVA_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: 'STRAVA_CLIENT_ID not configured' });
  }
  const profileId = req.query.profileId || '';
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/strava/callback`;
  const scope = 'activity:write,activity:read';
  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${encodeURIComponent(profileId)}`;
  res.redirect(authUrl);
});

// Strava OAuth: Callback — exchange code for tokens
app.get('/auth/strava/callback', async (req, res) => {
  const { code, state } = req.query;
  const profileId = state && !isNaN(parseInt(state)) ? parseInt(state) : null;

  if (!code) {
    return res.redirect('/?strava=error');
  }

  try {
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

    if (!response.ok) {
      console.error('Strava token exchange failed:', response.status);
      return res.redirect('/?strava=error');
    }

    const data = await response.json();

    db.prepare(`
      INSERT OR REPLACE INTO strava_auth (athlete_id, access_token, refresh_token, expires_at, scope, athlete_name, profile_id, connected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      data.athlete.id,
      data.access_token,
      data.refresh_token,
      data.expires_at,
      'activity:write,activity:read',
      `${data.athlete.firstname} ${data.athlete.lastname}`,
      profileId
    );

    console.log(`Strava connected: ${data.athlete.firstname} ${data.athlete.lastname} (athlete ${data.athlete.id}, profile ${profileId || 'none'})`);
    res.redirect('/?strava=connected');
  } catch (error) {
    console.error('Strava auth error:', error);
    res.redirect('/?strava=error');
  }
});

// Get Strava connection status
app.get('/api/strava/status', (req, res) => {
  try {
    const connections = db.prepare(`
      SELECT sa.athlete_id, sa.athlete_name, sa.profile_id, sa.connected_at, p.name as profile_name
      FROM strava_auth sa
      LEFT JOIN user_profiles p ON sa.profile_id = p.id
      ORDER BY sa.connected_at DESC
    `).all();

    res.json({
      connected: connections.length > 0,
      connections
    });
  } catch (error) {
    console.error('Error checking Strava status:', error);
    res.status(500).json({ error: 'Kunne ikke sjekke Strava-status' });
  }
});

// Disconnect Strava (per profile or all)
app.delete('/api/strava/disconnect', (req, res) => {
  try {
    const profileId = req.query.profileId;
    if (profileId) {
      const parsedId = parseInt(profileId);
      if (isNaN(parsedId)) return res.status(400).json({ error: 'Ugyldig profileId' });
      db.prepare('DELETE FROM strava_auth WHERE profile_id = ?').run(parsedId);
    } else {
      db.prepare('DELETE FROM strava_auth').run();
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error disconnecting Strava:', error);
    res.status(500).json({ error: 'Kunne ikke koble fra Strava' });
  }
});

// Upload session to Strava
app.post('/api/strava/upload/:sessionId', async (req, res) => {
  const sessionId = parseInt(req.params.sessionId);
  if (isNaN(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: 'Ugyldig session ID' });
  }

  try {
    const session = db.prepare(`
      SELECT s.*, w.name as workout_name
      FROM workout_sessions s
      LEFT JOIN workouts w ON s.workout_id = w.id
      WHERE s.id = ?
    `).get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Økt ikke funnet' });
    }

    const accessToken = await getValidStravaToken(session.profile_id);

    const dataPoints = db.prepare(`
      SELECT * FROM session_data
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `).all(sessionId);

    if (dataPoints.length === 0) {
      return res.status(400).json({ error: 'Økten har ingen datapunkter å laste opp' });
    }

    // Generate TCX file
    const tcxContent = generateTCX(session, dataPoints);

    // Upload to Strava via multipart/form-data
    const formData = new FormData();
    formData.append('file', new Blob([tcxContent], { type: 'application/xml' }), 'activity.tcx');
    formData.append('data_type', 'tcx');
    formData.append('name', session.workout_name || 'Tredemølle-økt');
    formData.append('description', `${Math.round((session.total_distance_km || 0) * 1000)}m, ${Math.floor((session.total_time_seconds || 0) / 60)} min`);
    formData.append('trainer', 'true');
    // Note: Strava API no longer supports setting privacy via API.
    // User must set default privacy to "Only You" in Strava settings.
    formData.append('external_id', `treadmill_${sessionId}`);

    const uploadResponse = await fetch('https://www.strava.com/api/v3/uploads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      },
      body: formData
    });

    const uploadData = await uploadResponse.json();

    if (!uploadResponse.ok) {
      db.prepare(`
        UPDATE workout_sessions
        SET strava_upload_status = 'failed'
        WHERE id = ?
      `).run(sessionId);
      console.error('Strava upload error:', uploadData);
      return res.status(uploadResponse.status).json({ error: 'Strava-opplasting feilet. Prøv igjen senere.' });
    }

    // Update session with upload status
    db.prepare(`
      UPDATE workout_sessions
      SET strava_upload_status = 'uploading', strava_activity_id = ?
      WHERE id = ?
    `).run(uploadData.activity_id || null, sessionId);

    res.json({
      success: true,
      upload_id: uploadData.id,
      status: uploadData.status,
      activity_id: uploadData.activity_id
    });
  } catch (error) {
    console.error('Strava upload error:', error);

    db.prepare(`
      UPDATE workout_sessions
      SET strava_upload_status = 'failed'
      WHERE id = ?
    `).run(sessionId);

    res.status(500).json({ error: error.message });
  }
});

// Get overall statistics
app.get('/api/stats/overall', (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_sessions,
      SUM(total_distance_km) as total_distance,
      SUM(total_time_seconds) as total_time,
      SUM(calories_burned) as total_calories,
      AVG(avg_heart_rate) as overall_avg_hr,
      MAX(total_distance_km) as longest_distance,
      MAX(total_time_seconds) as longest_time
    FROM workout_sessions
    WHERE completed_at IS NOT NULL
  `).get();

  // Get recent activity (last 7 days)
  const recentActivity = db.prepare(`
    SELECT
      DATE(started_at) as date,
      COUNT(*) as session_count,
      SUM(total_distance_km) as distance,
      SUM(total_time_seconds) as time
    FROM workout_sessions
    WHERE completed_at IS NOT NULL
      AND started_at >= datetime('now', '-7 days')
    GROUP BY DATE(started_at)
    ORDER BY date DESC
  `).all();

  // Get average stats per session
  const avgStats = db.prepare(`
    SELECT
      AVG(total_distance_km) as avg_distance,
      AVG(total_time_seconds) as avg_time,
      AVG(calories_burned) as avg_calories,
      AVG(avg_heart_rate) as avg_hr
    FROM workout_sessions
    WHERE completed_at IS NOT NULL
  `).get();

  // Get personal records
  const records = {
    fastestPace: db.prepare(`
      SELECT id, started_at, total_distance_km, total_time_seconds,
             CASE WHEN total_distance_km > 0 THEN (total_time_seconds / 60.0) / total_distance_km ELSE 0 END as pace
      FROM workout_sessions
      WHERE completed_at IS NOT NULL
        AND total_distance_km > 0
        AND total_time_seconds > 0
      ORDER BY pace ASC
      LIMIT 1
    `).get(),
    longestDistance: db.prepare(`
      SELECT id, started_at, total_distance_km, total_time_seconds
      FROM workout_sessions
      WHERE completed_at IS NOT NULL
      ORDER BY total_distance_km DESC
      LIMIT 1
    `).get(),
    longestTime: db.prepare(`
      SELECT id, started_at, total_distance_km, total_time_seconds
      FROM workout_sessions
      WHERE completed_at IS NOT NULL
      ORDER BY total_time_seconds DESC
      LIMIT 1
    `).get(),
    mostCalories: db.prepare(`
      SELECT id, started_at, calories_burned, total_distance_km
      FROM workout_sessions
      WHERE completed_at IS NOT NULL
      ORDER BY calories_burned DESC
      LIMIT 1
    `).get()
  };

  res.json({ ...stats, avgStats, recentActivity, records });
});

// Get weekly statistics
app.get('/api/stats/weekly', (req, res) => {
  const weeklyData = db.prepare(`
    SELECT
      strftime('%Y-%W', started_at) as week,
      strftime('%Y', started_at) as year,
      COUNT(*) as session_count,
      SUM(total_distance_km) as total_distance,
      SUM(total_time_seconds) as total_time,
      SUM(calories_burned) as total_calories,
      AVG(avg_heart_rate) as avg_hr
    FROM workout_sessions
    WHERE completed_at IS NOT NULL
      AND started_at >= datetime('now', '-12 weeks')
    GROUP BY week
    ORDER BY week DESC
  `).all();

  res.json(weeklyData);
});

// Get monthly statistics
app.get('/api/stats/monthly', (req, res) => {
  const monthlyData = db.prepare(`
    SELECT
      strftime('%Y-%m', started_at) as month,
      COUNT(*) as session_count,
      SUM(total_distance_km) as total_distance,
      SUM(total_time_seconds) as total_time,
      SUM(calories_burned) as total_calories,
      AVG(avg_heart_rate) as avg_hr
    FROM workout_sessions
    WHERE completed_at IS NOT NULL
      AND started_at >= datetime('now', '-12 months')
    GROUP BY month
    ORDER BY month DESC
  `).all();

  res.json(monthlyData);
});

// Initialize template workouts from JSON file
function initializeTemplates() {
  try {
    const templatesPath = path.join(__dirname, 'templates.json');

    if (!fs.existsSync(templatesPath)) {
      console.log('⚠️  templates.json not found, skipping template initialization.');
      return;
    }

    const templatesData = fs.readFileSync(templatesPath, 'utf8');
    const templates = JSON.parse(templatesData);

    if (!Array.isArray(templates)) {
      console.error('❌ templates.json must contain an array of template objects.');
      return;
    }

    // Ensure tags column exists (simple migration)
    try {
      db.prepare("SELECT tags FROM workouts LIMIT 1").get();
    } catch (err) {
      console.log('🔄 Adding tags column to workouts table...');
      db.exec("ALTER TABLE workouts ADD COLUMN tags TEXT DEFAULT '[]'");
    }

    console.log(`📂 Found ${templates.length} templates in templates.json. Syncing...`);

    let addedCount = 0;
    let updatedCount = 0;

    const insertWorkout = db.prepare(`
      INSERT INTO workouts (name, description, difficulty, is_template, tags, target_max_zone, hr_zone_eligible)
      VALUES (?, ?, ?, 1, ?, ?, ?)
    `);

    const updateWorkout = db.prepare(`
        UPDATE workouts
        SET description = ?, difficulty = ?, tags = ?, target_max_zone = ?
        WHERE id = ?
    `);

    const deleteSegments = db.prepare('DELETE FROM workout_segments WHERE workout_id = ?');

    const insertSegment = db.prepare(`
      INSERT INTO workout_segments (workout_id, segment_order, duration_seconds, speed_kmh, incline_percent, segment_name, target_max_zone, hr_zone_control, hr_zone_control_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      templates.forEach(template => {
        const existing = db.prepare('SELECT id FROM workouts WHERE name = ? AND is_template = 1').get(template.name);
        const tagsJson = JSON.stringify(template.tags || []);

        if (!existing) {
          console.log(`   ➕ Adding new template: ${template.name}`);

          const eligible = calculateHRZoneEligible((template.segments || []).map(s => ({
            target_max_zone: s.target_max_zone, duration_seconds: s.duration
          })));
          const result = insertWorkout.run(
            template.name,
            template.description || '',
            template.difficulty || 'beginner',
            tagsJson,
            template.target_max_zone || null,
            eligible
          );
          const workoutId = result.lastInsertRowid;

          if (template.segments && Array.isArray(template.segments)) {
            template.segments.forEach((segment, index) => {
              const segTargetZone = segment.target_max_zone || null;
              const segDuration = segment.duration || 60;
              const segIncline = segment.incline || 0;
              const hrControl = (segTargetZone && segDuration >= 180) ? (segment.hr_zone_control !== undefined ? segment.hr_zone_control : 0) : 0;
              const hrMode = segment.hr_zone_control_mode || (segIncline > 2 ? 'incline' : 'speed');
              insertSegment.run(
                workoutId,
                index,
                segDuration,
                segment.speed || 0,
                segIncline,
                segment.name || null,
                segTargetZone,
                hrControl,
                hrMode
              );
            });
          }
          addedCount++;
        } else {
          // Update existing template to ensure tags, description and zones are fresh
          updateWorkout.run(
            template.description || '',
            template.difficulty || 'beginner',
            tagsJson,
            template.target_max_zone || null,
            existing.id
          );

          // Re-insert segments to ensure they match JSON
          deleteSegments.run(existing.id);
          if (template.segments && Array.isArray(template.segments)) {
            template.segments.forEach((segment, index) => {
              const segTargetZone = segment.target_max_zone || null;
              const segDuration = segment.duration || 60;
              const segIncline = segment.incline || 0;
              const hrControl = (segTargetZone && segDuration >= 180) ? (segment.hr_zone_control !== undefined ? segment.hr_zone_control : 0) : 0;
              const hrMode = segment.hr_zone_control_mode || (segIncline > 2 ? 'incline' : 'speed');
              insertSegment.run(
                existing.id,
                index,
                segDuration,
                segment.speed || 0,
                segIncline,
                segment.name || null,
                segTargetZone,
                hrControl,
                hrMode
              );
            });
          }
          updatedCount++;
        }
      });
    })();

    // Calculate hr_zone_eligible for all templates
    const allTemplates = db.prepare('SELECT id FROM workouts WHERE is_template = 1').all();
    const updateEligible = db.prepare('UPDATE workouts SET hr_zone_eligible = ? WHERE id = ?');
    allTemplates.forEach(t => {
      const segs = db.prepare('SELECT target_max_zone, duration_seconds FROM workout_segments WHERE workout_id = ?').all(t.id);
      updateEligible.run(calculateHRZoneEligible(segs), t.id);
    });

    if (addedCount > 0 || updatedCount > 0) {
      console.log(`✅ Synced templates: ${addedCount} added, ${updatedCount} updated.`);
    } else {
      console.log('✅ All templates are up to date.');
    }

  } catch (error) {
    console.error('❌ Error initializing templates:', error);
  }
}

// Initialize templates on startup
initializeTemplates();

// Strava helper: Get valid access token (refresh if expired)
async function getValidStravaToken(profileId = null) {
  const auth = profileId
    ? db.prepare('SELECT * FROM strava_auth WHERE profile_id = ?').get(profileId)
    : db.prepare('SELECT * FROM strava_auth ORDER BY connected_at DESC LIMIT 1').get();

  if (!auth) {
    throw new Error(profileId ? `Profile ${profileId} not connected to Strava` : 'Not connected to Strava');
  }

  const now = Math.floor(Date.now() / 1000);

  // Token still valid (5 min buffer)
  if (auth.expires_at > now + 300) {
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

  if (!response.ok) {
    throw new Error('Failed to refresh Strava token');
  }

  const data = await response.json();

  // Update tokens in database
  db.prepare(`
    UPDATE strava_auth
    SET access_token = ?, refresh_token = ?, expires_at = ?
    WHERE id = ?
  `).run(data.access_token, data.refresh_token, data.expires_at, auth.id);

  return data.access_token;
}

// Strava helper: Generate TCX (Training Center XML) from session data
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
  const maxHR = dataPoints.length > 0 ? Math.max(...dataPoints.map(p => p.heart_rate || 0)) : 0;

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Running">
      <Id>${startTime}</Id>
      <Lap StartTime="${startTime}">
        <TotalTimeSeconds>${session.total_time_seconds || 0}</TotalTimeSeconds>
        <DistanceMeters>${((session.total_distance_km || 0) * 1000).toFixed(2)}</DistanceMeters>
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

// ---------------------------------------------------------------------------
// Coaching helpers
// ---------------------------------------------------------------------------

function startCoaching(profileId, workoutId) {
  const profile = profileId ? db.prepare('SELECT * FROM user_profiles WHERE id = ?').get(profileId) : null;
  if (!profile) return null;

  const segments = db.prepare(
    'SELECT segment_order, duration_seconds, speed_kmh, incline_percent, segment_name, target_max_zone FROM workout_segments WHERE workout_id = ? ORDER BY segment_order'
  ).all(workoutId);

  const workout = db.prepare('SELECT target_max_zone FROM workouts WHERE id = ?').get(workoutId);

  // Fill in workout-level target zone where segment doesn't have one
  const enrichedSegments = segments.map(s => ({
    ...s,
    target_max_zone: s.target_max_zone || (workout ? workout.target_max_zone : null)
  }));

  // Stop any existing engine first
  if (activeCoachingEngine) {
    activeCoachingEngine.stop();
    activeCoachingEngine = null;
  }

  const engine = new CoachingEngine({
    maxHR: profile.max_hr,
    segments: enrichedSegments,
    ttsService,
    onMessage: (text, filename) => {
      deliverTTS(text, filename);
    }
  });

  engine.start();
  return engine;
}

function deliverTTS(text, filename) {
  let deliveredToViewer = false;
  console.log(`🔊 Delivering TTS: "${text.substring(0, 40)}..." to ${ttsConfigs.size} viewer(s), file=${filename ? 'yes' : 'no'}`);

  for (const [ws, config] of ttsConfigs) {
    console.log(`   Viewer config: enabled=${config.enabled}, target=${config.target}, profileId=${config.profileId}, wsOpen=${ws.readyState === WebSocket.OPEN}`);
    if (!config.enabled) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;

    if (config.target === 'client' || config.target === 'both') {
      if (filename) {
        ws.send(JSON.stringify({ type: 'tts', url: '/audio/' + filename }));
      } else {
        ws.send(JSON.stringify({ type: 'tts_text', text }));
      }
      deliveredToViewer = true;
    }

    if (config.target === 'speaker' || config.target === 'both') {
      if (filename) ttsService.playOnSpeaker(filename);
    }
  }

  // Fallback: if no viewer has TTS enabled but A2DP speaker is configured
  if (!deliveredToViewer && filename) {
    ttsService.playOnSpeaker(filename);
  }
}

function stopCoaching() {
  if (activeCoachingEngine) {
    activeCoachingEngine.stop();
    activeCoachingEngine = null;
  }
}

// ---------------------------------------------------------------------------
// WebSocket hub — shared across HTTP and HTTPS servers
// ---------------------------------------------------------------------------

/** Broadcast a message to every connected client (all roles, including unregistered). */
function broadcast(data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

/** Broadcast a message only to viewer clients. */
function broadcastToViewers(data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const [ws, info] of clients) {
    if (info.role === 'viewer' && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

/** Find the active controller — native BLE backend takes priority. */
function getActiveController() {
  let best = null;
  for (const [ws, info] of clients) {
    if (info.role === 'controller' && ws.readyState === WebSocket.OPEN) {
      if (info.bleBackend === 'native') return ws;
      if (!best) best = ws;
    }
  }
  return best;
}

/** Handle an incoming WebSocket connection (shared logic for both servers). */
function handleConnection(ws, req) {
  // Validate origin — only allow local network connections
  const origin = req.headers.origin || '';
  if (origin && !origin.match(/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/)) {
    ws.close(1008, 'Origin not allowed');
    return;
  }

  // Track every connection immediately (role starts as null)
  clients.set(ws, { role: null, registeredAt: null, bleBackend: null });
  console.log(`Client connected (total: ${clients.size})`);

  // Hydrate new client with cached state
  if (latestTreadmillState) {
    ws.send(JSON.stringify(latestTreadmillState));
  }
  if (latestDeviceStatus) {
    ws.send(JSON.stringify(latestDeviceStatus));
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (typeof data !== 'object' || data === null) return;

      // --- Role registration ---
      if (data.type === 'register') {
        const role = data.role === 'controller' ? 'controller' : 'viewer';
        const info = clients.get(ws);
        if (info) {
          info.role = role;
          info.registeredAt = new Date();
          info.bleBackend = data.bleBackend || null;
        }
        ws.send(JSON.stringify({ type: 'registered', role }));
        console.log(`Client registered as ${role}` + (data.bleBackend ? ` (bleBackend: ${data.bleBackend})` : ''));
        return;
      }

      // --- TTS config from viewer ---
      if (data.type === 'tts_config') {
        console.log(`🎙️  TTS config received: enabled=${data.enabled}, target=${data.target}, profileId=${data.profileId}`);
        ttsConfigs.set(ws, {
          enabled: !!data.enabled,
          target: data.target || 'client',
          profileId: data.profileId || null
        });

        // Late coaching start: if session is already active and coaching not running
        if (data.enabled && data.profileId && !activeCoachingEngine && latestTreadmillState && latestTreadmillState.sessionActive) {
          const workoutId = latestTreadmillState.workout ? latestTreadmillState.workout.workoutId : null;
          if (workoutId) {
            activeCoachingEngine = startCoaching(data.profileId, workoutId);
            if (activeCoachingEngine) {
              console.log(`🎙️  Late coaching start (profile: ${data.profileId}, workout: ${workoutId})`);
            }
          }
        }
        return;
      }

      // --- Command from viewer → forward to controller ---
      if (data.type === 'command') {
        const info = clients.get(ws);

        // list_workouts is handled directly by the server
        if (data.command === 'list_workouts') {
          try {
            const workouts = db.prepare(`
              SELECT w.*, COUNT(ws.id) as segment_count,
                COALESCE(SUM(ws.duration_seconds), 0) as total_duration_seconds
              FROM workouts w
              LEFT JOIN workout_segments ws ON w.id = ws.workout_id
              GROUP BY w.id ORDER BY w.created_at DESC
            `).all();
            ws.send(JSON.stringify({
              type: 'command_response',
              commandId: data.commandId || null,
              command: 'list_workouts',
              success: true,
              data: workouts
            }));
          } catch (err) {
            ws.send(JSON.stringify({
              type: 'command_response',
              commandId: data.commandId || null,
              command: 'list_workouts',
              success: false,
              error: err.message
            }));
          }
          return;
        }

        // All other commands → forward to the active controller
        const controller = getActiveController();
        if (!controller) {
          ws.send(JSON.stringify({
            type: 'command_response',
            commandId: data.commandId || null,
            command: data.command,
            success: false,
            error: 'No controller connected'
          }));
          return;
        }

        const commandId = data.commandId || crypto.randomUUID();

        // BLE operations can take up to 60s; other commands 10s
        const isBleCommand = data.command && data.command.indexOf('ble_') === 0;
        const timeoutMs = isBleCommand ? 60000 : 10000;
        const timer = setTimeout(() => {
          pendingCommands.delete(commandId);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'command_response',
              commandId,
              command: data.command,
              success: false,
              error: `Command timed out (${timeoutMs / 1000}s)`
            }));
          }
        }, timeoutMs);
        pendingCommands.set(commandId, { viewer: ws, timer, command: data.command });

        // Forward as remote_command to the controller
        controller.send(JSON.stringify({
          type: 'remote_command',
          commandId,
          command: data.command,
          params: data.params || {}
        }));
        return;
      }

      // --- Command response from controller → route back to viewer ---
      if (data.type === 'command_response' && data.commandId) {
        const pending = pendingCommands.get(data.commandId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingCommands.delete(data.commandId);
          if (pending.viewer.readyState === WebSocket.OPEN) {
            pending.viewer.send(JSON.stringify(data));
          }

          // Start coaching on successful start_session
          if (pending.command === 'start_session' && data.success && !activeCoachingEngine) {
            const workoutId = (data.data && data.data.workout_id) ? data.data.workout_id : null;
            if (workoutId) {
              for (const [, config] of ttsConfigs) {
                if (config.enabled && config.profileId) {
                  activeCoachingEngine = startCoaching(config.profileId, workoutId);
                  if (activeCoachingEngine) {
                    console.log(`🎙️  Coaching started (profile: ${config.profileId}, workout: ${workoutId})`);
                  }
                  break;
                }
              }
            }
          }
        }
        return;
      }

      // --- HR zone controller status messages ---
      if (data.type === 'hr_zone_status') {
        const ttsMessages = {
          'decrease_speed': data.toValue ? `Senker farten til ${data.toValue}.` : null,
          'increase_speed': data.toValue ? `Øker farten til ${data.toValue}.` : null,
          'decrease_incline': data.toValue ? `Senker stigningen til ${data.toValue} prosent.` : null,
          'increase_incline': data.toValue ? `Øker stigningen til ${data.toValue} prosent.` : null,
          'hrm_dropout': 'Mistet pulssignal. Holder nåværende fart.',
          'hrm_timeout': 'Sonestyring deaktivert. Ingen pulsdata.',
          'hrm_recovered': 'Pulssignal gjenopprettet. Gjenopptar sonestyring.',
          'safety_high_hr': 'Pulsen er svært høy. Senker farten for sikkerhet.',
          'sustained_overload': 'Pulsen er vedvarende høy. Vurder å stoppe.',
          'hrm_precaution': 'Senker farten som sikkerhetstiltak.',
          'disabled': data.reason === 'hrm_not_connected'
            ? 'Sonestyring deaktivert. Pulsmonitor ikke tilkoblet.'
            : 'Sonestyring deaktivert. Mangler pulsinformasjon.',
        };
        const msg = ttsMessages[data.action];
        if (msg) {
          (async () => {
            try {
              const filename = await ttsService.speak(msg);
              deliverTTS(msg, filename);
            } catch (e) { console.error('[TTS] HR zone message failed:', e.message); }
          })();
        }
        broadcast(data);
        return;
      }

      // --- Cache treadmill state for new-client hydration ---
      if (data.type === 'treadmill_state') {
        latestTreadmillState = data.sessionActive ? data : null;

        // Feed to active coaching engine
        if (activeCoachingEngine) {
          activeCoachingEngine.update(data);
        }

        // Detect session end → stop coaching
        if (!data.sessionActive && activeCoachingEngine) {
          stopCoaching();
        }
      }

      // --- Cache device status for new-client hydration ---
      if (data.type === 'device_status') {
        latestDeviceStatus = data;
      }

      // --- Default: broadcast to all connected clients ---
      broadcast(data);
    } catch { return; }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    const roleLabel = info ? (info.role || 'unregistered') : 'unknown';
    clients.delete(ws);
    ttsConfigs.delete(ws);

    // Clean up any pending commands from this client
    for (const [cmdId, pending] of pendingCommands) {
      if (pending.viewer === ws) {
        clearTimeout(pending.timer);
        pendingCommands.delete(cmdId);
      }
    }

    // If a controller disconnected, clear cached state
    if (info && info.role === 'controller') {
      latestTreadmillState = null;
      latestDeviceStatus = null;
      broadcast({ type: 'controller_disconnected' });
    }

    console.log(`Client disconnected (${roleLabel}, remaining: ${clients.size})`);
  });
}

// Wire up both WebSocket servers to the shared handler
wssHTTP.on('connection', handleConnection);
if (wssHTTPS) {
  wssHTTPS.on('connection', handleConnection);
}

// ---------------------------------------------------------------------------
// Start servers
// ---------------------------------------------------------------------------
httpServer.listen(HTTP_PORT, HOST, () => {
  console.log(`HTTP  server running on http://${HOST}:${HTTP_PORT}`);
  console.log(`WS    server running on ws://${HOST}:${HTTP_PORT}`);
});

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, HOST, () => {
    console.log(`HTTPS server running on https://${HOST}:${HTTPS_PORT}`);
    console.log(`WSS   server running on wss://${HOST}:${HTTPS_PORT}`);
  });
} else {
  console.log('HTTPS disabled (certificates not found in ./certs/)');
}
