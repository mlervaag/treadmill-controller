# View Remote Control & Native BLE Service

**Date:** 2026-04-04
**Status:** Approved

## Problem

The current setup requires a Windows desktop PC running `index.html` with Web Bluetooth to control the treadmill and HR belt. The user must walk to the PC, connect BLE devices, load a workout, then walk to the treadmill. `view.html` on iPad/iPhone is view-only.

**Goal:** Make `view.html` a full remote control, and ultimately eliminate the desktop PC requirement by moving BLE to a native service on the Raspberry Pi.

## Architecture Overview

Two-phase approach where Phase 1 delivers immediate value and Phase 2 eliminates the desktop PC:

```
Phase 1 (WebSocket relay):
  view.html (iPhone) → WebSocket → server.js (RPi Docker) → WebSocket → index.html (desktop) → BLE → treadmill

Phase 2 (Native BLE):
  view.html (iPhone) → WebSocket → server.js (RPi Docker) → WebSocket → ble-service (RPi host systemd) → BLE → treadmill
```

The server becomes an intelligent hub with a `controller` abstraction. It does not care whether the controller is a browser or native service — it just routes commands.

## Phase 1: WebSocket Relay + view.html Remote Control

### 1.1 WebSocket Protocol Extension

**Client registration** — each WebSocket client identifies itself on connection:
```json
{ "type": "register", "role": "controller" }   // index.html or native BLE service
{ "type": "register", "role": "viewer" }        // view.html
```

**Commands** — from viewer to server:
```json
{ "type": "command", "id": "<uuid>", "action": "load_workout", "payload": { "workoutId": 5 } }
{ "type": "command", "id": "<uuid>", "action": "start_session" }
{ "type": "command", "id": "<uuid>", "action": "stop_session" }
{ "type": "command", "id": "<uuid>", "action": "skip_segment" }
```

**Remote commands** — from server to controller:
```json
{ "type": "remote_command", "id": "<uuid>", "action": "load_workout", "payload": { "workoutId": 5 } }
{ "type": "remote_command", "id": "<uuid>", "action": "start_session" }
{ "type": "remote_command", "id": "<uuid>", "action": "stop_session" }
{ "type": "remote_command", "id": "<uuid>", "action": "skip_segment" }
```

**Command results** — from server to viewer:
```json
{ "type": "command_result", "id": "<uuid>", "action": "load_workout", "success": true }
{ "type": "command_result", "id": "<uuid>", "action": "start_session", "success": false, "error": "No workout loaded" }
```

**Device status** — from controller to server, broadcasted to all viewers:
```json
{ "type": "device_status", "treadmill": "connected", "hrm": "connected", "bleBackend": "browser" }
```

**Workout list** — `list_workouts` is handled directly by the server (it has the DB), no relay needed:
```json
// Request
{ "type": "command", "id": "<uuid>", "action": "list_workouts" }
// Response
{ "type": "command_result", "id": "<uuid>", "action": "list_workouts", "success": true, "payload": { "workouts": [...] } }
```

**Existing message** — `treadmill_state` broadcast unchanged.

### 1.2 Server Changes (server.js)

**WebSocket hub upgrade:**
- Track client roles: maintain a `Map<WebSocket, { role: string }>` for connected clients
- On `register` message: store the client's role
- On `command` from a viewer:
  - If `action` is `list_workouts`: handle directly, query DB, respond
  - Otherwise: find the registered `controller` client and forward as `remote_command`
  - If no controller is connected: respond with `command_result` `{ success: false, error: "No controller connected" }`
- On `command_result` from controller: forward to the viewer that sent the original command (track by `id`)
- On `device_status` from controller: cache it and broadcast to all viewers
- On `treadmill_state` from controller: existing behavior (cache + broadcast)

**HTTP dual-serve:**
- Create both an HTTP server (port 3000) and HTTPS server (port 3001, if certs exist)
- Both share the same Express app
- Each gets its own WebSocket.Server instance, but both funnel into the same hub logic
- Environment variables: `HTTP_PORT` (default 3000), `HTTPS_PORT` (default 3001)
- Docker: expose both ports

### 1.3 index.html / app.js Changes (Controller)

**On WebSocket connect:** send `{ type: "register", role: "controller" }`

**Handle `remote_command` messages:**
- `load_workout`: call existing `loadWorkoutFromCard()` logic with the given workoutId, respond with `command_result`
- `start_session`: call existing `startLoadedWorkout()`, respond with `command_result`
- `stop_session`: call existing `endSession()`, respond with `command_result`
- `skip_segment`: advance `currentSegmentIndex`, call `executeSegment(next)`, respond with `command_result`

