const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const Database = require('better-sqlite3');

const app = express();

// Check if SSL certificates exist
const useHTTPS = fs.existsSync('./certs/server.key') && fs.existsSync('./certs/server.crt');

let server;
if (useHTTPS) {
  const httpsOptions = {
    key: fs.readFileSync('./certs/server.key'),
    cert: fs.readFileSync('./certs/server.crt')
  };
  server = https.createServer(httpsOptions, app);
  console.log('🔒 HTTPS enabled');
} else {
  server = http.createServer(app);
  console.log('⚠️  HTTP mode (HTTPS certificates not found)');
}

const wss = new WebSocket.Server({ server });
let latestTreadmillState = null;

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
app.use(express.static('public'));

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
        INSERT INTO workout_segments (workout_id, segment_order, duration_seconds, speed_kmh, incline_percent, segment_name)
        VALUES (?, ?, ?, ?, ?, ?)
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
          segment.segment_name ? segment.segment_name.substring(0, 100) : null
        );
      });
    }

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
      INSERT INTO workout_segments (workout_id, segment_order, duration_seconds, speed_kmh, incline_percent, segment_name)
      VALUES (?, ?, ?, ?, ?, ?)
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
            segment.segment_name ? segment.segment_name.substring(0, 100) : null
          );
        });
      }
    })();

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
  const { limit: limitParam, offset: offsetParam, startDate, endDate } = req.query;
  const limit = Math.min(parseInt(limitParam) || 50, 100);
  const offset = parseInt(offsetParam) || 0;

  // Build WHERE clause dynamically for date filtering
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

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) as count FROM workout_sessions s ${whereClause}`).get(...params).count;

  const sessions = db.prepare(`
    SELECT s.*, w.name as workout_name
    FROM workout_sessions s
    LEFT JOIN workouts w ON s.workout_id = w.id
    ${whereClause}
    ORDER BY s.started_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  res.json({ sessions, total, limit, offset });
});

app.post('/api/sessions', (req, res) => {
  try {
    const { workout_id, heart_rate_source } = req.body;
    const validWorkoutId = workout_id && !isNaN(parseInt(workout_id)) ? parseInt(workout_id) : null;
    const validHRSource = heart_rate_source || 'none';

    const insert = db.prepare('INSERT INTO workout_sessions (workout_id, heart_rate_source) VALUES (?, ?)');
    const result = insert.run(validWorkoutId, validHRSource);
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

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating session:', error);
    res.status(500).json({ error: 'Kunne ikke oppdatere økt' });
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
        return res.status(400).json({ error: 'Invalid speed_kmh' });
    }
    if (incline_percent !== undefined && (typeof incline_percent !== 'number' || incline_percent < -5 || incline_percent > 20)) {
        return res.status(400).json({ error: 'Invalid incline_percent' });
    }
    if (heart_rate !== undefined && (typeof heart_rate !== 'number' || heart_rate < 0 || heart_rate > 250)) {
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
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/strava/callback`;
  const scope = 'activity:write,activity:read';
  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}`;
  res.redirect(authUrl);
});

// Strava OAuth: Callback — exchange code for tokens
app.get('/auth/strava/callback', async (req, res) => {
  const { code } = req.query;

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
      INSERT OR REPLACE INTO strava_auth (athlete_id, access_token, refresh_token, expires_at, scope, athlete_name, connected_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      data.athlete.id,
      data.access_token,
      data.refresh_token,
      data.expires_at,
      'activity:write,activity:read',
      `${data.athlete.firstname} ${data.athlete.lastname}`
    );

    res.redirect('/?strava=connected');
  } catch (error) {
    console.error('Strava auth error:', error);
    res.redirect('/?strava=error');
  }
});

