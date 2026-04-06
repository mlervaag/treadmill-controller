# HR-sonestyrt trening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically adjust treadmill speed/incline to maintain a target HR zone, controlled server-side on RPi via native BLE service.

**Architecture:** New `HRZoneController` class in ble-service/, integrated into existing `executeSegment()` flow. Zone calculation shared via `hr-utils.js`. Server gets new DB columns, heuristic, and API updates. Frontend gets filter + toggle + live indicator.

**Tech Stack:** Node.js, better-sqlite3, WebSocket (ws), @abandonware/noble BLE, vanilla JS frontend

**Spec:** `docs/superpowers/specs/2026-04-06-hr-zone-controlled-training-design.md`

**No test suite exists** — verification is done via server logs, SSH to RPi, and manual testing.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `ble-service/hr-utils.js` | Create | Shared `getZone()` + zone boundaries |
| `ble-service/hr-zone-controller.js` | Create | Control loop class |
| `ble-service/ble-service.js` | Modify | Integrate controller into `executeSegment()`, add `set_speed`/`set_incline` commands, profile flow |
| `coaching-engine.js` | Modify | Import shared `getZone()`, suppress zone-violation under active HR control |
| `server.js` | Modify | DB migration, API updates, heuristic, template sync |
| `migrate.js` | Modify | DB migration (PRAGMA checks) |
| `templates.json` | Modify | New HR zone templates + `hr_zone_control` fields |
| `public/view.html` | Modify | Filter, toggle, live indicator, manual adjust buttons |
| `public/app.js` | Modify | Filter in workout list, historikk info |

---

### Task 1: Shared zone calculation utility

**Files:**
- Create: `ble-service/hr-utils.js`
- Modify: `coaching-engine.js:23-31`

- [ ] **Step 1: Create `ble-service/hr-utils.js`**

```javascript
// ble-service/hr-utils.js
// Shared HR zone calculation — used by both HRZoneController and CoachingEngine

const ZONE_BOUNDARIES = [
  { zone: 1, low: 0,  high: 60 },
  { zone: 2, low: 60, high: 70 },
  { zone: 3, low: 70, high: 80 },
  { zone: 4, low: 80, high: 90 },
  { zone: 5, low: 90, high: 100 },
];

function getZone(hr, maxHR) {
  if (!hr || hr <= 0 || !maxHR) return null;
  const pct = (hr / maxHR) * 100;
  if (pct < 60) return 1;
  if (pct < 70) return 2;
  if (pct < 80) return 3;
  if (pct < 90) return 4;
  return 5;
}

function getZoneBoundaries(zone) {
  return ZONE_BOUNDARIES.find(z => z.zone === zone) || null;
}

function getHRPercent(hr, maxHR) {
  if (!hr || !maxHR) return 0;
  return (hr / maxHR) * 100;
}

module.exports = { getZone, getZoneBoundaries, getHRPercent, ZONE_BOUNDARIES };
```

- [ ] **Step 2: Update `coaching-engine.js` to use shared module**

Replace the static `getZone` method at line 23-31 of `coaching-engine.js`.

The file is in the main server directory, but ble-service is a separate process. Copy or symlink won't work cleanly. Instead, keep the static method but also add a standalone export. The coaching-engine runs in Docker (server.js), so it can't import from ble-service/. 

