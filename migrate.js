const Database = require('better-sqlite3');
const db = new Database('treadmill.db');

console.log('Starting database migration...');

try {
  // Check if columns exist
  const tableInfo = db.prepare("PRAGMA table_info(workouts)").all();
  const hasIsTemplate = tableInfo.some(col => col.name === 'is_template');
  const hasDifficulty = tableInfo.some(col => col.name === 'difficulty');

  if (!hasIsTemplate || !hasDifficulty) {
    console.log('Adding missing columns to workouts table...');

    if (!hasDifficulty) {
      db.exec(`ALTER TABLE workouts ADD COLUMN difficulty TEXT DEFAULT 'beginner'`);
      console.log('✓ Added difficulty column');
    }

    if (!hasIsTemplate) {
      db.exec(`ALTER TABLE workouts ADD COLUMN is_template INTEGER DEFAULT 0`);
      console.log('✓ Added is_template column');
    }
  }

  // Check segments table
  const segmentsInfo = db.prepare("PRAGMA table_info(workout_segments)").all();
  const hasSegmentName = segmentsInfo.some(col => col.name === 'segment_name');

  if (!hasSegmentName) {
    console.log('Adding segment_name column to workout_segments table...');
    db.exec(`ALTER TABLE workout_segments ADD COLUMN segment_name TEXT`);
    console.log('✓ Added segment_name column');
  }

  // Check session_data table
  const sessionDataInfo = db.prepare("PRAGMA table_info(session_data)").all();
  const hasCalories = sessionDataInfo.some(col => col.name === 'calories');

  if (!hasCalories) {
    console.log('Adding calories column to session_data table...');
    db.exec(`ALTER TABLE session_data ADD COLUMN calories INTEGER`);
    console.log('✓ Added calories column');
  }

  console.log('\n✅ Database migration completed successfully!');
  console.log('You can now restart the server.');

} catch (error) {
  console.error('❌ Migration failed:', error.message);
  process.exit(1);
}

db.close();
