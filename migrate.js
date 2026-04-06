const Database = require('better-sqlite3');
const dbPath = process.env.DATABASE_PATH || './data/treadmill.db';
const db = new Database(dbPath);

console.log(`Starting database migration... (${dbPath})`);

try {
  const migrate = db.transaction(() => {
    // Check if columns exist
    const tableInfo = db.prepare("PRAGMA table_info(workouts)").all();
    const hasIsTemplate = tableInfo.some(col => col.name === 'is_template');
    const hasDifficulty = tableInfo.some(col => col.name === 'difficulty');

    if (!hasIsTemplate || !hasDifficulty) {
      console.log('Adding missing columns to workouts table...');

      if (!hasDifficulty) {
        db.exec(`ALTER TABLE workouts ADD COLUMN difficulty TEXT DEFAULT 'beginner'`);
        console.log('Added difficulty column');
      }

      if (!hasIsTemplate) {
        db.exec(`ALTER TABLE workouts ADD COLUMN is_template INTEGER DEFAULT 0`);
        console.log('Added is_template column');
      }
    }

    // Check workouts table for tags column
    const workoutsInfo = db.prepare("PRAGMA table_info(workouts)").all();
    const hasTags = workoutsInfo.some(col => col.name === 'tags');
    if (!hasTags) {
      console.log('Adding tags column to workouts table...');
      db.exec(`ALTER TABLE workouts ADD COLUMN tags TEXT DEFAULT '[]'`);
      console.log('Added tags column');
    }

    // Check segments table
    const segmentsInfo = db.prepare("PRAGMA table_info(workout_segments)").all();
    const hasSegmentName = segmentsInfo.some(col => col.name === 'segment_name');

    if (!hasSegmentName) {
      console.log('Adding segment_name column to workout_segments table...');
      db.exec(`ALTER TABLE workout_segments ADD COLUMN segment_name TEXT`);
      console.log('Added segment_name column');
    }

    // Check session_data table
    const sessionDataInfo = db.prepare("PRAGMA table_info(session_data)").all();
    const hasCalories = sessionDataInfo.some(col => col.name === 'calories');

    if (!hasCalories) {
      console.log('Adding calories column to session_data table...');
      db.exec(`ALTER TABLE session_data ADD COLUMN calories INTEGER`);
      console.log('Added calories column');
    }

    // Check for segment_index column in session_data
    const sessionDataInfo2 = db.prepare("PRAGMA table_info(session_data)").all();
    const hasSegmentIndex = sessionDataInfo2.some(col => col.name === 'segment_index');

    if (!hasSegmentIndex) {
      console.log('Adding segment_index column to session_data table...');
      db.exec(`ALTER TABLE session_data ADD COLUMN segment_index INTEGER`);
      console.log('Added segment_index column');
    }

    // Check workout_sessions table for heart_rate_source
    const sessionsInfo = db.prepare("PRAGMA table_info(workout_sessions)").all();
    const hasHRSource = sessionsInfo.some(col => col.name === 'heart_rate_source');

    if (!hasHRSource) {
      console.log('Adding heart_rate_source column to workout_sessions table...');
      db.exec(`ALTER TABLE workout_sessions ADD COLUMN heart_rate_source TEXT DEFAULT 'none'`);
      console.log('Added heart_rate_source column');
    }

    // Check workout_sessions table for Strava columns
    const sessionsInfo2 = db.prepare("PRAGMA table_info(workout_sessions)").all();
    const hasStravaActivityId = sessionsInfo2.some(col => col.name === 'strava_activity_id');
    const hasStravaUploadStatus = sessionsInfo2.some(col => col.name === 'strava_upload_status');

    if (!hasStravaActivityId) {
      console.log('Adding strava_activity_id column to workout_sessions table...');
      db.exec(`ALTER TABLE workout_sessions ADD COLUMN strava_activity_id INTEGER`);
      console.log('Added strava_activity_id column');
    }

    if (!hasStravaUploadStatus) {
      console.log('Adding strava_upload_status column to workout_sessions table...');
      db.exec(`ALTER TABLE workout_sessions ADD COLUMN strava_upload_status TEXT`);
      console.log('Added strava_upload_status column');
    }

    // Create user_profiles table
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        max_hr INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Ensured user_profiles table exists');

    // Add target_max_zone to workouts
    const workoutsInfo3 = db.prepare("PRAGMA table_info(workouts)").all();
    if (!workoutsInfo3.some(col => col.name === 'target_max_zone')) {
      db.exec('ALTER TABLE workouts ADD COLUMN target_max_zone INTEGER');
      console.log('Added target_max_zone column to workouts');
    }

    // Add target_max_zone to workout_segments
    const segmentsInfo2 = db.prepare("PRAGMA table_info(workout_segments)").all();
    if (!segmentsInfo2.some(col => col.name === 'target_max_zone')) {
      db.exec('ALTER TABLE workout_segments ADD COLUMN target_max_zone INTEGER');
      console.log('Added target_max_zone column to workout_segments');
    }

    // Add profile_id to workout_sessions
    const sessionsInfo3 = db.prepare("PRAGMA table_info(workout_sessions)").all();
    if (!sessionsInfo3.some(col => col.name === 'profile_id')) {
      db.exec('ALTER TABLE workout_sessions ADD COLUMN profile_id INTEGER');
      console.log('Added profile_id column to workout_sessions');
    }

    // HR zone control columns
    const segmentsInfo3 = db.prepare("PRAGMA table_info(workout_segments)").all();
    if (!segmentsInfo3.some(col => col.name === 'hr_zone_control')) {
      db.exec('ALTER TABLE workout_segments ADD COLUMN hr_zone_control INTEGER DEFAULT 0');
      console.log('Added hr_zone_control column to workout_segments');
    }
    if (!segmentsInfo3.some(col => col.name === 'hr_zone_control_mode')) {
      db.exec("ALTER TABLE workout_segments ADD COLUMN hr_zone_control_mode TEXT DEFAULT 'speed'");
      console.log('Added hr_zone_control_mode column to workout_segments');
    }

    const workoutsInfo4 = db.prepare("PRAGMA table_info(workouts)").all();
    if (!workoutsInfo4.some(col => col.name === 'hr_zone_eligible')) {
      db.exec('ALTER TABLE workouts ADD COLUMN hr_zone_eligible INTEGER DEFAULT 0');
      console.log('Added hr_zone_eligible column to workouts');
    }

    const sessionsInfo4 = db.prepare("PRAGMA table_info(workout_sessions)").all();
    if (!sessionsInfo4.some(col => col.name === 'hr_zone_control_enabled')) {
      db.exec('ALTER TABLE workout_sessions ADD COLUMN hr_zone_control_enabled INTEGER DEFAULT 0');
      console.log('Added hr_zone_control_enabled column to workout_sessions');
    }

    // Create strava_auth table if it doesn't exist
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
      )
    `);
    console.log('Ensured strava_auth table exists');

    // Add profile_id to strava_auth for per-profile Strava connections
    const stravaInfo = db.prepare("PRAGMA table_info(strava_auth)").all();
    if (!stravaInfo.some(col => col.name === 'profile_id')) {
      db.exec('ALTER TABLE strava_auth ADD COLUMN profile_id INTEGER');
      console.log('Added profile_id column to strava_auth');
    }
  });

  migrate();

  console.log('\nDatabase migration completed successfully!');
  console.log('You can now restart the server.');

} catch (error) {
  console.error('Migration failed:', error.message);
  process.exit(1);
}

db.close();
