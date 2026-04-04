# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Treadmill controller web app using Bluetooth (FTMS protocol) to control a treadmill and track workouts. Runs on a Raspberry Pi via Docker. Two BLE backends: browser-based (Web Bluetooth via desktop PC) or native (systemd service on RPi host using @abandonware/noble). All data is local — no cloud services (except optional Strava sync). UI is in Norwegian.

## Commands

```bash
# Development
npm install           # Install deps (needs python3, make, g++ for better-sqlite3)
npm start             # Start server on http://localhost:3000 + https://localhost:3001

# Database migration
node migrate.js       # Add missing columns to existing tables (strava_auth, segment_index, etc.)

# Docker (production — Raspberry Pi at 192.168.1.12, user: pi)
docker compose build
docker compose up -d
docker compose down

# Deploy to Pi from Windows
scp server.js migrate.js docker-compose.yml .env pi@192.168.1.12:~/treadmill-controller/
scp public/* pi@192.168.1.12:~/treadmill-controller/public/
ssh pi@192.168.1.12 "cd ~/treadmill-controller && docker compose build && docker rm -f treadmill-controller 2>/dev/null; docker compose up -d"

# SSL cert generation (required for Web Bluetooth over network)
openssl req -x509 -newkey rsa:4096 -nodes -out certs/server.crt -keyout certs/server.key -days 365

# BLE Service (on RPi host, outside Docker)
cd ~/treadmill-controller/ble-service && bash install.sh  # First-time setup
sudo systemctl start treadmill-ble    # Start BLE service
sudo systemctl status treadmill-ble   # Check status
sudo journalctl -u treadmill-ble -f   # View logs
```

No test suite exists. No linter configured.

## Architecture

**Backend**: Express 5 + better-sqlite3 (WAL mode) + WebSocket (ws). Single `server.js` (~1250 lines) handles REST API, WebSocket relay (for view dashboard), template syncing, Strava OAuth/upload, session exports (JSON/CSV/TCX), and HTTPS/HTTP auto-detection based on cert presence.

**Frontend**: Vanilla JS (no framework). Key files:
- `public/ftms.js` — FTMS Bluetooth protocol: connect, parse treadmill data notifications, write control point commands (speed/incline/start/stop). Commands throttled with 400ms minimum gap. Confirmation mechanism waits for FTMS status codes 0x0A/0x0B.
- `public/hrm.js` — Heart Rate Monitor Bluetooth protocol (UUID 0x180D). Optional; HRM takes priority over treadmill's built-in HR sensor.
- `public/app.js` — Main application (~3000 lines). Manages UI tabs (Control/Workouts/History), workout execution with segment progression, session recording (1 data point/second), drift detection, Chart.js graphs, sound alerts, Strava integration, date filtering, export, auto BLE reconnect, segment feedback, WebSocket state broadcast.
- `public/view.html` — Remote control + dashboard for iPad/iPhone. Three states: idle (workout selector), ready (workout loaded), active (live dashboard + controls). Sends commands via WebSocket, receives state broadcasts. Dark theme, responsive, auto-reconnect, HR zone coloring.
- `public/sw.js` — Service worker for PWA offline support. Cache-first for static assets, network-first for API.
- `public/manifest.json` — PWA manifest with Norwegian locale.

**BLE Service** (`ble-service/`): Separate Node.js process on RPi host (not Docker). Uses `@abandonware/noble` for BLE. Runs as systemd service (`treadmill-ble.service`). Connects to server via WebSocket on `ws://localhost:3000`. Stores known device addresses in `ble-config.json`.

**Dual HTTP/HTTPS**: server.js listens on HTTP (port 3000, env `HTTP_PORT`) and HTTPS (port 3001 if certs exist, env `HTTPS_PORT`). view.html uses HTTP (no cert warnings on iOS). index.html uses HTTPS for Web Bluetooth.

**WebSocket Hub**: server.js routes commands between viewer clients (view.html) and the active controller (index.html browser or native BLE service). Controllers register with `{ type: "register", role: "controller" }`. Native BLE service takes priority over browser controllers. Protocol: `command` → `remote_command` → `command_response`.

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
- `GET /auth/strava/callback` — OAuth callback (exchange code for tokens)
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

When treadmill sends status `0x02` (stopped), app auto-ends session and workout without confirm dialog.

## Environment Variables

Strava integration requires `.env` file (or environment variables):
```
STRAVA_CLIENT_ID=<from strava.com/settings/api>
STRAVA_CLIENT_SECRET=<from strava.com/settings/api>
APP_URL=https://192.168.1.12:3001
```

Note: Strava API does not support setting activity privacy. Users must set "Default Activity Privacy" to "Only You" in Strava settings.

## Known Issues

- Drift detection can conflict with manual speed adjustments during workout
- Strava upload status stays as "uploading" — no polling for final status implemented
- Service worker cache may need manual clear after deploy (version bump in sw.js)
