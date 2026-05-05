# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It is the **single source of truth** for AI sessions — always read this first, verify against code, and update when things change.

## Project Overview

Treadmill controller web app using Bluetooth (FTMS protocol) to control a treadmill and track workouts. Runs on a Raspberry Pi via Docker. Two BLE backends: browser-based (Web Bluetooth via desktop PC) or native (systemd service on RPi host using @abandonware/noble). Includes TTS coaching via OpenAI API with heart rate zone tracking, user profiles, and audio playback to client (iPhone/headset) or treadmill speakers (A2DP). All data is local — no cloud services (except optional Strava sync and OpenAI TTS). UI is in Norwegian. Two users: Magnus and Nansy.

## Commands

```bash
# Development
npm install           # Install deps (needs python3, make, g++ for better-sqlite3)
npm start             # Start server on http://localhost:3000 + https://localhost:3001

# Database migration
node migrate.js       # Add missing columns to existing tables

# Docker (production — Raspberry Pi at 192.168.1.12, user: pi)
docker compose build
docker compose up -d
docker compose down

# Deploy to Pi from Windows (always rebuild — public/ is baked into Docker image)
scp server.js coaching-engine.js tts-service.js migrate.js templates.json docker-compose.yml Dockerfile .env pi@192.168.1.12:~/treadmill-controller/
scp public/* pi@192.168.1.12:~/treadmill-controller/public/
ssh pi@192.168.1.12 "cd ~/treadmill-controller && docker compose build && docker rm -f treadmill-controller 2>/dev/null; docker compose up -d"

# Verify on Pi
ssh pi@192.168.1.12 "docker logs treadmill-controller --tail 20"
ssh pi@192.168.1.12 "curl -s http://localhost:3000/api/profiles"

# SSL cert generation (required for Web Bluetooth over network)
openssl req -x509 -newkey rsa:4096 -nodes -out certs/server.crt -keyout certs/server.key -days 365

# BLE Service (on RPi host, outside Docker)
cd ~/treadmill-controller/ble-service && bash install.sh  # First-time setup (installs node-ble, D-Bus config)
sudo systemctl start treadmill-ble    # Start BLE service
sudo systemctl status treadmill-ble   # Check status
sudo journalctl -u treadmill-ble -f   # View logs
```

No test suite exists. No linter configured.

## Architecture

**Backend**: Express 5 + better-sqlite3 (WAL mode) + WebSocket (ws). `server.js` (~1600 lines) handles REST API, WebSocket relay (for view dashboard), template syncing, Strava OAuth/upload, session exports (JSON/CSV/TCX), TTS coaching integration, user profiles, and HTTPS/HTTP auto-detection based on cert presence.

**TTS Coaching** (server-side modules):
- `coaching-engine.js` — Heart rate zone calculation, trigger evaluation (segment transitions, zone violations after 60s, milestones), Norwegian message generation, cooldown/priority queue.
- `tts-service.js` — OpenAI TTS API (`tts-1` model) via `fetch()`, SHA256-based mp3 file caching in `tts-cache/`, A2DP speaker playback via `ffmpeg | paplay`.

**Frontend**: Vanilla JS (no framework, no build step). Key files:
- `public/ftms.js` — FTMS Bluetooth protocol: connect, parse treadmill data notifications, write control point commands (speed/incline/start/stop). Commands throttled with 400ms minimum gap. Confirmation mechanism waits for FTMS status codes 0x0A/0x0B.
- `public/hrm.js` — Heart Rate Monitor Bluetooth protocol (UUID 0x180D). Optional; HRM takes priority over treadmill's built-in HR sensor.
- `public/app.js` — Main application (~3200 lines). Manages UI tabs (Control/Workouts/History), workout execution with segment progression, session recording (1 data point/second), drift detection, Chart.js graphs, sound alerts, Strava integration, profile filter/tagging, date filtering, export, auto BLE reconnect, segment feedback, WebSocket state broadcast.
- `public/index.html` — Controller UI. Has Bluetooth connect, speed/incline sliders, workout selector, loaded workout card (with profile selector), workout progress, history with profile filter + inline profile editing, per-profile Strava connections, stats views.
- `public/view.html` — Remote control + dashboard for iPad/iPhone. Three states: idle (workout selector), ready (workout loaded with profile selector + TTS toggle), active (live dashboard + controls + TTS audio playback). Sends commands via WebSocket, receives state broadcasts and TTS audio. Dark theme, responsive, auto-reconnect, HR zone coloring. AudioContext unlocked on user gesture for iOS compatibility. **Has NO session history** — history is only in index.html.
- `public/sw.js` — Service worker for PWA offline support. Cache-first for static assets, network-first for API.
- `public/manifest.json` — PWA manifest with Norwegian locale.

