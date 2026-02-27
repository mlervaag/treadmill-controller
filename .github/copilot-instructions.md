# Copilot Instructions

This file provides guidance when working with code in this repository.

## Project Overview

Treadmill controller web app using Web Bluetooth (FTMS protocol) to control a treadmill and track workouts. Runs on a Raspberry Pi via Docker, served over HTTPS (required for Web Bluetooth). All data is local — no cloud services (except optional Strava sync). UI is in Norwegian.

## Commands

```bash
npm install           # Install deps (needs python3, make, g++ for better-sqlite3)
npm start             # Start server on http://localhost:3001
node migrate.js       # Add missing columns to existing tables
docker compose build  # Build Docker image
docker compose up -d  # Start in production
```

No test suite exists. No linter configured.

## Architecture

**Backend**: Express 5 + better-sqlite3 (WAL mode) + WebSocket (ws). Single `server.js` (~1250 lines) handles REST API, WebSocket relay (for view dashboard), template syncing, Strava OAuth/upload, session exports (JSON/CSV/TCX), and HTTPS/HTTP auto-detection based on cert presence.

**Frontend**: Vanilla JS (no framework). Key files:
- `public/ftms.js` — FTMS Bluetooth protocol: connect, parse treadmill data notifications, write control point commands (speed/incline/start/stop). Commands throttled with 400ms minimum gap.
- `public/hrm.js` — Heart Rate Monitor Bluetooth protocol (UUID 0x180D). Optional; HRM takes priority over treadmill's built-in HR sensor.
- `public/app.js` — Main application (~3000 lines). Manages UI tabs (Control/Workouts/History), workout execution with segment progression, session recording (1 data point/second), drift detection, Chart.js graphs, sound alerts, Strava integration, date filtering, export, auto BLE reconnect, segment feedback, WebSocket state broadcast.
- `public/view.html` — Standalone read-only dashboard for iPad/iPhone (no Web Bluetooth needed). Receives treadmill state via WebSocket.
- `public/sw.js` — Service worker for PWA offline support.
- `public/manifest.json` — PWA manifest with Norwegian locale.

**Database tables**: `workouts` → `workout_segments` (1:N), `workout_sessions` → `session_data` (1:N), `strava_auth`. 38 professional templates loaded from `templates.json` on startup.

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
```

## Key API Routes

- `GET/POST /api/workouts` — CRUD for workouts (with segments)
- `PUT /api/workouts/:id` — Update existing workout
- `GET/POST/PUT/DELETE /api/sessions` — Session lifecycle (create → record data → complete)
- `POST /api/sessions/:id/data` — Record data point each second (with optional `segment_index`)
- `GET /api/sessions/:id/details` — Full session with all data points
- `GET /api/sessions/:id/segments` — Per-segment aggregated feedback
- `GET /api/sessions/:id/export/json|csv|tcx` — Export session data
- `GET /api/stats/overall|weekly|monthly` — Aggregated statistics
- `GET /auth/strava` — OAuth redirect to Strava
- `GET /auth/strava/callback` — OAuth callback
- `GET /api/strava/status` — Connection status
- `DELETE /api/strava/disconnect` — Remove Strava connection
- `POST /api/strava/upload/:sessionId` — Upload session as TCX to Strava

## FTMS Protocol Details

Control Point writes (OpCode + params, little-endian):
- `0x02 [speed*100 as uint16]` — Set target speed (km/h)
- `0x03 [incline*10 as int16]` — Set target incline (%)
- `0x07` — Start/Resume
- `0x08 0x01` — Stop, `0x08 0x02` — Pause

Status notifications: `0x0A` = speed accepted, `0x0B` = incline accepted, `0x04` = started, `0x02` = stopped.

Speed range: 0.1–14.0 km/h. Incline range: 0–12%.

## Conventions

- UI text is in Norwegian
- Use `escapeHtml()` for any user data inserted via innerHTML (XSS prevention)
- SQL queries use parameterized prepared statements (better-sqlite3)
- BLE commands are throttled with 400ms minimum gap
- Session data recorded at 1 data point per second
- WebSocket state broadcast every 2 seconds
- All API error responses use Norwegian messages

## Known Issues

- Drift detection can conflict with manual speed adjustments during workout
- Strava upload status stays as "uploading" — no polling for final status implemented
- Service worker cache may need manual clear after deploy (version bump in sw.js)