**Broadcast `device_status`:** periodically (every 5s) or on connection change, send device_status message with treadmill/hrm connection state.

### 1.4 view.html Changes (Viewer + Remote Control)

**Three UI states:**

1. **Idle** — no workout loaded
   - Header: BLE device status indicators (treadmill, HRM, server) — read-only dots (green/red/amber)
   - Body: Workout selector (list from `list_workouts` command), "Last inn økt" button
   - Footer: —

2. **Ready** — workout loaded, waiting for start
   - Header: same device status
   - Body: Loaded workout details (name, segments, duration, speed range), segment intensity bar preview
   - Buttons: "Start økt" (green), "Bytt" (to go back to selector)
   - Note: "Eller trykk Start på møllen"

3. **Active** — session in progress (extends current dashboard)
   - All current stats (speed, incline, HR, distance, time, calories)
   - Current segment info + progress bar
   - Next segment info line
   - Control buttons: "Hopp segment", "Stopp økt"

**On WebSocket connect:** send `{ type: "register", role: "viewer" }`

**State transitions:**
- Idle → Ready: on successful `load_workout` command_result
- Ready → Active: on `treadmill_state` with `sessionActive: true` (triggered by start command or physical treadmill button)
- Active → Idle: on `treadmill_state` with `sessionActive: false` after session was active

**Feature availability by backend:**
- When `device_status.bleBackend === "browser"`: BLE connect/disconnect buttons hidden (read-only status)
- When `device_status.bleBackend === "native"`: BLE connect/disconnect buttons shown (Phase 2)

### 1.5 Docker Changes

Update `docker-compose.yml`:
```yaml
ports:
  - "3000:3000"   # HTTP (view.html, no cert warnings)
  - "3001:3001"   # HTTPS (index.html, Web Bluetooth)
```

## Phase 2: Native BLE Service on RPi

### 2.1 BLE Service Architecture

A separate Node.js process running directly on the RPi host (not in Docker):

- **Location:** `/home/pi/treadmill-controller/ble-service/`
- **Entry point:** `ble-service.js`
- **Dependencies:** `@abandonware/noble` for BLE, `ws` for WebSocket client
- **Runs as:** systemd service (`treadmill-ble.service`)
- **Communicates with:** server.js via `ws://localhost:3000`

### 2.2 BLE Service Responsibilities

1. **BLE device management:**
   - Store known device addresses in `ble-config.json`
   - On startup: attempt to connect to known devices automatically
   - On command: scan for new devices, connect, disconnect
   - Auto-reconnect on connection loss (exponential backoff, max 30s)

2. **FTMS protocol (ported from ftms.js):**
   - Subscribe to Treadmill Data notifications → parse using same logic as `parseTreadmillData()`
   - Subscribe to Fitness Machine Status notifications → parse status codes
   - Write to Control Point: setSpeed, setIncline, start, stop, pause
   - Command timing: 400ms minimum between BLE writes
   - Drift detection: check actual vs target every 8s

3. **HRM protocol (ported from hrm.js):**
   - Subscribe to Heart Rate Measurement notifications
   - Parse HR value (8-bit or 16-bit based on flags)
   - Handle sensor contact detection

4. **WebSocket client to server.js:**
   - Connect to `ws://localhost:3000`
   - Register as `{ type: "register", role: "controller" }`
   - Broadcast `treadmill_state` every 2 seconds (same format as app.js)
   - Broadcast `device_status` on connection changes: `{ bleBackend: "native" }`
   - Handle `remote_command` messages: execute BLE operations directly
   - Respond with `command_result`

5. **Session management:**
   - `load_workout`: fetch workout from server via HTTP (`GET /api/workouts/:id`), store locally
   - `start_session`: create session via HTTP (`POST /api/sessions`), start FTMS, begin segment execution
   - `stop_session`: flush data, update session via HTTP (`PUT /api/sessions/:id`)
   - `skip_segment`: advance to next segment
   - Segment execution: timer-based, same logic as app.js `executeSegment()`
   - Data recording: buffer data points, flush to server via HTTP (`POST /api/sessions/:id/data`)

### 2.3 BLE Service Commands (via WebSocket)

In addition to the existing commands, Phase 2 adds:
```json
{ "type": "command", "id": "<uuid>", "action": "ble_scan" }
{ "type": "command", "id": "<uuid>", "action": "ble_connect", "payload": { "device": "treadmill", "address": "AA:BB:CC:DD:EE:FF" } }
{ "type": "command", "id": "<uuid>", "action": "ble_disconnect", "payload": { "device": "treadmill" } }
{ "type": "command", "id": "<uuid>", "action": "ble_reconnect", "payload": { "device": "treadmill" } }
```