**BLE Service** (`ble-service/`): Separate Node.js process on RPi host (not Docker). Uses `node-ble` (D-Bus/BlueZ) for BLE — supports simultaneous connections to treadmill and heart rate monitor. Runs as systemd service (`treadmill-ble.service`). Connects to server via WebSocket on `ws://localhost:3000`. Stores known device addresses in `ble-config.json`.

**HR Zone Controller** (`ble-service/hr-zone-controller.js`): Automatic speed/incline adjustment to maintain target HR zone. Runs as part of the BLE service, ticked every 1 second. Uses `ble-service/hr-utils.js` for zone calculation. Adjusts every 20 seconds with hysteresis, accumulation caps, and direction-change cooldown to prevent oscillation. Pauses on manual override (45s) and FTMS disconnect.

**Dual HTTP/HTTPS**: server.js listens on HTTP (port 3000, env `HTTP_PORT`) and HTTPS (port 3001 if certs exist, env `HTTPS_PORT`). view.html uses HTTP (no cert warnings on iOS). index.html uses HTTPS for Web Bluetooth.

**WebSocket Hub**: server.js routes commands between viewer clients (view.html) and the active controller (index.html browser or native BLE service). Controllers register with `{ type: "register", role: "controller" }`. Native BLE service takes priority over browser controllers. Protocol: `command` → `remote_command` → `command_response`. Additional message types: `tts_config` (viewer → server, coaching preferences + profileId), `tts` (server → viewer, audio URL), `tts_text` (server → viewer, text-only fallback).

**Data flow during workout**:
```
Template segments → executeSegment() → BLE write (speed/incline)
                                              ↓
                                    Treadmill data notification (200ms)
                                              ↓
                                    updateStats() → UI + recordSessionData() → DB
                                              ↓
                                    buildCurrentState() → WebSocket broadcast (2s)
                                              ↓
                                    view.html renders on iPad/iPhone
                                              ↓
                                    server.js → CoachingEngine.update(state)
                                              ↓
                                    Trigger? → TTSService.speak(text) → cache/OpenAI
                                              ↓
                                    broadcastToViewers({ type: "tts", url }) + playOnSpeaker()
```

## Database Schema

```sql
-- Workout templates and custom workouts
workouts (id, name, description, difficulty, is_template, tags, target_max_zone, created_at,
          hr_zone_eligible INTEGER DEFAULT 0)
  ↓ 1:N
workout_segments (id, workout_id, segment_order, duration_seconds, speed_kmh, incline_percent, segment_name, target_max_zone,
                  hr_zone_control INTEGER DEFAULT 0, hr_zone_control_mode TEXT DEFAULT 'speed')

-- Session tracking
workout_sessions (id, workout_id, started_at, completed_at, total_distance_km, total_time_seconds,
                  avg_heart_rate, calories_burned, heart_rate_source, profile_id,
                  strava_activity_id, strava_upload_status,
                  hr_zone_control_enabled INTEGER DEFAULT 0)
  ↓ 1:N
session_data (id, session_id, timestamp, speed_kmh, incline_percent, distance_km, heart_rate, calories, segment_index)

-- User profiles (for coaching zones + session tagging)
user_profiles (id, name UNIQUE, max_hr, created_at)

-- Strava OAuth tokens (per-profile connections)
strava_auth (id, athlete_id UNIQUE, access_token, refresh_token, expires_at, scope, athlete_name, profile_id, connected_at)
```