// Get Strava connection status
app.get('/api/strava/status', (req, res) => {
  try {
    const auth = db.prepare('SELECT * FROM strava_auth ORDER BY connected_at DESC LIMIT 1').get();

    if (!auth) {
      return res.json({ connected: false });
    }

    res.json({
      connected: true,
      athlete_id: auth.athlete_id,
      athlete_name: auth.athlete_name,
      connected_at: auth.connected_at
    });
  } catch (error) {
    console.error('Error checking Strava status:', error);
    res.status(500).json({ error: 'Kunne ikke sjekke Strava-status' });
  }
});

// Disconnect Strava
app.delete('/api/strava/disconnect', (req, res) => {
  try {
    db.prepare('DELETE FROM strava_auth').run();
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
    const accessToken = await getValidStravaToken();

    const session = db.prepare(`
      SELECT s.*, w.name as workout_name
      FROM workout_sessions s
      LEFT JOIN workouts w ON s.workout_id = w.id
      WHERE s.id = ?
    `).get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Økt ikke funnet' });
    }

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
      return res.status(uploadResponse.status).json({ error: uploadData.error || 'Strava upload failed', details: uploadData });
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
      INSERT INTO workouts (name, description, difficulty, is_template, tags)
      VALUES (?, ?, ?, 1, ?)
    `);

    const updateWorkout = db.prepare(`
        UPDATE workouts 
        SET description = ?, difficulty = ?, tags = ?
        WHERE id = ?
    `);

    const deleteSegments = db.prepare('DELETE FROM workout_segments WHERE workout_id = ?');

    const insertSegment = db.prepare(`
      INSERT INTO workout_segments (workout_id, segment_order, duration_seconds, speed_kmh, incline_percent, segment_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      templates.forEach(template => {
        const existing = db.prepare('SELECT id FROM workouts WHERE name = ? AND is_template = 1').get(template.name);
        const tagsJson = JSON.stringify(template.tags || []);

        if (!existing) {
          console.log(`   ➕ Adding new template: ${template.name}`);

          const result = insertWorkout.run(
            template.name,
            template.description || '',
            template.difficulty || 'beginner',
            tagsJson
          );
          const workoutId = result.lastInsertRowid;

          if (template.segments && Array.isArray(template.segments)) {
            template.segments.forEach((segment, index) => {
              insertSegment.run(
                workoutId,
                index,
                segment.duration || 60,
                segment.speed || 0,
                segment.incline || 0,
                segment.name || null
              );
            });
          }
          addedCount++;
        } else {
          // Update existing template to ensure tags and description are fresh
          // console.log(`   ↻ Updating existing template: ${template.name}`);
          updateWorkout.run(
            template.description || '',
            template.difficulty || 'beginner',
            tagsJson,
            existing.id
          );

          // Re-insert segments to ensure they match JSON
          deleteSegments.run(existing.id);
          if (template.segments && Array.isArray(template.segments)) {
            template.segments.forEach((segment, index) => {
              insertSegment.run(
                existing.id,
                index,
                segment.duration || 60,
                segment.speed || 0,
                segment.incline || 0,
                segment.name || null
              );
            });
          }
          updatedCount++;
        }
      });
    })();

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
async function getValidStravaToken() {
  const auth = db.prepare('SELECT * FROM strava_auth ORDER BY connected_at DESC LIMIT 1').get();

  if (!auth) {
    throw new Error('Not connected to Strava');
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

// WebSocket for real-time treadmill data
wss.on('connection', (ws) => {
  console.log('Client connected');

  // Send cached state to new clients immediately
  if (latestTreadmillState) {
    ws.send(JSON.stringify(latestTreadmillState));
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (typeof data !== 'object' || data === null) return;

      // Cache treadmill state for new client hydration
      if (data.type === 'treadmill_state') {
        latestTreadmillState = data.sessionActive ? data : null;
      }

      // Broadcast to all clients
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(data));
        }
      });
    } catch { return; }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  const protocol = useHTTPS ? 'https' : 'http';
  const wsProtocol = useHTTPS ? 'wss' : 'ws';
  console.log(`Server running on ${protocol}://${HOST}:${PORT}`);
  console.log(`WebSocket server running on ${wsProtocol}://${HOST}:${PORT}`);
});