**Decision: duplicate the utility.** Keep `CoachingEngine.getZone()` as-is for backwards compat (it's used by server.js), and create `ble-service/hr-utils.js` as the authoritative copy for ble-service code. Both are identical — 5 lines of code, no maintenance burden.

No change to `coaching-engine.js` in this step. The shared module is only for ble-service/ consumption.

- [ ] **Step 3: Verify the module loads**

```bash
ssh pi@192.168.1.12 "cd ~/treadmill-controller/ble-service && node -e \"const u = require('./hr-utils'); console.log(u.getZone(150, 190), u.getZoneBoundaries(3), u.getHRPercent(150, 190))\""
```

Expected: `3 { zone: 3, low: 70, high: 80 } 78.94736842105263`

- [ ] **Step 4: Commit**

```bash
git add ble-service/hr-utils.js
git commit -m "feat: add shared HR zone utility for ble-service"
```

---

### Task 2: HRZoneController class

**Files:**
- Create: `ble-service/hr-zone-controller.js`

- [ ] **Step 1: Create the controller class**

```javascript
// ble-service/hr-zone-controller.js
const { getZone, getZoneBoundaries, getHRPercent } = require('./hr-utils');

class HRZoneController {
  constructor({
    targetZone, maxHR, controlMode, initialSpeed, initialIncline,
    minSpeed = 3.0, maxSpeed = 14.0, minIncline = 0, maxIncline = 12,
    onSpeedChange, onInclineChange, onStatusChange, existingBuffer
  }) {
    this.targetZone = targetZone;
    this.maxHR = maxHR;
    this.controlMode = controlMode || 'speed'; // 'speed' | 'incline'
    this.currentSpeed = initialSpeed;
    this.currentIncline = initialIncline;
    this.minSpeed = minSpeed;
    this.maxSpeed = maxSpeed;
    this.minIncline = minIncline;
    this.maxIncline = maxIncline;
    this.onSpeedChange = onSpeedChange;
    this.onInclineChange = onInclineChange;
    this.onStatusChange = onStatusChange || (() => {});

    // Ring buffer for HR values
    this.ringBuffer = existingBuffer || [];
    this.ringBufferSize = 15;

    // Control state
    this.active = true;
    this.paused = false;
    this.pauseEndTime = 0;
    this.tickCount = 0;
    this.adjustInterval = 20;       // ticks (seconds) between adjustments
    this.lastAdjustTick = 0;
    this.accumulatedChange = 0;      // accumulated speed/incline change in current direction
    this.accumulationCap = 0.8;      // km/h or % — pause after this much accumulated change
    this.lastDirection = null;        // 'up' | 'down' | null
    this.directionChangeCooldownUntil = 0;
    this.adjustmentCount = 0;
    this.lastAction = null;
    this.previousHR = null;
    this.outlierCount = 0;
    this.hrmDropoutStart = null;
    this.hrmStatus = 'connected';     // 'connected' | 'dropout' | 'timeout'

    // Graduated resume after pause
    this.graduatedResumeTicksLeft = 0;
    this.graduatedResumeInterval = 30; // slower interval for first ticks after pause

    // Hysteresis: +2% maxHR for transitioning UP out of target zone
    this.hysteresis = 2; // percentage points of maxHR

    // Safety
    this.overloadStart = null; // time when sustained overload detected

    // Zone boundaries
    const bounds = getZoneBoundaries(targetZone);
    this.zoneLow = bounds ? bounds.low : 0;
    this.zoneHigh = bounds ? bounds.high : 100;
  }

  tick(currentHR) {
    this.tickCount++;

    // --- Handle pause ---
    if (this.paused) {
      if (Date.now() >= this.pauseEndTime) {
        this.paused = false;
        this.graduatedResumeTicksLeft = 3; // first 3 adjustments use slower interval
        this.onStatusChange({ action: 'resume', reason: 'pause_expired' });
      }
      return;
    }

    // --- HRM dropout detection ---
    if (!currentHR || currentHR <= 0) {
      if (!this.hrmDropoutStart) {
        this.hrmDropoutStart = Date.now();
        this.hrmStatus = 'dropout';
        this.onStatusChange({ action: 'hrm_dropout', reason: 'no_signal' });
      }
      const dropoutMs = Date.now() - this.hrmDropoutStart;
      const timeoutMs = this.targetZone >= 4 ? 60000 : 120000;

      // Precautionary reduction for high zones after 30s
      if (this.targetZone >= 4 && dropoutMs >= 30000 && dropoutMs < 31000) {
        this._adjustSpeed(-0.3, 'hrm_precaution');
      }

      if (dropoutMs >= timeoutMs) {
        this.hrmStatus = 'timeout';
        this.active = false;
        this.onStatusChange({ action: 'hrm_timeout', reason: `no_signal_${Math.round(timeoutMs/1000)}s` });
      }
      return;
    }

    // HRM recovered
    if (this.hrmDropoutStart) {
      this.hrmDropoutStart = null;
      this.hrmStatus = 'connected';
      this.onStatusChange({ action: 'hrm_recovered', reason: 'signal_restored' });
    }

    // --- Outlier rejection ---
    const minHRFloor = Math.max(50, this.maxHR * 0.4);
    if (currentHR < minHRFloor) return; // ignore unrealistic values

    if (this.previousHR && Math.abs(currentHR - this.previousHR) > 15) {
      this.outlierCount++;
      if (this.outlierCount < 3) return; // ignore spike unless 3 consecutive confirm
      this.outlierCount = 0; // confirmed — accept new level
    } else {
      this.outlierCount = 0;
    }
    this.previousHR = currentHR;

    // --- Add to ring buffer ---
    this.ringBuffer.push(currentHR);
    if (this.ringBuffer.length > this.ringBufferSize) {
      this.ringBuffer.shift();
    }

    // --- Wait for enough data ---
    if (this.ringBuffer.length < 8) return;

    // --- Determine adjustment interval ---
    let currentInterval = this.adjustInterval;
    if (this.graduatedResumeTicksLeft > 0) {
      currentInterval = this.graduatedResumeInterval;
    }

    // --- Direction change cooldown ---
    if (this.directionChangeCooldownUntil > this.tickCount) return;

    // --- Time to adjust? ---
    if (this.tickCount - this.lastAdjustTick < currentInterval) return;

    if (!this.active) return;

    // --- Calculate average HR ---
    const avgHR = this.ringBuffer.reduce((a, b) => a + b, 0) / this.ringBuffer.length;
    const hrPct = getHRPercent(avgHR, this.maxHR);

    // --- Safety: abnormal HR ---
    if (hrPct > 95) {
      this._adjustSpeed(-0.5, 'safety_high_hr');
      this.lastAdjustTick = this.tickCount;
      return;
    }

    // --- Safety: sustained overload (2+ zones above for 3+ min) ---
    const currentZone = getZone(avgHR, this.maxHR);
    if (currentZone && currentZone >= this.targetZone + 2) {
      if (!this.overloadStart) this.overloadStart = Date.now();
      if (Date.now() - this.overloadStart >= 180000) {
        this._adjustSpeed(-0.5, 'sustained_overload');
        this.lastAdjustTick = this.tickCount;
        return;
      }
    } else {
      this.overloadStart = null;
    }

    // --- Zone control with hysteresis ---
    const overThreshold = this.zoneHigh + this.hysteresis;
    const underThreshold = this.zoneLow - 2; // 1 zone below with some margin

    if (hrPct > overThreshold) {
      // Over target zone — decrease
      const zonesOver = Math.max(1, Math.floor((hrPct - this.zoneHigh) / 10));
      const stepSize = Math.min(0.5, 0.2 + (zonesOver - 1) * 0.15);
      this._adjust(-stepSize, 'over_zone');

    } else if (hrPct < this.zoneLow - 2) {
      // 2+ zones below — increase at normal rate
      this._adjust(0.2, 'under_zone_far');

    } else if (hrPct < this.zoneLow) {
      // 1 zone below — gentle nudge with slower interval
      this._adjust(0.1, 'under_zone_near');
      // Next adjustment uses longer interval
      this.lastAdjustTick = this.tickCount;
      if (this.graduatedResumeTicksLeft <= 0) {
        this.lastAdjustTick += 10; // effectively 30s total (20 + 10 extra)
      }
      if (this.graduatedResumeTicksLeft > 0) this.graduatedResumeTicksLeft--;
      return;

    } else {
      // In target zone — no adjustment
      this.accumulatedChange = 0;
      this.lastDirection = null;
      this.lastAction = 'in_zone';
    }

    this.lastAdjustTick = this.tickCount;
    if (this.graduatedResumeTicksLeft > 0) this.graduatedResumeTicksLeft--;
  }

  _adjust(step, reason) {
    const direction = step > 0 ? 'up' : 'down';

    // Direction change cooldown
    if (this.lastDirection && this.lastDirection !== direction) {
      this.accumulatedChange = 0;
      this.directionChangeCooldownUntil = this.tickCount + 30;
      this.lastDirection = direction;
      this.onStatusChange({ action: 'direction_change_cooldown', reason });
      return;
    }
    this.lastDirection = direction;

    // Accumulation cap
    this.accumulatedChange += Math.abs(step);
    if (this.accumulatedChange > this.accumulationCap) {
      this.accumulatedChange = 0;
      this.directionChangeCooldownUntil = this.tickCount + 30; // wait for HR to respond
      this.onStatusChange({ action: 'accumulation_pause', reason });
      return;
    }

    if (this.controlMode === 'speed') {
      this._adjustSpeed(step, reason);
    } else {
      this._adjustIncline(step > 0 ? 0.5 : -0.5, reason);
    }
  }

  _adjustSpeed(step, reason) {
    const oldSpeed = this.currentSpeed;
    this.currentSpeed = Math.round((this.currentSpeed + step) * 10) / 10;
    this.currentSpeed = Math.max(this.minSpeed, Math.min(this.maxSpeed, this.currentSpeed));
    if (this.currentSpeed === oldSpeed) return;

    this.adjustmentCount++;
    this.lastAction = step < 0 ? 'decrease_speed' : 'increase_speed';
    this.onSpeedChange(this.currentSpeed);
    this.onStatusChange({
      action: this.lastAction, fromValue: oldSpeed, toValue: this.currentSpeed, reason
    });
  }

  _adjustIncline(step, reason) {
    const oldIncline = this.currentIncline;
    this.currentIncline = Math.round((this.currentIncline + step) * 10) / 10;
    this.currentIncline = Math.max(this.minIncline, Math.min(this.maxIncline, this.currentIncline));
    if (this.currentIncline === oldIncline) return;

    this.adjustmentCount++;
    this.lastAction = step < 0 ? 'decrease_incline' : 'increase_incline';
    this.onInclineChange(this.currentIncline);
    this.onStatusChange({
      action: this.lastAction, fromValue: oldIncline, toValue: this.currentIncline, reason
    });
  }

  pause(durationMs) {
    this.paused = true;
    this.pauseEndTime = Date.now() + durationMs;
  }

  resume() {
    this.paused = false;
    this.graduatedResumeTicksLeft = 3;
  }

  updateBaseline(speed, incline) {
    this.currentSpeed = speed;
    this.currentIncline = incline;
    this.accumulatedChange = 0;
    this.lastDirection = null;
  }

  getState() {
    const avgHR = this.ringBuffer.length > 0
      ? Math.round(this.ringBuffer.reduce((a, b) => a + b, 0) / this.ringBuffer.length)
      : null;
    return {
      active: this.active,
      paused: this.paused,
      pauseRemaining: this.paused ? Math.max(0, Math.round((this.pauseEndTime - Date.now()) / 1000)) : 0,
      currentSpeed: this.currentSpeed,
      currentIncline: this.currentIncline,
      avgHR,
      currentZone: avgHR ? getZone(avgHR, this.maxHR) : null,
      targetZone: this.targetZone,
      controlMode: this.controlMode,
      adjustmentCount: this.adjustmentCount,
      lastAction: this.lastAction,
      hrmStatus: this.hrmStatus,
      currentControlledValue: this.controlMode === 'speed' ? this.currentSpeed : this.currentIncline,
    };
  }

  getRingBuffer() {
    return [...this.ringBuffer];
  }

  stop() {
    this.active = false;
  }
}

module.exports = HRZoneController;
```

- [ ] **Step 2: Verify module loads**

```bash
ssh pi@192.168.1.12 "cd ~/treadmill-controller/ble-service && node -e \"
const HRZoneController = require('./hr-zone-controller');
const c = new HRZoneController({
  targetZone: 3, maxHR: 190, controlMode: 'speed',
  initialSpeed: 9.0, initialIncline: 0,
  onSpeedChange: (s) => console.log('speed:', s),
  onInclineChange: (i) => console.log('incline:', i),
  onStatusChange: (s) => console.log('status:', JSON.stringify(s)),
});
// Simulate 10 ticks with HR in zone 3
for (let i = 0; i < 10; i++) c.tick(145);
console.log('state:', JSON.stringify(c.getState()));
console.log('OK');
\""
```

Expected: No speed changes (HR in zone, not enough ticks), state shows active=true, avgHR=145, currentZone=3.

- [ ] **Step 3: Commit**

```bash
git add ble-service/hr-zone-controller.js
git commit -m "feat: add HRZoneController class for HR zone controlled training"
```

---

### Task 3: Database migration

**Files:**
- Modify: `server.js:159-165` (after existing ALTER TABLEs)
- Modify: `migrate.js:105-146` (before strava_auth section)

- [ ] **Step 1: Add migrations to `server.js`**

After line 165 (`ALTER TABLE strava_auth ADD COLUMN profile_id INTEGER`), add:

```javascript
// HR zone control columns
try { db.exec('ALTER TABLE workout_segments ADD COLUMN hr_zone_control INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec("ALTER TABLE workout_segments ADD COLUMN hr_zone_control_mode TEXT DEFAULT 'speed'"); } catch(e) {}
try { db.exec('ALTER TABLE workouts ADD COLUMN hr_zone_eligible INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE workout_sessions ADD COLUMN hr_zone_control_enabled INTEGER DEFAULT 0'); } catch(e) {}
```

- [ ] **Step 2: Add migrations to `migrate.js`**

After the `target_max_zone` section (around line 117), before the strava_auth section (line 126), add:

```javascript
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
```

- [ ] **Step 3: Verify migration on RPi**

```bash
ssh pi@192.168.1.12 "cd ~/treadmill-controller && node migrate.js"
```

Expected: New columns added or "up to date" messages.

- [ ] **Step 4: Commit**

```bash
git add server.js migrate.js
git commit -m "feat: add database migrations for HR zone control columns"
```

---

### Task 4: API updates — workout CRUD + session creation

**Files:**
- Modify: `server.js:268-309` (POST /api/workouts)
- Modify: `server.js:338-367` (PUT /api/workouts/:id)
- Modify: `server.js:517-532` (POST /api/sessions)

- [ ] **Step 1: Update POST /api/workouts segment INSERT**

In `server.js`, replace the segment INSERT at lines 277-280:

```javascript
      const insertSegment = db.prepare(`
        INSERT INTO workout_segments (workout_id, segment_order, duration_seconds, speed_kmh, incline_percent, segment_name, target_max_zone, hr_zone_control, hr_zone_control_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
```

And update the `insertSegment.run()` at lines 293-300:

```javascript
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
```

Also add `hr_zone_eligible` calculation after segment insertion (before the response line 304). Add the heuristic function before the route handlers:

```javascript
function calculateHRZoneEligible(segments) {
  if (!segments || !Array.isArray(segments)) return 0;
  return segments.some(seg =>
    (seg.target_max_zone || 0) > 0 &&
    (seg.duration_seconds || seg.duration || 0) >= 180
  ) ? 1 : 0;
}
```

After segment insertion:
```javascript
    // Calculate and set hr_zone_eligible
    const hrEligible = calculateHRZoneEligible(segments);
    db.prepare('UPDATE workouts SET hr_zone_eligible = ? WHERE id = ?').run(hrEligible, workoutId);
```

- [ ] **Step 2: Update PUT /api/workouts/:id segment INSERT**

Replace the segment INSERT at lines 338-341:

```javascript
    const insertSegment = db.prepare(`
      INSERT INTO workout_segments (workout_id, segment_order, duration_seconds, speed_kmh, incline_percent, segment_name, target_max_zone, hr_zone_control, hr_zone_control_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
```

Update the `insertSegment.run()` call inside the transaction at lines 357-363:

```javascript
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
```

After the transaction, recalculate eligibility:
```javascript
    // Recalculate hr_zone_eligible
    const freshSegments = db.prepare('SELECT target_max_zone, duration_seconds FROM workout_segments WHERE workout_id = ?').all(id);
    const hrEligible = calculateHRZoneEligible(freshSegments);
    db.prepare('UPDATE workouts SET hr_zone_eligible = ? WHERE id = ?').run(hrEligible, id);
```

- [ ] **Step 3: Update POST /api/sessions**

At line 524, update the INSERT:

```javascript
    const insert = db.prepare('INSERT INTO workout_sessions (workout_id, heart_rate_source, profile_id, hr_zone_control_enabled) VALUES (?, ?, ?, ?)');
    const result = insert.run(validWorkoutId, validHRSource, validProfileId, req.body.hr_zone_control_enabled ? 1 : 0);
```

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: update workout CRUD and session API for HR zone control columns"
```

---

### Task 5: Template sync heuristic + auto-marking

**Files:**
- Modify: `server.js:1199-1270` (template sync section)

- [ ] **Step 1: Update template sync INSERT statements**

The `insertSegment` at line 1212-1215 already includes `target_max_zone`. Extend it:

```javascript
    const insertSegment = db.prepare(`
      INSERT INTO workout_segments (workout_id, segment_order, duration_seconds, speed_kmh, incline_percent, segment_name, target_max_zone, hr_zone_control, hr_zone_control_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
```

Update the `insertSegment.run()` calls (lines 1236-1244 for new templates, lines 1262-1269 for existing):

```javascript
              const segTargetZone = segment.target_max_zone || null;
              const segDuration = segment.duration || 60;
              const segIncline = segment.incline || 0;
              const hrControl = (segTargetZone && segDuration >= 180) ? (segment.hr_zone_control !== undefined ? segment.hr_zone_control : 1) : 0;
              const hrMode = segment.hr_zone_control_mode || (segIncline > 2 ? 'incline' : 'speed');
              insertSegment.run(
                workoutId,  // or existing.id for update path
                index,
                segDuration,
                segment.speed || 0,
                segIncline,
                segment.name || null,
                segTargetZone,
                hrControl,
                hrMode
              );
```

Apply the same pattern to **both** the new-template path (line 1236) and the update-existing path (line 1262).

- [ ] **Step 2: Add hr_zone_eligible calculation after template sync**

After the transaction closes (line 1276), add:

```javascript
    // Calculate hr_zone_eligible for all templates
    const allTemplates = db.prepare('SELECT id FROM workouts WHERE is_template = 1').all();
    const updateEligible = db.prepare('UPDATE workouts SET hr_zone_eligible = ? WHERE id = ?');
    allTemplates.forEach(t => {
      const segs = db.prepare('SELECT target_max_zone, duration_seconds FROM workout_segments WHERE workout_id = ?').all(t.id);
      updateEligible.run(calculateHRZoneEligible(segs), t.id);
    });
```

- [ ] **Step 3: Update insertWorkout to include hr_zone_eligible**

At line 1199-1202:

```javascript
    const insertWorkout = db.prepare(`
      INSERT INTO workouts (name, description, difficulty, is_template, tags, target_max_zone, hr_zone_eligible)
      VALUES (?, ?, ?, 1, ?, ?, ?)
    `);
```

And at line 1225-1231, add the eligible calculation:

```javascript
          const eligible = calculateHRZoneEligible(template.segments.map(s => ({
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
```

- [ ] **Step 4: Verify on RPi**

```bash
ssh pi@192.168.1.12 "docker exec treadmill-controller node -e \"
const db = require('better-sqlite3')('/app/data/treadmill.db');
const eligible = db.prepare('SELECT id, name, hr_zone_eligible FROM workouts WHERE hr_zone_eligible = 1').all();
console.log('Eligible workouts:', eligible.length);
eligible.forEach(w => console.log(' ', w.id, w.name));
\""
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add HR zone eligibility heuristic to template sync"
```

---

### Task 6: New HR zone templates

**Files:**
- Modify: `templates.json`

- [ ] **Step 1: Add 5 new templates to `templates.json`**

Append these 5 templates to the end of the array (before the closing `]`):

```json
    {
        "name": "Sonestyrt: Sone 2 Utholdenhet 45",
        "description": "Automatisk fartsjustering holder deg i sone 2. Perfekt for basebygging og fettforbrenning.",
        "difficulty": "beginner",
        "tags": ["hr-zone", "endurance", "long"],
        "target_max_zone": 2,
        "segments": [
            { "name": "Oppvarming", "duration": 300, "speed": 5.5, "incline": 0, "target_max_zone": 2 },
            { "name": "Sone 2 Sonestyrt", "duration": 2100, "speed": 7.0, "incline": 0, "target_max_zone": 2, "hr_zone_control": 1, "hr_zone_control_mode": "speed" },
            { "name": "Nedkjøling", "duration": 300, "speed": 5.0, "incline": 0, "target_max_zone": 1 }
        ]
    },
    {
        "name": "Sonestyrt: Sone 3 Tempo 30",
        "description": "Automatisk fartsjustering holder deg i temposone. Bygger aerob kapasitet.",
        "difficulty": "intermediate",
        "tags": ["hr-zone", "tempo", "medium"],
        "target_max_zone": 3,
        "segments": [
            { "name": "Oppvarming", "duration": 300, "speed": 6.0, "incline": 0, "target_max_zone": 2 },
            { "name": "Sone 3 Sonestyrt", "duration": 1200, "speed": 9.5, "incline": 0, "target_max_zone": 3, "hr_zone_control": 1, "hr_zone_control_mode": "speed" },
            { "name": "Nedkjøling", "duration": 300, "speed": 5.0, "incline": 0, "target_max_zone": 1 }
        ]
    },
    {
        "name": "Sonestyrt: Sone 4 Terskel 3x8",
        "description": "Tre arbeidsperioder i terskelsonene med aktiv hvile. Sonestyrt fartsjustering.",
        "difficulty": "advanced",
        "tags": ["hr-zone", "threshold", "interval"],
        "target_max_zone": 4,
        "segments": [
            { "name": "Oppvarming", "duration": 300, "speed": 6.0, "incline": 0, "target_max_zone": 2 },
            { "name": "Arbeid 1", "duration": 480, "speed": 10.5, "incline": 0, "target_max_zone": 4, "hr_zone_control": 1, "hr_zone_control_mode": "speed" },
            { "name": "Aktiv hvile 1", "duration": 180, "speed": 6.5, "incline": 0, "target_max_zone": 2 },
            { "name": "Arbeid 2", "duration": 480, "speed": 10.5, "incline": 0, "target_max_zone": 4, "hr_zone_control": 1, "hr_zone_control_mode": "speed" },
            { "name": "Aktiv hvile 2", "duration": 180, "speed": 6.5, "incline": 0, "target_max_zone": 2 },
            { "name": "Arbeid 3", "duration": 480, "speed": 10.5, "incline": 0, "target_max_zone": 4, "hr_zone_control": 1, "hr_zone_control_mode": "speed" },
            { "name": "Nedkjøling", "duration": 300, "speed": 5.0, "incline": 0, "target_max_zone": 1 }
        ]
    },
    {
        "name": "Sonestyrt: Progressiv Sonetrening 40",
        "description": "Gradvis økning gjennom sone 2, 3 og 4. Automatisk fartsjustering per sone.",
        "difficulty": "intermediate",
        "tags": ["hr-zone", "progressive", "endurance"],
        "target_max_zone": 4,
        "segments": [
            { "name": "Oppvarming", "duration": 300, "speed": 5.5, "incline": 0, "target_max_zone": 1 },
            { "name": "Sone 2", "duration": 600, "speed": 7.0, "incline": 0, "target_max_zone": 2, "hr_zone_control": 1, "hr_zone_control_mode": "speed" },
            { "name": "Sone 3", "duration": 600, "speed": 9.5, "incline": 0, "target_max_zone": 3, "hr_zone_control": 1, "hr_zone_control_mode": "speed" },
            { "name": "Sone 4", "duration": 600, "speed": 10.5, "incline": 0, "target_max_zone": 4, "hr_zone_control": 1, "hr_zone_control_mode": "speed" },
            { "name": "Nedkjøling", "duration": 300, "speed": 5.0, "incline": 0, "target_max_zone": 1 }
        ]
    },
    {
        "name": "Sonestyrt: Sone 2 Bakketrening 35",
        "description": "Automatisk stigningsjustering holder deg i sone 2. Styrker bein og bygger utholdenhet.",
        "difficulty": "beginner",
        "tags": ["hr-zone", "hill", "incline", "endurance"],
        "target_max_zone": 2,
        "segments": [
            { "name": "Oppvarming", "duration": 300, "speed": 6.0, "incline": 0, "target_max_zone": 1 },
            { "name": "Sone 2 Sonestyrt Stigning", "duration": 1500, "speed": 6.0, "incline": 4, "target_max_zone": 2, "hr_zone_control": 1, "hr_zone_control_mode": "incline" },
            { "name": "Nedkjøling", "duration": 300, "speed": 5.0, "incline": 0, "target_max_zone": 1 }
        ]
    }
```

- [ ] **Step 2: Commit**

```bash
git add templates.json
git commit -m "feat: add 5 HR zone controlled workout templates"
```

---

### Task 7: Integrate HRZoneController into ble-service.js

**Files:**
- Modify: `ble-service/ble-service.js`

This is the largest task — integrates the controller into the BLE service.

- [ ] **Step 1: Add imports and state variables**

At the top of `ble-service.js`, after existing requires (around line 12):

```javascript
const HRZoneController = require('./hr-zone-controller');
```

After `let currentTargetIncline = 0;` (line 60), add:

```javascript
let activeHRZoneController = null;
let hrZoneControlEnabled = false;  // per-session toggle
let sessionMaxHR = null;           // fetched at session start from profile
```

- [ ] **Step 2: Add `set_speed` and `set_incline` command handlers**

In `handleServerMessage()`, before the `default` case (line 288), add:

```javascript
    case 'set_speed':
      handleSetSpeed(commandId, params);
      break;
    case 'set_incline':
      handleSetIncline(commandId, params);
      break;
```

Then add the handler functions (after `handleSkipSegment`, around line 858):

```javascript
async function handleSetSpeed(commandId, params) {
  const speed = parseFloat(params.speed);
  if (isNaN(speed) || speed < 0.1 || speed > 14.0) {
    sendCommandResponse(commandId, 'set_speed', false, 'Invalid speed');
    return;
  }
  currentTargetSpeed = speed;
  try {
    await ftms.setSpeed(speed);
  } catch (err) {
    sendCommandResponse(commandId, 'set_speed', false, err.message);
    return;
  }
  if (activeHRZoneController) {
    activeHRZoneController.pause(45000);
    activeHRZoneController.updateBaseline(speed, currentTargetIncline);
    console.log('[HRZone] Manual speed override — pausing controller for 45s');
  }
  sendCommandResponse(commandId, 'set_speed', true);
}

async function handleSetIncline(commandId, params) {
  const incline = parseFloat(params.incline);
  if (isNaN(incline) || incline < 0 || incline > 12) {
    sendCommandResponse(commandId, 'set_incline', false, 'Invalid incline');
    return;
  }
  currentTargetIncline = incline;
  try {
    await ftms.setIncline(incline);
  } catch (err) {
    sendCommandResponse(commandId, 'set_incline', false, err.message);
    return;
  }
  if (activeHRZoneController) {
    activeHRZoneController.pause(45000);
    activeHRZoneController.updateBaseline(currentTargetSpeed, incline);
    console.log('[HRZone] Manual incline override — pausing controller for 45s');
  }
  sendCommandResponse(commandId, 'set_incline', true);
}
```

- [ ] **Step 3: Update `handleStartSession()` to pass profile_id and hr_zone_control_enabled**

At line 727-734, update the session creation body:

```javascript
    const body = {
      workout_id: currentWorkout ? currentWorkout.id : null,
      heart_rate_source: hrm.isConnected() ? 'ble' : 'none',
      profile_id: params.profile_id || null,
      hr_zone_control_enabled: params.hr_zone_control_enabled ? 1 : 0
    };
```

After `sessionActive = true;` (line 740), add profile fetch and HR zone setup:

```javascript
    hrZoneControlEnabled = !!params.hr_zone_control_enabled;
    sessionMaxHR = null;

    // Fetch maxHR if HR zone control is enabled
    if (hrZoneControlEnabled && params.profile_id) {
      try {
        const profileRes = await fetch(`${httpBase()}/api/profiles`);
        if (profileRes.ok) {
          const profiles = await profileRes.json();
          const profile = profiles.find(p => p.id === parseInt(params.profile_id));
          if (profile) sessionMaxHR = profile.max_hr;
        }
      } catch (e) {
        console.error('[HRZone] Failed to fetch profile:', e.message);
      }
    }

    // Pre-flight: if HR zone enabled but no HRM connected, disable
    if (hrZoneControlEnabled && !hrm.isConnected()) {
      console.log('[HRZone] HRM not connected — disabling HR zone control');
      hrZoneControlEnabled = false;
    }
    if (hrZoneControlEnabled && !sessionMaxHR) {
      console.log('[HRZone] No maxHR available — disabling HR zone control');
      hrZoneControlEnabled = false;
    }
```

- [ ] **Step 4: Update `executeSegment()` to start/stop HR zone controller**

Replace `executeSegment()` (lines 861-896):

```javascript
async function executeSegment(index) {
  if (!currentWorkout || !currentWorkout.segments || index >= currentWorkout.segments.length) {
    console.log('[Session] All segments complete — stopping session');
    if (activeHRZoneController) { activeHRZoneController.stop(); activeHRZoneController = null; }
    handleStopSession('auto-complete', {});
    return;
  }

  const segment = currentWorkout.segments[index];
  currentTargetSpeed = segment.speed_kmh;
  currentTargetIncline = segment.incline_percent || 0;

  console.log(`[Session] Segment ${index}: "${segment.segment_name || 'unnamed'}" — ${currentTargetSpeed} km/h, ${currentTargetIncline}% for ${segment.duration_seconds}s`);

  // Stop previous HR zone controller if segment is not HR-controlled
  const isHRControlled = hrZoneControlEnabled && segment.hr_zone_control === 1 && segment.target_max_zone && sessionMaxHR;

  if (!isHRControlled && activeHRZoneController) {
    activeHRZoneController.stop();
    activeHRZoneController = null;
    console.log('[HRZone] Segment not HR-controlled — stopped controller');
  }

  // Send commands to treadmill
  if (ftms.isConnected()) {
    try {
      if (index === 0) {
        await ftms.start();
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      await ftms.setSpeed(currentTargetSpeed);
      await ftms.setIncline(currentTargetIncline);
    } catch (err) {
      console.error('[Session] Failed to set segment targets:', err.message);
    }
  }

  // Start HR zone controller for this segment
  if (isHRControlled) {
    const existingBuffer = activeHRZoneController ? activeHRZoneController.getRingBuffer() : undefined;
    if (activeHRZoneController) activeHRZoneController.stop();

    activeHRZoneController = new HRZoneController({
      targetZone: segment.target_max_zone,
      maxHR: sessionMaxHR,
      controlMode: segment.hr_zone_control_mode || 'speed',
      initialSpeed: currentTargetSpeed,
      initialIncline: currentTargetIncline,
      existingBuffer,
      onSpeedChange: async (newSpeed) => {
        currentTargetSpeed = newSpeed;
        try { await ftms.setSpeed(newSpeed); } catch (e) { console.error('[HRZone] setSpeed failed:', e.message); }
      },
      onInclineChange: async (newIncline) => {
        currentTargetIncline = newIncline;
        try { await ftms.setIncline(newIncline); } catch (e) { console.error('[HRZone] setIncline failed:', e.message); }
      },
      onStatusChange: (status) => {
        console.log(`[HRZone] ${status.action}: ${JSON.stringify(status)}`);
        // Forward to server for TTS via WebSocket
        wsSend({ type: 'hr_zone_status', ...status });
      },
    });
    console.log(`[HRZone] Started controller: zone ${segment.target_max_zone}, mode ${segment.hr_zone_control_mode || 'speed'}, maxHR ${sessionMaxHR}`);
  }

  // Set timer for segment duration
  stopSegmentTimer();
  segmentStartTime = Date.now();
  segmentTimer = setTimeout(() => {
    currentSegmentIndex++;
    executeSegment(currentSegmentIndex);
  }, segment.duration_seconds * 1000);
}
```

- [ ] **Step 5: Add HR zone controller tick to the state broadcast interval**

In `startStateBroadcast()` (around line 206-213), the interval sends state every 2s. We need to tick the HR controller every 1s. Add a dedicated 1-second timer.

After the `startStateBroadcast()` function, add:

```javascript
let hrZoneTickTimer = null;

function startHRZoneTick() {
  stopHRZoneTick();
  hrZoneTickTimer = setInterval(() => {
    if (activeHRZoneController && activeHRZoneController.active) {
      const hr = hrm.getCurrentHeartRate();
      activeHRZoneController.tick(hr);
    }
  }, 1000);
}

function stopHRZoneTick() {
  if (hrZoneTickTimer) { clearInterval(hrZoneTickTimer); hrZoneTickTimer = null; }
}
```

Call `startHRZoneTick()` in `handleStartSession()` (after `startDriftDetection()`), and `stopHRZoneTick()` in `handleStopSession()` (after `stopDriftDetection()`).

- [ ] **Step 6: Include HR zone state in `buildCurrentState()`**

In `buildCurrentState()` (around line 185-203), before the `return` statement, add `hrZoneControl`:

```javascript
    hrZoneControl: activeHRZoneController ? activeHRZoneController.getState() : null,
```

Add it to the returned object alongside existing fields (after `fitshow`).

- [ ] **Step 7: Clean up on session stop**

In `handleStopSession()` (around line 761), add after existing cleanup:

```javascript
  if (activeHRZoneController) {
    activeHRZoneController.stop();
    activeHRZoneController = null;
  }
  hrZoneControlEnabled = false;
  sessionMaxHR = null;
  stopHRZoneTick();
```

- [ ] **Step 8: Commit**

```bash
git add ble-service/ble-service.js
git commit -m "feat: integrate HRZoneController into ble-service executeSegment flow"
```

---

### Task 8: Server-side TTS coordination

**Files:**
- Modify: `server.js:1663-1675` (treadmill_state handler)
- Modify: `coaching-engine.js:84-126` (zone violation trigger)

- [ ] **Step 1: Forward hr_zone_status to TTS**

In `server.js`, in the WebSocket message handler where `treadmill_state` is processed (around line 1663), add handling for `hr_zone_status`:

```javascript
      if (data.type === 'hr_zone_status') {
        // Generate TTS for HR zone controller events
        const ttsMessages = {
          'decrease_speed': `Senker farten til ${data.toValue} for å holde deg i sonen.`,
          'increase_speed': `Øker farten til ${data.toValue}.`,
          'decrease_incline': `Senker stigningen til ${data.toValue} prosent.`,
          'increase_incline': `Øker stigningen til ${data.toValue} prosent.`,
          'hrm_dropout': 'Mistet pulssignal. Holder nåværende fart.',
          'hrm_timeout': 'Sonestyring deaktivert. Ingen pulsdata.',
          'hrm_recovered': 'Pulssignal gjenopprettet. Gjenopptar sonestyring.',
          'safety_high_hr': 'Pulsen er svært høy. Senker farten for sikkerhet.',
          'sustained_overload': 'Pulsen er vedvarende høy. Vurder å stoppe.',
          'hrm_precaution': 'Senker farten litt som sikkerhetstiltak.',
        };
        const msg = ttsMessages[data.action];
        if (msg) {
          // Rate limit: only speak adjustment messages if significant (>0.5 accumulated)
          const isAdjustment = ['decrease_speed', 'increase_speed', 'decrease_incline', 'increase_incline'].includes(data.action);
          if (!isAdjustment || !data._lastTTSAction || data._lastTTSAction !== data.action) {
            (async () => {
              try {
                const filename = await ttsService.speak(msg);
                deliverTTS(msg, filename);
              } catch (e) { console.error('[TTS] HR zone message failed:', e.message); }
            })();
          }
        }
        // Broadcast to viewers
        broadcast(data);
        return;
      }
```

- [ ] **Step 2: Suppress zone-violation in coaching engine during active HR control**

In the `treadmill_state` handler (around line 1667-1668), pass the `hrZoneControl` flag:

```javascript
        if (activeCoachingEngine) {
          activeCoachingEngine.update(data);
        }
```

In `coaching-engine.js`, at the start of trigger 2 (line 85), add a check:

```javascript
    // --- Trigger 2: Zone violation (priority 1) ---
    // Skip if HR zone controller is actively managing the zone
    if (state.hrZoneControl && state.hrZoneControl.active && !state.hrZoneControl.paused) {
      // HR zone controller handles zone adjustments — suppress coaching zone warnings
      this.overZoneStart = null;
      this.underZoneStart = null;
      this.zoneWarningActive = false;
    } else if (targetZone && zone) {
```

This wraps the existing zone violation block (lines 86-126) in an `else` so it's skipped when the controller is active.

- [ ] **Step 3: Commit**

```bash
git add server.js coaching-engine.js
git commit -m "feat: add TTS messages for HR zone control and suppress zone-violation during active control"
```

---

### Task 9: Frontend — view.html updates

**Files:**
- Modify: `public/view.html`

- [ ] **Step 1: Add HR zone filter to workout list**

Find the workout list rendering section in `view.html`. Add a filter toggle button and filter logic. This requires reading view.html to find exact insertion points — the agent implementing this task should read view.html first.

Add a filter button in the workout selector area:

```html
<button id="hrZoneFilterBtn" class="filter-btn" onclick="toggleHRZoneFilter()">🎯 Sonestyrt</button>
```

Add the filter logic:

```javascript
let hrZoneFilterActive = false;
function toggleHRZoneFilter() {
  hrZoneFilterActive = !hrZoneFilterActive;
  document.getElementById('hrZoneFilterBtn').classList.toggle('active', hrZoneFilterActive);
  renderWorkoutList();
}
```

In the workout list rendering, filter by `hr_zone_eligible`:

```javascript
if (hrZoneFilterActive) {
  workouts = workouts.filter(w => w.hr_zone_eligible === 1);
}
```

- [ ] **Step 2: Add sonestyring toggle in ready state**

In the workout loaded/ready state area, after the profile selector, add:

```html
<div id="hrZoneToggleContainer" style="display:none;">
  <label class="toggle-label">
    <input type="checkbox" id="hrZoneToggle" onchange="updateHRZoneToggle()">
    <span>Sonestyring</span>
  </label>
</div>
```

Show/hide based on loaded workout's `hr_zone_eligible`:

```javascript
function updateReadyState(workout) {
  const container = document.getElementById('hrZoneToggleContainer');
  if (container) {
    container.style.display = workout.hr_zone_eligible ? 'block' : 'none';
  }
}
```

- [ ] **Step 3: Pass hr_zone_control_enabled in start_session command**

In the `startSession()` function, include the toggle value:

```javascript
const hrZoneEnabled = document.getElementById('hrZoneToggle')?.checked || false;
sendCommand('start_session', {
  workout_id: loadedWorkout.id,
  profileId: selectedProfileId,
  profile_id: selectedProfileId,
  hr_zone_control_enabled: hrZoneEnabled
});
```

- [ ] **Step 4: Add live HR zone indicator during active workout**

In the active workout display area, add a zone control status element:

```html
<div id="hrZoneStatus" class="hr-zone-status" style="display:none;">
  <span id="hrZoneLabel">Sonestyrt</span>
  <span id="hrZoneAction"></span>
</div>
```

Update on each `treadmill_state`:

```javascript
function updateHRZoneDisplay(state) {
  const container = document.getElementById('hrZoneStatus');
  if (!container) return;
  const hzc = state.hrZoneControl;
  if (!hzc || !hzc.active) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  const label = document.getElementById('hrZoneLabel');
  const action = document.getElementById('hrZoneAction');
  if (hzc.paused) {
    label.textContent = `Sonestyring pauset (${hzc.pauseRemaining}s)`;
    label.className = 'hr-zone-paused';
  } else {
    label.textContent = `Sone ${hzc.targetZone} — Sonestyrt`;
    label.className = 'hr-zone-active';
  }
  if (hzc.lastAction && hzc.lastAction.includes('speed')) {
    action.textContent = `${hzc.currentControlledValue} km/h`;
  } else if (hzc.lastAction && hzc.lastAction.includes('incline')) {
    action.textContent = `${hzc.currentControlledValue}%`;
  }
}
```

- [ ] **Step 5: Add manual speed/incline adjustment buttons**

Add +/- buttons for manual override during active workout:

```html
<div id="manualAdjust" class="manual-adjust" style="display:none;">
  <button onclick="adjustSpeed(-0.5)">-0.5</button>
  <span id="adjustSpeedLabel">Fart</span>
  <button onclick="adjustSpeed(+0.5)">+0.5</button>
  <button onclick="adjustIncline(-1)">-1%</button>
  <span id="adjustInclineLabel">Stigning</span>
  <button onclick="adjustIncline(+1)">+1%</button>
</div>
```

```javascript
function adjustSpeed(delta) {
  const current = lastState?.targetSpeed || lastState?.speed || 8;
  const newSpeed = Math.round((current + delta) * 10) / 10;
  sendCommand('set_speed', { speed: Math.max(0.1, Math.min(14, newSpeed)) });
}
function adjustIncline(delta) {
  const current = lastState?.targetIncline || lastState?.incline || 0;
  const newIncline = Math.round((current + delta) * 10) / 10;
  sendCommand('set_incline', { incline: Math.max(0, Math.min(12, newIncline)) });
}
```

- [ ] **Step 6: Commit**

```bash
git add public/view.html
git commit -m "feat: add HR zone control UI to view.html — filter, toggle, indicator, manual adjust"
```

---

### Task 10: Frontend — app.js updates

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: Add HR zone filter to workout list in app.js**

Find the workout list rendering. Add `hr_zone_eligible` to the fetch and filter logic, matching the pattern from view.html. The implementing agent should read app.js workout list rendering first.

Add a filter toggle in the workout tab toolbar and filter workouts by `hr_zone_eligible` when active.

- [ ] **Step 2: Show HR zone info in session history**

In the session history rendering, add a badge/indicator for sessions with `hr_zone_control_enabled = 1`.

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: add HR zone filter and history indicator to app.js"
```

---

### Task 11: Deploy to RPi and verify

- [ ] **Step 1: Deploy all files**

```bash
cd treadmill-controller
scp ble-service/hr-utils.js ble-service/hr-zone-controller.js pi@192.168.1.12:~/treadmill-controller/ble-service/
scp server.js coaching-engine.js migrate.js templates.json pi@192.168.1.12:~/treadmill-controller/
scp public/view.html public/app.js pi@192.168.1.12:~/treadmill-controller/public/
```

- [ ] **Step 2: Run migration on RPi**

```bash
ssh pi@192.168.1.12 "cd ~/treadmill-controller && node migrate.js"
```

- [ ] **Step 3: Rebuild and restart Docker container**

```bash
ssh pi@192.168.1.12 "cd ~/treadmill-controller && docker compose build && docker rm -f treadmill-controller 2>/dev/null; docker compose up -d"
```

- [ ] **Step 4: Restart BLE service (it runs on host, not Docker)**

```bash
ssh pi@192.168.1.12 "sudo systemctl restart treadmill-ble"
```

- [ ] **Step 5: Verify server starts and templates sync**

```bash
ssh pi@192.168.1.12 "docker logs treadmill-controller --tail 30"
```

Expected: Template sync shows new HR zone templates added, no errors.

- [ ] **Step 6: Verify BLE service loads new modules**

```bash
ssh pi@192.168.1.12 "sudo journalctl -u treadmill-ble --no-pager -n 20"
```

Expected: Service starts without import errors.

- [ ] **Step 7: Verify API returns hr_zone_eligible**

```bash
ssh pi@192.168.1.12 "curl -s http://localhost:3000/api/workouts | node -e \"process.stdin.on('data',d=>{const w=JSON.parse(d);w.filter(x=>x.hr_zone_eligible).forEach(x=>console.log(x.id,x.name,x.hr_zone_eligible))})\""
```

Expected: New sonestyrt templates + eligible existing templates listed.

- [ ] **Step 8: Commit deployment verification**

No code changes — just verify everything works.

---

### Task 12: Update documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `ROADMAP.md`
- Modify: `docs/future/hr-zone-controlled-training.md`

- [ ] **Step 1: Update CLAUDE.md**

Add to Database Schema section:
- New columns on `workout_segments`: `hr_zone_control`, `hr_zone_control_mode`
- New column on `workouts`: `hr_zone_eligible`
- New column on `workout_sessions`: `hr_zone_control_enabled`

Add to Architecture section:
- `ble-service/hr-zone-controller.js` — HR zone control loop class
- `ble-service/hr-utils.js` — shared zone calculation utility

Add to Key API Routes:
- `set_speed` and `set_incline` WebSocket commands

Add to Gotchas:
- HR zone controller updates `currentTargetSpeed`/`currentTargetIncline` — drift detection cooperates with it
- Coaching engine suppresses zone-violation TTS when HR zone controller is active
- Sonestyring only works via native BLE service (not browser-based controller in app.js)

- [ ] **Step 2: Update ROADMAP.md**

Move "HR-zone-controlled workouts" from planned to implemented.

- [ ] **Step 3: Update the original spec**

Update `docs/future/hr-zone-controlled-training.md` status to "Implementert" with date.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md ROADMAP.md docs/future/hr-zone-controlled-training.md
git commit -m "docs: update documentation for HR zone controlled training feature"
```