**Key relationships:**
- `workout_sessions.profile_id` → `user_profiles.id` (who ran this session)
- `strava_auth.profile_id` → `user_profiles.id` (whose Strava account)
- `strava_auth.athlete_id` is UNIQUE — one Strava account can only be connected once (INSERT OR REPLACE keyed on this)

**Indexes:** `idx_session_data_session_id`, `idx_workout_sessions_started_at`, `idx_workout_segments_workout_id`

## Key API Routes

- `GET/POST /api/workouts` — CRUD for workouts (with segments and target_max_zone)
- `PUT /api/workouts/:id` — Update existing workout
- `GET/POST/PUT/DELETE /api/profiles` — User profiles (name, max_hr) for TTS coaching and session tagging
- `GET /api/sessions` — Session history. Supports `?profileId=X`, `?startDate=`, `?endDate=`, `?limit=`, `?offset=`. Returns `profile_name` via LEFT JOIN to user_profiles
- `POST /api/sessions` — Create session `{ workout_id, profile_id, heart_rate_source }`
- `PUT /api/sessions/:id` — Complete session (sets completed_at). **Rejects if already completed (409)**
- `PATCH /api/sessions/:id/profile` — Update session profile. **Works on completed sessions too**
- `POST /api/sessions/:id/data` — Record data point each second (with optional `segment_index`)
- `GET /api/sessions/:id/details` — Full session with all data points
- `GET /api/sessions/:id/segments` — Per-segment aggregated feedback
- `GET /api/sessions/:id/export/json|csv|tcx` — Export session data
- `GET /api/sessions/:id/stats` — Server-calculated totals (used by endSession)
- `DELETE /api/sessions/:id` — Delete session
- `GET /api/stats/overall|weekly|monthly` — Aggregated statistics
- `GET /auth/strava?profileId=X` — OAuth redirect to Strava (profile_id passed via `state` parameter)
- `GET /auth/strava/callback` — OAuth callback (reads profile_id from `state`, stores in strava_auth)
- `GET /api/strava/status` — Returns `{ connected: bool, connections: [{athlete_id, athlete_name, profile_id, profile_name, connected_at}] }`
- `DELETE /api/strava/disconnect?profileId=X` — Disconnect Strava per profile (or all if no profileId)
- `POST /api/strava/upload/:sessionId` — Upload session as TCX to Strava. Looks up tokens via session's profile_id
- WebSocket commands `set_speed` and `set_incline` — manual speed/incline adjustment via ble-service (new, for HR zone control manual override)
- WebSocket command `ble_force_reset` — full BLE recovery: tear down all GATT connections, clear BlueZ device cache for both saved addresses, power-cycle the adapter, reset retry counters, kick off fresh reconnects
- WebSocket message `coaching_event` (ble-service → server) — `{ event: 'hrm_lost' | 'hrm_recovered', timestamp }`. Server forwards to active CoachingEngine.pushEvent which queues a high-priority TTS message

## FTMS Protocol Details

Control Point writes (OpCode + params, little-endian):
- `0x02 [speed*100 as uint16]` — Set target speed (km/h)
- `0x03 [incline*10 as int16]` — Set target incline (%)
- `0x07` — Start/Resume
- `0x08 0x01` — Stop, `0x08 0x02` — Pause

Status notifications: `0x0A` = speed accepted, `0x0B` = incline accepted, `0x04` = started, `0x02` = stopped.

Speed range: 0.1-14.0 km/h. Incline range: 0-12%.

When treadmill sends status `0x02` (stopped), app auto-ends session and workout without confirm dialog.

## Environment Variables

