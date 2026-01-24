const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
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
    FOREIGN KEY (session_id) REFERENCES workout_sessions(id) ON DELETE CASCADE
  );
`);

// API Routes
app.get('/api/workouts', (req, res) => {
  const workouts = db.prepare(`
    SELECT w.*, COUNT(ws.id) as segment_count
    FROM workouts w
    LEFT JOIN workout_segments ws ON w.id = ws.workout_id
    GROUP BY w.id
    ORDER BY w.created_at DESC
  `).all();
  res.json(workouts);
});

// Get template workouts - MUST come before /api/workouts/:id
app.get('/api/workouts/templates', (req, res) => {
  const templates = db.prepare(`
    SELECT w.*, COUNT(ws.id) as segment_count
    FROM workouts w
    LEFT JOIN workout_segments ws ON w.id = ws.workout_id
    WHERE w.is_template = 1
    GROUP BY w.id
    ORDER BY w.id ASC
  `).all();
  res.json(templates);
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

    const { speed_kmh, incline_percent, distance_km, heart_rate } = req.body;

    // Validate and sanitize
    const speed = parseFloat(speed_kmh) || 0;
    const incline = parseFloat(incline_percent) || 0;
    const distance = parseFloat(distance_km) || 0;
    const hr = heart_rate && !isNaN(parseInt(heart_rate)) ? parseInt(heart_rate) : null;

    db.prepare(`
      INSERT INTO session_data (session_id, speed_kmh, incline_percent, distance_km, heart_rate)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, Math.max(0, speed), Math.max(0, incline), Math.max(0, distance), hr);

    res.json({ success: true });
  } catch (error) {
    console.error('Error adding session data:', error);
    res.status(500).json({ error: 'Kunne ikke lagre data' });
  }
});

// Get detailed session data
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