Scan results:
```json
{ "type": "command_result", "id": "<uuid>", "action": "ble_scan", "success": true, "payload": { "devices": [{ "name": "FS-A58A49", "address": "AA:BB:CC:DD:EE:FF", "rssi": -45, "services": ["1826"] }] } }
```

### 2.4 BLE Config File (`ble-config.json`)

```json
{
  "treadmill": {
    "address": "AA:BB:CC:DD:EE:FF",
    "name": "FS-A58A49"
  },
  "hrm": {
    "address": "11:22:33:44:55:66",
    "name": "Polar H10"
  },
  "autoConnect": true,
  "serverUrl": "ws://localhost:3000"
}
```

### 2.5 Systemd Service

```ini
[Unit]
Description=Treadmill BLE Service
After=bluetooth.target network.target
Wants=bluetooth.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/pi/treadmill-controller/ble-service
ExecStartPre=/usr/bin/bluetoothctl power on
ExecStart=/usr/bin/node ble-service.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Note: runs as root because noble requires raw HCI access on Linux.

### 2.6 RPi Bluetooth Setup

- Unblock Bluetooth: `rfkill unblock bluetooth`
- Enable and start BlueZ: `systemctl enable bluetooth && systemctl start bluetooth`
- The `ExecStartPre` in the systemd unit handles `bluetoothctl power on`

### 2.7 view.html Phase 2 Additions

When `device_status.bleBackend === "native"`:
- Show "Koble til" / "Koble fra" buttons next to each device status indicator
- Show "Skann etter enheter" button in idle state if no devices are connected
- Scan results shown as selectable list → user picks device → `ble_connect` command sent

## Feature Matrix

| Feature | Desktop backend (Phase 1) | Native BLE (Phase 2) |
|---|---|---|
| View stats/dashboard | Yes | Yes |
| View BLE status | Yes (read-only) | Yes (read-only) |
| BLE connect/disconnect | No | Yes |
| BLE scan for devices | No | Yes |
| Load workout | Yes (server relay → desktop) | Yes (server relay → native) |
| Start/stop session | Yes (server relay → desktop) | Yes (server relay → native) |
| Skip segment | Yes (server relay → desktop) | Yes (server relay → native) |

## HTTP + HTTPS Dual-Serve

- `server.js` creates both HTTP and HTTPS servers (HTTPS only if certs exist)
- Both servers share the same Express app and WebSocket hub logic
- HTTP port: 3000 (configurable via `HTTP_PORT` env var)
- HTTPS port: 3001 (configurable via `HTTPS_PORT` env var)
- `view.html` accessed via `http://192.168.1.12:3000/view.html` — no certificate warnings
- `index.html` accessed via `https://192.168.1.12:3001/` — required for Web Bluetooth
- Phase 2: no client needs HTTPS, HTTP is sufficient for everything

## Files Changed / Created

### Phase 1:
- `server.js` — WebSocket hub upgrade (client roles, command routing, dual HTTP/HTTPS)
- `public/app.js` — handle `remote_command` messages, send `device_status`, register as controller
- `public/view.html` — complete rewrite: three UI states, command sending, workout selector
- `docker-compose.yml` — expose port 3000

### Phase 2:
- `ble-service/ble-service.js` — Native BLE service (new)
- `ble-service/package.json` — Dependencies: `@abandonware/noble`, `ws` (new)
- `ble-service/ble-config.json` — Known device addresses (new)
- `ble-service/treadmill-ble.service` — systemd unit file (new)
- `ble-service/install.sh` — Setup script: install deps, enable bluetooth, install systemd service (new)
- `public/view.html` — Add BLE management UI when native backend detected

## Error Handling

- **No controller connected:** Server responds to commands with `{ success: false, error: "No controller connected" }`
- **Command timeout:** If controller doesn't respond within 10s, server sends timeout error to viewer
- **BLE connection lost (Phase 2):** Native service attempts auto-reconnect, broadcasts `device_status` with updated state
- **WebSocket disconnect:** Both controller and viewer auto-reconnect with exponential backoff (existing behavior)
- **Stale state:** view.html existing 10s stale-check continues to work

## Backwards Compatibility

- `index.html` continues to work exactly as today when used directly
- `view.html` without any controller connected shows idle state with "No controller connected" message
- The desktop PC workflow is fully preserved — Phase 2 is additive, not replacing
- If both a desktop browser and native BLE service are connected as controllers, the native service takes priority (it has `bleBackend: "native"`). The server tracks the active controller and prefers native over browser.