`.env` file (or environment variables):
```
# Strava (optional — one API app, multiple user profiles connect independently)
STRAVA_CLIENT_ID=<from strava.com/settings/api>
STRAVA_CLIENT_SECRET=<from strava.com/settings/api>
APP_URL=https://192.168.1.12:3001

# TTS coaching (optional — falls back to text-only without API key)
OPENAI_API_KEY=<from platform.openai.com/api-keys>
TTS_VOICE=nova          # OpenAI TTS voice (default: nova)
A2DP_SINK=              # PulseAudio sink for treadmill speakers (optional)
```

Note: Strava API does not support setting activity privacy. Users must set "Default Activity Privacy" to "Only You" in Strava settings.

Note: TTS coaching works without OPENAI_API_KEY — coaching engine still runs and sends text messages to view.html as toast notifications. With the API key, it generates spoken Norwegian audio via OpenAI `tts-1` with disk caching (~10-50KB per message, ~2s latency on first generation, 1ms on cache hit).

## Gotchas & Non-obvious Behavior

Things that have caused confusion or bugs — read these before making changes:

1. **view.html has NO session history** — it's a live dashboard only. History/stats are only in index.html via app.js.
2. **Dual migration system** — server.js uses `try { db.exec('ALTER TABLE...') } catch(e) {}` on every startup. migrate.js uses `PRAGMA table_info` checks in a transaction. **Both must be updated** when adding columns.
3. **view.html sends profileId two ways** — via `tts_config` WebSocket message (for coaching) AND via `start_session` command params (for session creation). These are separate mechanisms.
4. **`startSession()` in app.js has a fallback** — accepts explicit `profileId` param, but falls back to reading `#sessionProfileSelect` dropdown via `getSelectedProfileId()`.
5. **`INSERT OR REPLACE` in strava_auth is keyed on `athlete_id UNIQUE`** — reconnecting the same Strava account overwrites the previous row (including profile_id). Magnus and Nansy have separate Strava accounts so this is fine.
6. **OAuth `state` parameter carries profileId, not CSRF token** — acceptable for local-only app. Would need CSRF if ever internet-facing.
7. **`PUT /api/sessions/:id` rejects completed sessions (409)** — that's why `PATCH /api/sessions/:id/profile` exists as a separate endpoint.
8. **Drift detection (8s interval)** can conflict with manual speed adjustments — there's a 15s cooldown (`MANUAL_OVERRIDE_COOLDOWN`) after manual changes.
9. **Strava upload status stays "uploading"** — no polling for final status from Strava. The upload is async on Strava's side.
10. **Service worker cache** may serve stale files after deploy — bump version in sw.js or users must manually clear cache.
11. **Auto-upload to Strava** checks the `#autoSyncStrava` checkbox AND verifies the session's profile has a Strava connection before uploading.
12. **`getValidStravaToken(profileId)`** — with profileId: looks up by profile. Without: falls back to most recent connection (backwards compat).
13. **public/ files are baked into Docker image** — always rebuild Docker after changing frontend files. SCP alone is not enough.
14. **HR zone controller updates `currentTargetSpeed`/`currentTargetIncline`** — the controller's `onSpeedChange` callback updates these globals, so drift detection cooperates with it instead of fighting it.
15. **Coaching engine suppresses zone-violation TTS when HR zone controller is active** — `state.hrZoneControl.active` flag controls this. Zone violation messages (trigger 2) are skipped; HR zone controller sends its own TTS via `hr_zone_status` WebSocket messages.
16. **Sonestyring only works via native BLE service** — `app.js` browser-based `executeSegment()` does not support HR zone control. iPad/view.html starts sessions via WebSocket → ble-service handles everything.
17. **`set_speed`/`set_incline` WebSocket commands** are new — added for manual override during HR zone control. They also work for non-HR-controlled sessions. These pause the HR zone controller for 45 seconds.
18. **BLE service uses node-ble (D-Bus/BlueZ), not noble** — supports multiple simultaneous BLE connections. Requires D-Bus config file at `/etc/dbus-1/system.d/node-ble.conf` (installed by install.sh). If BLE connections fail, check `systemctl status bluetooth` and D-Bus permissions.
19. **BLE reconnect retries forever** — `BLE_MAX_ATTEMPTS` was removed (2026-05-05). Backoff caps at 60s. There is no "give up" state; if a device is off, the loop just keeps trying every 60s until it answers. First 3 attempts skip backoff entirely (run within ~100ms each) — most transient drops resolve in seconds.
20. **GATT discovery timeout triggers BlueZ cache clear** — after even one `GATT discovery timeout` failure, ble-service runs `bluetoothctl remove <addr>` to flush BlueZ's stale device cache before the next attempt. Mid-run drops typically recover in 20-30s now.
21. **Polar H10 MAC rotates on hard reset** — after 3+ failed reconnects, ble-service does a fresh BLE scan and matches by name prefix (`Polar`/`FitShow`). If found at a new address, `ble-config.json` is auto-updated. Without this, a hard-reset H10 would be unreachable until the saved address was manually replaced.
22. **`ble_force_reset` WebSocket command** — nuclear-option recovery used by view.html's "Tilbakestill BLE" button: disconnects everything, clears BlueZ cache for both addresses, power-cycles adapter, resets backoff counters, attempts fresh connect. Use when the auto-loop seems wedged.
23. **HR zone controller bypasses accumulation cap when sustained-high** — when HR has been clearly above zoneHigh+hysteresis for ≥90s, the controller skips both the direction-change cooldown and the accumulation cap for downward steps. This lets it descend all the way to `minSpeed` (3 km/h, walking pace) when the runner genuinely needs it.
24. **HR zone controller boundary timer uses hysteresis** — `boundaryStart` only resets after HR has been ≥3pp below zoneHigh for 5 ticks. Brief dips don't reset the timer, so the 60s "stuck at boundary" escalation actually fires when HR oscillates around the zone ceiling.
25. **HR zone controller pauses 120s on HRM drop mid-session**, in addition to its existing 300s pause on FTMS drop. On HRM reconnect mid-session, controller auto-resumes; coaching engine speaks "Pulsbeltet er tilbake."
26. **Calorie accumulation is time-based, not per-FTMS-event** — FTMS data fires at ~3 Hz on our treadmill, so the old per-event accumulation overestimated by ~3x. `lastCalorieTickAt` timestamp drives `dt`-weighted accumulation now (capped at 5s gap to avoid spikes after disconnects).
27. **Manual ±-buttons in view.html visible during ALL active session segments**, not just HR-controlled ones. Runner can override e.g. cooldown speed.