// Initialize template workouts if not exists
function initializeTemplates() {
  const templateCount = db.prepare('SELECT COUNT(*) as count FROM workouts WHERE is_template = 1').get();

  if (templateCount.count === 0) {
    console.log('Initializing template workouts...');

    const templates = [
      {
        name: 'Couch to 5K - Uke 1',
        description: 'Den klassiske Couch to 5K programmet. Perfekt for absolutte nybegynnere. Veksler mellom gange og jogging for å bygge utholdenhet.',
        difficulty: 'beginner',
        segments: [
          { name: 'Oppvarming', duration: 300, speed: 5.0, incline: 0 },
          { name: 'Jogg 1', duration: 60, speed: 7.0, incline: 0 },
          { name: 'Gange 1', duration: 90, speed: 5.0, incline: 0 },
          { name: 'Jogg 2', duration: 60, speed: 7.0, incline: 0 },
          { name: 'Gange 2', duration: 90, speed: 5.0, incline: 0 },
          { name: 'Jogg 3', duration: 60, speed: 7.0, incline: 0 },
          { name: 'Gange 3', duration: 90, speed: 5.0, incline: 0 },
          { name: 'Jogg 4', duration: 60, speed: 7.0, incline: 0 },
          { name: 'Gange 4', duration: 90, speed: 5.0, incline: 0 },
          { name: 'Jogg 5', duration: 60, speed: 7.0, incline: 0 },
          { name: 'Nedkjøling', duration: 300, speed: 4.0, incline: 0 }
        ]
      },
      {
        name: 'HIIT - High Intensity Interval Training',
        description: 'Inspirert av Tabata-metoden. Korte, intense intervaller etterfulgt av aktiv hvile. Effektiv for fettforbrenning og kondisjonsforbedring på kort tid.',
        difficulty: 'intermediate',
        segments: [
          { name: 'Oppvarming', duration: 300, speed: 6.0, incline: 0 },
          { name: 'Sprint 1', duration: 30, speed: 12.0, incline: 0 },
          { name: 'Hvile 1', duration: 60, speed: 5.0, incline: 0 },
          { name: 'Sprint 2', duration: 30, speed: 12.0, incline: 0 },
          { name: 'Hvile 2', duration: 60, speed: 5.0, incline: 0 },
          { name: 'Sprint 3', duration: 30, speed: 12.0, incline: 0 },
          { name: 'Hvile 3', duration: 60, speed: 5.0, incline: 0 },
          { name: 'Sprint 4', duration: 30, speed: 12.0, incline: 0 },
          { name: 'Hvile 4', duration: 60, speed: 5.0, incline: 0 },
          { name: 'Sprint 5', duration: 30, speed: 12.0, incline: 0 },
          { name: 'Hvile 5', duration: 60, speed: 5.0, incline: 0 },
          { name: 'Sprint 6', duration: 30, speed: 12.0, incline: 0 },
          { name: 'Nedkjøling', duration: 300, speed: 4.5, incline: 0 }
        ]
      },
      {
        name: 'Hill Climbing - Fjelltrening',
        description: 'Klassisk stigningstrening inspirert av fjellløpere. Bygger styrke i beina og forbedrer anaerob kapasitet. Økende vanskelighetsgrad.',
        difficulty: 'intermediate',
        segments: [
          { name: 'Oppvarming flat', duration: 300, speed: 6.0, incline: 0 },
          { name: 'Lett stigning', duration: 180, speed: 7.0, incline: 3 },
          { name: 'Flat hvile', duration: 120, speed: 5.5, incline: 0 },
          { name: 'Middels stigning', duration: 180, speed: 6.5, incline: 6 },
          { name: 'Flat hvile', duration: 120, speed: 5.5, incline: 0 },
          { name: 'Bratt stigning', duration: 180, speed: 6.0, incline: 9 },
          { name: 'Flat hvile', duration: 120, speed: 5.5, incline: 0 },
          { name: 'Maksimal stigning', duration: 120, speed: 5.5, incline: 12 },
          { name: 'Nedkjøling', duration: 360, speed: 4.5, incline: 0 }
        ]
      },
      {
        name: 'Steady State - Langkjøring',
        description: 'Basert på Maffetone-metoden. Moderat intensitet over lengre tid for å bygge aerob kapasitet. Perfekt for å øke utholdenhet.',
        difficulty: 'beginner',
        segments: [
          { name: 'Oppvarming', duration: 300, speed: 5.5, incline: 0 },
          { name: 'Steady pace', duration: 1200, speed: 8.0, incline: 0 },
          { name: 'Nedkjøling', duration: 300, speed: 5.0, incline: 0 }
        ]
      },
      {
        name: 'Pyramid Intervals - Pyramidetrening',
        description: 'Progressiv intervalltrening inspirert av Jack Daniels Running Formula. Økende og deretter minkende intensitet - bygger både fart og utholdenhet.',
        difficulty: 'intermediate',
        segments: [
          { name: 'Oppvarming', duration: 300, speed: 6.0, incline: 0 },
          { name: 'Intervall 1 min', duration: 60, speed: 10.0, incline: 0 },
          { name: 'Hvile', duration: 60, speed: 5.5, incline: 0 },
          { name: 'Intervall 2 min', duration: 120, speed: 9.5, incline: 0 },
          { name: 'Hvile', duration: 90, speed: 5.5, incline: 0 },
          { name: 'Intervall 3 min', duration: 180, speed: 9.0, incline: 0 },
          { name: 'Hvile', duration: 120, speed: 5.5, incline: 0 },
          { name: 'Intervall 4 min', duration: 240, speed: 8.5, incline: 0 },
          { name: 'Hvile', duration: 120, speed: 5.5, incline: 0 },
          { name: 'Intervall 3 min', duration: 180, speed: 9.0, incline: 0 },
          { name: 'Hvile', duration: 90, speed: 5.5, incline: 0 },
          { name: 'Intervall 2 min', duration: 120, speed: 9.5, incline: 0 },
          { name: 'Hvile', duration: 60, speed: 5.5, incline: 0 },
          { name: 'Intervall 1 min', duration: 60, speed: 10.0, incline: 0 },
          { name: 'Nedkjøling', duration: 300, speed: 4.5, incline: 0 }
        ]
      }
    ];

    templates.forEach(template => {
      const workoutResult = db.prepare(`
        INSERT INTO workouts (name, description, difficulty, is_template)
        VALUES (?, ?, ?, 1)
      `).run(template.name, template.description, template.difficulty);

      const workoutId = workoutResult.lastInsertRowid;

      template.segments.forEach((segment, index) => {
        db.prepare(`
          INSERT INTO workout_segments (workout_id, segment_order, duration_seconds, speed_kmh, incline_percent, segment_name)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(workoutId, index, segment.duration, segment.speed, segment.incline, segment.name);
      });
    });

    console.log('Template workouts initialized successfully!');
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
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`WebSocket server running on ws://${HOST}:${PORT}`);
});
