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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database setup
const dbPath = process.env.DATABASE_PATH || 'treadmill.db';
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
  const workoutsWithTags = workouts.map(w => ({
    ...w,
    tags: w.tags ? JSON.parse(w.tags) : []
  }));

  res.json(workoutsWithTags);
});

// Get template workouts - MUST come before /api/workouts/:id
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

  const templatesWithTags = templates.map(t => ({
    ...t,
    tags: t.tags ? JSON.parse(t.tags) : []
  }));

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
  const sessions = db.prepare(`
    SELECT s.*, w.name as workout_name
    FROM workout_sessions s
    LEFT JOIN workouts w ON s.workout_id = w.id
    ORDER BY s.started_at DESC
    LIMIT 50
  `).all();
  res.json(sessions);
});

app.post('/api/sessions', (req, res) => {
  try {
    const { workout_id } = req.body;
    const validWorkoutId = workout_id && !isNaN(parseInt(workout_id)) ? parseInt(workout_id) : null;

    const insert = db.prepare('INSERT INTO workout_sessions (workout_id) VALUES (?)');
    const result = insert.run(validWorkoutId);
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

    const { speed_kmh, incline_percent, distance_km, heart_rate, calories } = req.body;

    // Validate and sanitize
    const speed = parseFloat(speed_kmh) || 0;
    const incline = parseFloat(incline_percent) || 0;
    const distance = parseFloat(distance_km) || 0;
    const hr = heart_rate && !isNaN(parseInt(heart_rate)) ? parseInt(heart_rate) : null;
    const cal = calories && !isNaN(parseInt(calories)) ? parseInt(calories) : null;

    db.prepare(`
      INSERT INTO session_data (session_id, speed_kmh, incline_percent, distance_km, heart_rate, calories)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, Math.max(0, speed), Math.max(0, incline), Math.max(0, distance), hr, cal);

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
             (total_time_seconds / 60.0) / total_distance_km as pace
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

// WebSocket for real-time treadmill data
wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      // Broadcast to all clients
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(data));
        }
      });
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
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