## Known Issues

- Drift detection can conflict with manual speed adjustments during workout
- Strava upload status stays as "uploading" — no polling for final status implemented
- Service worker cache may need manual clear after deploy (version bump in sw.js)
- `JSON.parse(workout.tags)` in GET /api/workouts lacks try-catch

## Documentation Governance

**CLAUDE.md is the single source of truth for AI sessions.** Other docs exist but may drift.

### Update triggers — when to update this file:
- **New/changed API endpoint** → update Key API Routes
- **Schema change** → update Database Schema + both migration files (server.js AND migrate.js)
- **New gotcha discovered** → add to Gotchas & Non-obvious
- **New env var** → update Environment Variables
- **Architecture change** → update Architecture section

### Other documentation files (may be stale):
- `README.md` — User-facing. Update features list and API tables when adding user-visible features
- `STRAVA_INTEGRATION.md` — **Historical reference only.** Written before per-profile Strava. Code is the source of truth for Strava implementation
- `ROADMAP.md` — Move items to "Implementert" when features ship. Update "Sist oppdatert" date
- `docs/*.md` — Setup guides. Update when deployment process changes

### Rule: Don't trust old .md files
Always verify against actual code (server.js, app.js) or on the RPi (`ssh pi@192.168.1.12`). If documentation conflicts with code, **code wins** — fix the docs.
