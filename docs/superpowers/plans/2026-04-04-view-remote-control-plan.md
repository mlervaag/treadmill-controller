# View Remote Control & Native BLE Service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make view.html a full remote control for loading/starting/stopping workouts, add HTTP+HTTPS dual-serve, and create a native BLE service on the RPi that eliminates the desktop PC requirement.

**Architecture:** Server becomes a WebSocket hub with client roles (controller/viewer). Commands from viewers are relayed to the active controller (browser or native BLE service). HTTP serves view.html without cert warnings; HTTPS serves index.html for Web Bluetooth. Native BLE service runs as systemd on RPi host, connects to FTMS treadmill + HR belt directly.

**Tech Stack:** Node.js, Express 5, ws (WebSocket), @abandonware/noble (BLE), systemd, better-sqlite3

**Spec:** `docs/superpowers/specs/2026-04-04-view-remote-control-design.md`

---

## File Structure

### Phase 1 (modified):
- `server.js` — Add dual HTTP/HTTPS, WebSocket hub with client roles and command routing
- `public/app.js` — Register as controller, handle remote_command messages, broadcast device_status
- `public/view.html` — Complete rewrite: three UI states (idle/ready/active), command sending
- `docker-compose.yml` — Expose HTTP port 3000 in addition to HTTPS 3001

### Phase 2 (new files):
- `ble-service/ble-service.js` — Main BLE service entry point, WebSocket client, session management
- `ble-service/ftms-native.js` — FTMS BLE protocol using noble (ported from public/ftms.js)
- `ble-service/hrm-native.js` — HRM BLE protocol using noble (ported from public/hrm.js)
- `ble-service/package.json` — Dependencies: @abandonware/noble, ws
- `ble-service/ble-config.json` — Known device addresses, auto-connect settings
- `ble-service/treadmill-ble.service` — systemd unit file
- `ble-service/install.sh` — Setup script for RPi

---

## Phase 1: WebSocket Relay + view.html Remote Control

### Task 1: Dual HTTP/HTTPS in server.js

**Files:**
- Modify: `server.js` (lines 1-27, 1269-1278)
- Modify: `docker-compose.yml`

- [ ] **Step 1: Update server.js to create both HTTP and HTTPS servers**

Replace the current server creation block (lines 1-27 and 1269-1278) with dual-server logic:

```javascript
// At top of server.js, replace the existing server creation (lines 10-27):

const HTTP_PORT = parseInt(process.env.HTTP_PORT) || 3000;
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

// Always create HTTP server
const httpServer = http.createServer(app);
console.log('📡 HTTP server created');

// Create HTTPS server if certs exist
let httpsServer = null;
const useHTTPS = fs.existsSync('./certs/server.key') && fs.existsSync('./certs/server.crt');
if (useHTTPS) {
  const httpsOptions = {
    key: fs.readFileSync('./certs/server.key'),
    cert: fs.readFileSync('./certs/server.crt')
  };
  httpsServer = https.createServer(httpsOptions, app);
  console.log('🔒 HTTPS server created');
}
```

Remove the old `const wss`, `const PORT`, `const HOST`, and `server.listen()` block. The WebSocket setup and listen calls will be in Task 2.

- [ ] **Step 2: Update docker-compose.yml to expose both ports**

```yaml
    ports:
      - "3000:3000"   # HTTP (view.html, no cert warnings)
      - "3001:3001"   # HTTPS (index.html, Web Bluetooth)
```

- [ ] **Step 3: Test locally that server starts**

Run: `npm start` in the project directory. Verify console shows both HTTP and HTTPS server messages.

- [ ] **Step 4: Commit**

```bash
git add server.js docker-compose.yml
git commit -m "feat: add dual HTTP/HTTPS server support"
```

---

### Task 2: WebSocket Hub with Client Roles

**Files:**
- Modify: `server.js` (lines 1230-1278 — WebSocket section + listen block)

- [ ] **Step 1: Replace the WebSocket section with the new hub**

Replace everything from line 1230 (`// WebSocket for real-time treadmill data`) to the end of the file with:

```javascript
// =============================================
// WebSocket Hub — client roles & command routing
// =============================================

// Client tracking
const clients = new Map(); // ws -> { role: 'controller'|'viewer', registeredAt: Date }
const pendingCommands = new Map(); // commandId -> { viewerWs, timestamp }
let latestDeviceStatus = null;
const COMMAND_TIMEOUT_MS = 10000;

function setupWebSocketServer(server) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws, req) => {
    // Validate origin — only allow local network connections
    const origin = req.headers.origin || '';
    if (origin && !origin.match(/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/)) {
      ws.close(1008, 'Origin not allowed');
      return;
    }
    console.log('Client connected');

    // Send cached state to new clients immediately
    if (latestTreadmillState) {
      ws.send(JSON.stringify(latestTreadmillState));
    }
    if (latestDeviceStatus) {
      ws.send(JSON.stringify(latestDeviceStatus));
    }

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        if (typeof data !== 'object' || data === null) return;
        handleWebSocketMessage(ws, data, wss);
      } catch { return; }
    });

    ws.on('close', () => {
      const clientInfo = clients.get(ws);
      if (clientInfo) {
        console.log(`${clientInfo.role} disconnected`);
        // If controller disconnected, notify viewers
        if (clientInfo.role === 'controller') {
          broadcastToViewers(wss, {
            type: 'device_status',
            treadmill: 'disconnected',
            hrm: 'disconnected',
            bleBackend: null
          });
        }
      }
      clients.delete(ws);
    });
  });

  return wss;
}

function handleWebSocketMessage(ws, data, wss) {
  switch (data.type) {
    case 'register':
      handleRegister(ws, data, wss);
      break;

    case 'treadmill_state':
      // From controller — cache and broadcast to all
      latestTreadmillState = data.sessionActive ? data : null;
      broadcast(wss, data);
      break;

    case 'device_status':
      // From controller — cache and broadcast to viewers
      latestDeviceStatus = data;
      broadcastToViewers(wss, data);
      break;

    case 'command':
      // From viewer — route to controller or handle directly
      handleCommand(ws, data, wss);
      break;

    case 'command_result':
      // From controller — forward to the viewer that sent the command
      handleCommandResult(data);
      break;

    default:
      // Legacy: broadcast treadmill_state (backwards compat with old clients)
      if (data.type === 'treadmill_state') {
        latestTreadmillState = data.sessionActive ? data : null;
      }
      broadcast(wss, data);
      break;
  }
}

function handleRegister(ws, data, wss) {
  const role = data.role;
  if (role !== 'controller' && role !== 'viewer') return;

  clients.set(ws, { role, registeredAt: new Date(), bleBackend: data.bleBackend || null });
  console.log(`Client registered as ${role}${data.bleBackend ? ` (${data.bleBackend})` : ''}`);

  // If a native controller registers, it takes priority
  // Notify viewers of the active controller type
  if (role === 'controller') {
    const activeBackend = data.bleBackend || 'browser';
    broadcastToViewers(wss, {
      type: 'controller_info',
      bleBackend: activeBackend
    });
  }
}

function getActiveController(wss) {
  let nativeController = null;
  let browserController = null;

  for (const [ws, info] of clients.entries()) {
    if (info.role === 'controller' && ws.readyState === WebSocket.OPEN) {
      if (info.bleBackend === 'native') {
        nativeController = ws;
      } else {
        browserController = ws;
      }
    }
  }

  // Native takes priority over browser
  return nativeController || browserController;
}

function handleCommand(viewerWs, data, wss) {
  const { id, action, payload } = data;

  // Commands the server can handle directly
  if (action === 'list_workouts') {
    try {
      const workouts = db.prepare(`
        SELECT 
          w.*, 
          COUNT(ws.id) as segment_count,
          COALESCE(SUM(ws.duration_seconds), 0) as total_duration_seconds
        FROM workouts w
        LEFT JOIN workout_segments ws ON w.id = ws.workout_id
        GROUP BY w.id
        ORDER BY w.created_at DESC
      `).all();

      workouts.forEach(w => {
        try { w.tags = JSON.parse(w.tags); } catch { w.tags = []; }
      });

      viewerWs.send(JSON.stringify({
        type: 'command_result', id, action, success: true,
        payload: { workouts }
      }));
    } catch (err) {
      viewerWs.send(JSON.stringify({
        type: 'command_result', id, action, success: false,
        error: 'Failed to list workouts'
      }));
    }
    return;
  }

  // Commands that need a controller
  const controller = getActiveController(wss);
  if (!controller) {
    viewerWs.send(JSON.stringify({
      type: 'command_result', id, action, success: false,
      error: 'No controller connected'
    }));
    return;
  }

  // Track pending command for response routing
  pendingCommands.set(id, { viewerWs, timestamp: Date.now() });

  // Set timeout
  setTimeout(() => {
    if (pendingCommands.has(id)) {
      const pending = pendingCommands.get(id);
      pendingCommands.delete(id);
      if (pending.viewerWs.readyState === WebSocket.OPEN) {
        pending.viewerWs.send(JSON.stringify({
          type: 'command_result', id, action, success: false,
          error: 'Command timed out'
        }));
      }
    }
  }, COMMAND_TIMEOUT_MS);

  // Forward to controller as remote_command
  controller.send(JSON.stringify({
    type: 'remote_command', id, action, payload
  }));
}

function handleCommandResult(data) {
  const { id } = data;
  const pending = pendingCommands.get(id);
  if (pending) {
    pendingCommands.delete(id);
    if (pending.viewerWs.readyState === WebSocket.OPEN) {
      pending.viewerWs.send(JSON.stringify(data));
    }
  }
}

function broadcast(wss, data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function broadcastToViewers(wss, data) {
  const message = JSON.stringify(data);
  for (const [ws, info] of clients.entries()) {
    if (info.role === 'viewer' && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

// Clean up stale pending commands every 30s
setInterval(() => {
  const now = Date.now();
  for (const [id, pending] of pendingCommands.entries()) {
    if (now - pending.timestamp > COMMAND_TIMEOUT_MS * 2) {
      pendingCommands.delete(id);
    }
  }
}, 30000);

// =============================================
// Start servers
// =============================================

const httpWss = setupWebSocketServer(httpServer);

httpServer.listen(HTTP_PORT, HOST, () => {
  console.log(`📡 HTTP server running on http://${HOST}:${HTTP_PORT}`);
  console.log(`📡 WebSocket (ws) on ws://${HOST}:${HTTP_PORT}`);
});

if (httpsServer) {
  const httpsWss = setupWebSocketServer(httpsServer);
  httpsServer.listen(HTTPS_PORT, HOST, () => {
    console.log(`🔒 HTTPS server running on https://${HOST}:${HTTPS_PORT}`);
    console.log(`🔒 WebSocket (wss) on wss://${HOST}:${HTTPS_PORT}`);
  });
}
```

- [ ] **Step 2: Verify server starts and both ports listen**

Run: `npm start` and check console output shows both HTTP and HTTPS listening.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: WebSocket hub with client roles and command routing"
```

---

### Task 3: app.js Controller Registration & Remote Command Handling

**Files:**
- Modify: `public/app.js` (lines 701-760 — initStateBroadcast/stopStateBroadcast, and add remote command handler)

- [ ] **Step 1: Modify initStateBroadcast to register as controller and handle remote commands**

Replace `initStateBroadcast()` (line 701-735) with:

```javascript
function initStateBroadcast() {
    if (stateBroadcastWs) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    try {
        stateBroadcastWs = new WebSocket(wsUrl);
    } catch (e) {
        console.error('Failed to create broadcast WebSocket:', e);
        return;
    }

    stateBroadcastWs.onopen = () => {
        console.log('State broadcast WebSocket connected');
        // Register as controller
        stateBroadcastWs.send(JSON.stringify({
            type: 'register',
            role: 'controller',
            bleBackend: 'browser'
        }));
        startStateBroadcastTimer();
        broadcastDeviceStatus();
    };

    stateBroadcastWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'remote_command') {
                handleRemoteCommand(data);
            }
        } catch (e) {
            console.error('Failed to parse WebSocket message:', e);
        }
    };

    stateBroadcastWs.onclose = () => {
        console.log('State broadcast WebSocket disconnected');
        stateBroadcastWs = null;
        if (stateBroadcastTimer) {
            clearInterval(stateBroadcastTimer);
            stateBroadcastTimer = null;
        }
        if (deviceStatusTimer) {
            clearInterval(deviceStatusTimer);
            deviceStatusTimer = null;
        }
        // Auto-reconnect if session is still active
        if (currentSession) {
            setTimeout(initStateBroadcast, 3000);
        }
    };

    stateBroadcastWs.onerror = () => {
        if (stateBroadcastWs) stateBroadcastWs.close();
    };
}
```

- [ ] **Step 2: Add remote command handler and device status broadcast**

Add after the existing `stopStateBroadcast()` function (after line ~760):

```javascript
// Device status broadcasting
let deviceStatusTimer = null;

function broadcastDeviceStatus() {
    if (!stateBroadcastWs || stateBroadcastWs.readyState !== WebSocket.OPEN) return;

    stateBroadcastWs.send(JSON.stringify({
        type: 'device_status',
        treadmill: (treadmill && treadmill.isConnected()) ? 'connected' : 'disconnected',
        hrm: (hrm && hrm.isConnected()) ? 'connected' : 'disconnected',
        bleBackend: 'browser'
    }));

    // Repeat every 5 seconds
    if (!deviceStatusTimer) {
        deviceStatusTimer = setInterval(broadcastDeviceStatus, 5000);
    }
}

async function handleRemoteCommand(data) {
    const { id, action, payload } = data;
    console.log(`Remote command received: ${action}`, payload);

    try {
        switch (action) {
            case 'load_workout': {
                const response = await fetch(`/api/workouts/${payload.workoutId}`);
                if (!response.ok) throw new Error('Workout not found');
                loadedWorkout = await response.json();
                updateLoadedWorkoutUI();
                sendCommandResult(id, action, true);
                break;
            }

            case 'start_session': {
                if (!loadedWorkout) {
                    sendCommandResult(id, action, false, 'No workout loaded');
                    return;
                }
                if (!treadmill || !treadmill.isConnected()) {
                    sendCommandResult(id, action, false, 'Treadmill not connected');
                    return;
                }
                // Start the loaded workout
                currentWorkout = loadedWorkout;
                currentSegmentIndex = 0;
                document.getElementById('workoutProgress').classList.remove('hidden');
                document.getElementById('activeWorkoutName').textContent = currentWorkout.name;
                document.getElementById('totalSegments').textContent = currentWorkout.segments.length;
                buildWorkoutTimeline();
                await startSession(loadedWorkout.id);
                startLocalTimer();
                await executeSegment(0);
                loadedWorkout = null;
                updateLoadedWorkoutUI();
                sendCommandResult(id, action, true);
                break;
            }

            case 'stop_session': {
                if (!currentSession) {
                    sendCommandResult(id, action, false, 'No active session');
                    return;
                }
                await stopWorkout(false);
                sendCommandResult(id, action, true);
                break;
            }

            case 'skip_segment': {
                if (!currentWorkout || !currentSession) {
                    sendCommandResult(id, action, false, 'No active workout');
                    return;
                }
                if (workoutTimer) clearInterval(workoutTimer);
                await executeSegment(currentSegmentIndex + 1);
                sendCommandResult(id, action, true);
                break;
            }

            default:
                sendCommandResult(id, action, false, `Unknown action: ${action}`);
        }
    } catch (error) {
        console.error(`Remote command ${action} failed:`, error);
        sendCommandResult(id, action, false, error.message);
    }
}

function sendCommandResult(id, action, success, error = null) {
    if (!stateBroadcastWs || stateBroadcastWs.readyState !== WebSocket.OPEN) return;
    const result = { type: 'command_result', id, action, success };
    if (error) result.error = error;
    stateBroadcastWs.send(JSON.stringify(result));
}
```

- [ ] **Step 3: Ensure initStateBroadcast is called on page load (not just on session start)**

In the `DOMContentLoaded` handler (around line 84), add a call to start the WebSocket connection immediately so the controller is always registered:

```javascript
// After loadWorkouts() call in DOMContentLoaded:
initStateBroadcast();
```

Also modify `stopStateBroadcast()` to NOT close the WebSocket — only stop the state broadcast timer. The WS connection should stay open for receiving remote commands:

Replace `stopStateBroadcast()` with:

```javascript
function stopStateBroadcast() {
    if (stateBroadcastTimer) {
        clearInterval(stateBroadcastTimer);
        stateBroadcastTimer = null;
    }
    // Send final state with sessionActive=false
    if (stateBroadcastWs && stateBroadcastWs.readyState === WebSocket.OPEN) {
        stateBroadcastWs.send(JSON.stringify({
            type: 'treadmill_state',
            timestamp: Date.now(),
            sessionActive: false
        }));
    }
    // NOTE: Do NOT close the WebSocket — keep it open for remote commands
}
```

- [ ] **Step 4: Test by opening index.html and verifying WebSocket connects and registers**

Open browser console on desktop, check for "State broadcast WebSocket connected" and no errors.

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat: register as controller, handle remote commands from viewers"
```

---

### Task 4: Rewrite view.html with Remote Control UI

**Files:**
- Modify: `public/view.html` (complete rewrite)

- [ ] **Step 1: Write the new view.html**

This is a complete rewrite. The file replaces the existing `public/view.html`. Key changes:
- Three UI states: idle (workout selector), ready (workout loaded), active (dashboard + controls)
- WebSocket commands for load/start/stop/skip
- Device status indicators in header
- Maintains all existing dashboard display functionality

```html
<!DOCTYPE html>
<html lang="no">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#000000">
    <title>Tredemølle</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { overflow-x: hidden; max-width: 100%; }

        :root {
            --primary: #007AFF;
            --success: #34C759;
            --warning: #FF9500;
            --danger: #FF3B30;
            --bg: #000000;
            --card: #1C1C1E;
            --card-light: #2C2C2E;
            --text: #FFFFFF;
            --text-sec: #ABABAF;
            --border: #38383A;
            --zone1: #8E8E93; --zone2: #007AFF; --zone3: #34C759;
            --zone4: #FF9500; --zone5: #FF3B30;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;
            background: var(--bg); color: var(--text);
            min-height: 100dvh; overflow-x: hidden;
        }

        .container {
            max-width: 1200px; margin: 0 auto; padding: 12px;
            min-height: 100dvh; display: flex; flex-direction: column;
        }

        /* Header */
        .header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 8px 4px; margin-bottom: 12px;
        }
        .header h1 { font-size: 16px; font-weight: 600; color: var(--text-sec); letter-spacing: 0.5px; text-transform: uppercase; }
        .status-dots { display: flex; gap: 12px; align-items: center; }
        .status-item { display: flex; align-items: center; gap: 4px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--danger); transition: background 0.3s; }
        .dot.ok { background: var(--success); }
        .dot.warn { background: var(--warning); animation: pulse 1.5s infinite; }
        .status-label { font-size: 11px; color: var(--text-sec); }

        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

        .hidden { display: none !important; }

        /* Idle state — workout selector */
        .idle-state { flex: 1; display: flex; flex-direction: column; gap: 12px; }
        .section-label { font-size: 13px; color: var(--text-sec); text-transform: uppercase; letter-spacing: 1px; font-weight: 600; margin-bottom: 8px; }
        .workout-list { display: flex; flex-direction: column; gap: 8px; }
        .workout-item {
            background: var(--card); border-radius: 12px; padding: 14px;
            border: 2px solid transparent; cursor: pointer; transition: border-color 0.2s;
        }
        .workout-item.selected { border-color: var(--primary); }
        .workout-item-header { display: flex; justify-content: space-between; align-items: center; }
        .workout-item-name { font-weight: 600; font-size: 16px; }
        .workout-item-meta { font-size: 13px; color: var(--text-sec); margin-top: 2px; }
        .workout-item-badge { font-size: 12px; color: var(--primary); font-weight: 600; }
        .btn {
            width: 100%; padding: 16px; border: none; border-radius: 14px;
            font-size: 18px; font-weight: 600; cursor: pointer; transition: opacity 0.2s;
        }
        .btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .btn-primary { background: var(--primary); color: white; }
        .btn-success { background: var(--success); color: white; }
        .btn-danger { background: var(--danger); color: white; }
        .btn-secondary { background: var(--card-light); color: var(--text-sec); border: 1px solid var(--border); }
        .btn-row { display: flex; gap: 10px; }
        .btn-row .btn { flex: 1; }
        .btn-row .btn-small { flex: 0; padding: 16px 20px; font-size: 14px; }
        .no-controller { text-align: center; padding: 40px 20px; color: var(--text-sec); }
        .no-controller h2 { font-size: 22px; margin-bottom: 8px; color: var(--text); }

        /* Ready state */
        .ready-state { flex: 1; display: flex; flex-direction: column; gap: 16px; }
        .loaded-card {
            background: var(--card); border-radius: 16px; padding: 20px;
            border: 1px solid var(--border);
        }
        .loaded-name { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
        .loaded-meta { font-size: 14px; color: var(--text-sec); }
        .segment-bars {
            margin-top: 16px; display: flex; gap: 3px; height: 40px; align-items: flex-end;
        }
        .segment-bar {
            flex: 1; border-radius: 4px; min-width: 4px;
            transition: height 0.3s;
        }
        .start-hint { text-align: center; font-size: 14px; color: var(--text-sec); margin-top: 8px; }
        .start-hint strong { color: var(--text); }

        /* Active state — dashboard */
        .active-state { flex: 1; display: flex; flex-direction: column; gap: 12px; }
        .stat-grid { display: grid; gap: 10px; }
        .stat-grid.primary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .stat-grid.secondary { grid-template-columns: repeat(3, minmax(0, 1fr)); }

        .stat-card {
            background: var(--card); border-radius: 16px; padding: 16px;
            display: flex; flex-direction: column; align-items: center;
            justify-content: center; text-align: center; min-height: 130px;
            border: 1px solid var(--border); overflow: hidden;
        }
        .stat-label { font-size: 12px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: var(--text-sec); margin-bottom: 4px; }
        .stat-value { font-size: clamp(44px, 10vw, 80px); font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
        .stat-unit { font-size: 13px; color: var(--text-sec); margin-top: 2px; }
        .stat-card-sm {
            background: var(--card); border-radius: 12px; padding: 12px;
            display: flex; flex-direction: column; align-items: center;
            justify-content: center; text-align: center; min-height: 85px;
            border: 1px solid var(--border); overflow: hidden;
        }
        .stat-value-sm { font-size: clamp(26px, 6vw, 44px); font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
        .hr-zone { font-size: 13px; font-weight: 600; margin-top: 4px; padding: 2px 10px; border-radius: 8px; background: rgba(255,255,255,0.08); }
        .target-ind { font-size: 12px; color: var(--text-sec); margin-top: 4px; opacity: 0.7; }

        /* Workout progress */
        .workout-card {
            background: var(--card); border-radius: 16px; padding: 16px;
            border: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px;
        }
        .workout-header { display: flex; align-items: center; justify-content: space-between; }
        .workout-header h2 { font-size: 18px; font-weight: 600; }
        .seg-badge { background: var(--primary); color: white; padding: 3px 10px; border-radius: 10px; font-size: 13px; font-weight: 600; }
        .seg-info { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
        .seg-name { font-size: 20px; font-weight: 600; }
        .seg-targets { display: flex; gap: 16px; font-size: 15px; color: var(--text-sec); }
        .seg-targets strong { color: var(--text); }
        .progress-row { display: flex; align-items: center; gap: 12px; }
        .progress-outer { flex: 1; height: 10px; background: var(--card-light); border-radius: 5px; overflow: hidden; }
        .progress-inner { height: 100%; border-radius: 5px; transition: width 0.5s ease; width: 0%; }
        .progress-inner.seg { background: var(--primary); }
        .progress-inner.overall { background: linear-gradient(90deg, var(--primary), #667eea); }
        .time-left { font-size: 14px; font-weight: 600; color: var(--text-sec); white-space: nowrap; min-width: 80px; text-align: right; }
        .overall-section { display: flex; flex-direction: column; gap: 4px; }
        .overall-labels { display: flex; justify-content: space-between; font-size: 13px; color: var(--text-sec); }
        .next-seg {
            padding: 8px 12px; background: var(--card-light); border-radius: 10px;
            font-size: 14px; color: var(--text-sec); display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        }
        .next-seg .label { font-weight: 600; color: var(--text); }

        /* Controls */
        .controls { display: flex; gap: 8px; }
        .controls .btn { font-size: 14px; padding: 12px; }

        /* BLE management (Phase 2 only) */
        .ble-controls { display: flex; gap: 8px; margin-top: 8px; }
        .ble-btn {
            padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border);
            background: var(--card-light); color: var(--text-sec); font-size: 12px;
            cursor: pointer;
        }
        .ble-btn:hover { background: var(--card); color: var(--text); }

        /* Toast */
        .toast-container { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 1000; display: flex; flex-direction: column; gap: 8px; }
        .toast {
            padding: 12px 20px; border-radius: 12px; font-size: 14px; font-weight: 500;
            background: var(--card-light); color: var(--text); border: 1px solid var(--border);
            animation: fadeIn 0.3s ease;
        }
        .toast.error { border-color: var(--danger); }
        .toast.success { border-color: var(--success); }
        @keyframes fadeIn { from{opacity:0;transform:translateY(-10px)} to{opacity:1;transform:translateY(0)} }

        /* Responsive */
        @media (max-width: 600px) {
            .stat-grid.primary { grid-template-columns: 1fr 1fr; }
            .stat-grid.primary .stat-hr { grid-column: span 2; }
            .stat-card { min-height: 100px; }
            .stat-value { font-size: clamp(34px, 10vw, 56px); }
        }
        @media (orientation: landscape) and (max-height: 600px) {
            .stat-grid.primary, .stat-grid.secondary { grid-template-columns: repeat(6, 1fr); }
            .stat-card, .stat-card-sm { min-height: 70px; padding: 8px; }
            .stat-value { font-size: clamp(30px, 8vh, 56px); }
            .stat-value-sm { font-size: clamp(20px, 5vh, 32px); }
        }
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
        }
    </style>
</head>
<body>
    <div class="container">
        <header class="header">
            <h1 id="headerTitle">Tredemølle</h1>
            <div class="status-dots">
                <div class="status-item">
                    <div class="dot" id="dotTreadmill"></div>
                    <span class="status-label">Mølle</span>
                </div>
                <div class="status-item">
                    <div class="dot" id="dotHrm"></div>
                    <span class="status-label">Puls</span>
                </div>
                <div class="status-item">
                    <div class="dot" id="dotServer"></div>
                    <span class="status-label">Server</span>
                </div>
            </div>
        </header>

        <!-- BLE controls (Phase 2, native backend only) -->
        <div id="bleControls" class="ble-controls hidden">
            <button class="ble-btn" id="btnBleScan">Skann enheter</button>
            <button class="ble-btn" id="btnBleConnectTreadmill">Koble mølle</button>
            <button class="ble-btn" id="btnBleConnectHrm">Koble puls</button>
        </div>

        <!-- Toast container -->
        <div class="toast-container" id="toastContainer"></div>

        <!-- Idle state: workout selector -->
        <div id="stateIdle" class="idle-state">
            <div id="noController" class="no-controller hidden">
                <h2>Ingen kontroller tilkoblet</h2>
                <p>Åpne kontrollpanelet på en PC, eller start BLE-tjenesten på RPi.</p>
            </div>
            <div id="workoutSelector">
                <div class="section-label">Velg treningsøkt</div>
                <div class="workout-list" id="workoutList">
                    <div style="text-align:center;padding:20px;color:var(--text-sec)">Laster økter...</div>
                </div>
                <button class="btn btn-primary" id="btnLoad" disabled>Last inn økt</button>
            </div>
        </div>

        <!-- Ready state: workout loaded -->
        <div id="stateReady" class="ready-state hidden">
            <div class="loaded-card">
                <div class="section-label">Lastet økt</div>
                <div class="loaded-name" id="readyName"></div>
                <div class="loaded-meta" id="readyMeta"></div>
                <div class="segment-bars" id="readyBars"></div>
            </div>
            <div class="btn-row">
                <button class="btn btn-success" id="btnStart">Start økt</button>
                <button class="btn btn-secondary btn-small" id="btnChange">Bytt</button>
            </div>
            <p class="start-hint">Eller trykk <strong>Start</strong> på møllen</p>
        </div>

        <!-- Active state: dashboard -->
        <div id="stateActive" class="active-state hidden">
            <div class="stat-grid primary">
                <div class="stat-card">
                    <div class="stat-label">Hastighet</div>
                    <div class="stat-value" id="vSpeed">--</div>
                    <div class="stat-unit">km/t</div>
                    <div class="target-ind hidden" id="vSpeedTarget"></div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Stigning</div>
                    <div class="stat-value" id="vIncline">--</div>
                    <div class="stat-unit">%</div>
                    <div class="target-ind hidden" id="vInclineTarget"></div>
                </div>
                <div class="stat-card stat-hr" id="hrCard">
                    <div class="stat-label">Puls</div>
                    <div class="stat-value" id="vHR">--</div>
                    <div class="stat-unit">bpm</div>
                    <div class="hr-zone" id="vHRZone"></div>
                </div>
            </div>

            <!-- Workout section -->
            <div id="workoutSection" class="workout-card hidden">
                <div class="workout-header">
                    <h2 id="vWorkoutName"></h2>
                    <span class="seg-badge" id="vSegBadge"></span>
                </div>
                <div>
                    <div class="seg-info">
                        <span class="seg-name" id="vSegName"></span>
                        <div class="seg-targets">
                            <span>Mål: <strong id="vTargetSpeed">0</strong> km/t</span>
                            <span>Stigning: <strong id="vTargetIncline">0</strong>%</span>
                        </div>
                    </div>
                    <div class="progress-row" style="margin-top:8px">
                        <div class="progress-outer"><div class="progress-inner seg" id="vSegProgress"></div></div>
                        <span class="time-left" id="vSegTimeLeft">--:--</span>
                    </div>
                </div>
                <div class="overall-section">
                    <div class="overall-labels">
                        <span>Total fremgang</span>
                        <span id="vOverallPct">0%</span>
                    </div>
                    <div class="progress-row">
                        <div class="progress-outer"><div class="progress-inner overall" id="vOverallProgress"></div></div>
                        <span class="time-left" id="vWorkoutRemaining">--:--</span>
                    </div>
                </div>
                <div id="nextSegSection" class="next-seg hidden">
                    <span class="label">Neste:</span>
                    <span id="vNextInfo"></span>
                </div>
            </div>

            <!-- Controls -->
            <div class="controls">
                <button class="btn btn-secondary" id="btnSkip">Hopp segment ⏭</button>
                <button class="btn btn-danger" id="btnStop">Stopp økt ■</button>
            </div>

            <!-- Secondary stats -->
            <div class="stat-grid secondary">
                <div class="stat-card-sm">
                    <div class="stat-label">Distanse</div>
                    <div class="stat-value-sm" id="vDistance">0.00</div>
                    <div class="stat-unit">km</div>
                </div>
                <div class="stat-card-sm">
                    <div class="stat-label">Tid</div>
                    <div class="stat-value-sm" id="vTime">00:00</div>
                </div>
                <div class="stat-card-sm">
                    <div class="stat-label">Kalorier</div>
                    <div class="stat-value-sm" id="vCalories">0</div>
                    <div class="stat-unit">kcal</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // =============================================
        // State
        // =============================================
        const params = new URLSearchParams(window.location.search);
        const MAX_HR = parseInt(params.get('maxHR')) || 190;

        let ws = null;
        let reconnectAttempts = 0;
        const MAX_RECONNECT_DELAY = 30000;
        let lastStateTimestamp = 0;
        let staleCheckTimer = null;

        let appState = 'idle'; // 'idle' | 'ready' | 'active'
        let selectedWorkoutId = null;
        let loadedWorkoutData = null;
        let hasController = false;
        let bleBackend = null;
        let wasActive = false; // Track if session was active (for idle transition)

        // =============================================
        // WebSocket
        // =============================================
        function connect() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}`;
            setServerStatus('connecting');

            try { ws = new WebSocket(wsUrl); } catch (e) { scheduleReconnect(); return; }

            ws.onopen = () => {
                reconnectAttempts = 0;
                setServerStatus('connected');
                ws.send(JSON.stringify({ type: 'register', role: 'viewer' }));
                startStaleCheck();
                fetchWorkouts();
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    switch (data.type) {
                        case 'treadmill_state': handleTreadmillState(data); break;
                        case 'device_status': handleDeviceStatus(data); break;
                        case 'controller_info': handleControllerInfo(data); break;
                        case 'command_result': handleCommandResult(data); break;
                    }
                } catch (e) { console.error('Parse error:', e); }
            };

            ws.onclose = () => { setServerStatus('disconnected'); stopStaleCheck(); scheduleReconnect(); };
            ws.onerror = () => { if (ws) ws.close(); };
        }

        function scheduleReconnect() {
            reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
            setTimeout(connect, delay);
        }

        // =============================================
        // Command sending
        // =============================================
        let pendingCallbacks = {};

        function sendCommand(action, payload = {}) {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                showToast('Ikke tilkoblet server', 'error');
                return Promise.reject(new Error('Not connected'));
            }
            const id = crypto.randomUUID();
            return new Promise((resolve, reject) => {
                pendingCallbacks[id] = { resolve, reject };
                setTimeout(() => {
                    if (pendingCallbacks[id]) {
                        delete pendingCallbacks[id];
                        reject(new Error('Timeout'));
                    }
                }, 12000);
                ws.send(JSON.stringify({ type: 'command', id, action, payload }));
            });
        }

        function handleCommandResult(data) {
            const cb = pendingCallbacks[data.id];
            if (cb) {
                delete pendingCallbacks[data.id];
                if (data.success) cb.resolve(data);
                else cb.reject(new Error(data.error || 'Command failed'));
            }
        }

        // =============================================
        // State handlers
        // =============================================
        function handleTreadmillState(data) {
            lastStateTimestamp = Date.now();
            if (data.sessionActive) {
                wasActive = true;
                if (appState !== 'active') setState('active');
                renderDashboard(data);
            } else {
                if (wasActive) {
                    wasActive = false;
                    setState('idle');
                    fetchWorkouts();
                }
            }
        }

        function handleDeviceStatus(data) {
            hasController = true;
            bleBackend = data.bleBackend;
            document.getElementById('dotTreadmill').className = 'dot ' + (data.treadmill === 'connected' ? 'ok' : '');
            document.getElementById('dotHrm').className = 'dot ' + (data.hrm === 'connected' ? 'ok' : '');
            document.getElementById('noController').classList.add('hidden');
            document.getElementById('workoutSelector').classList.remove('hidden');

            // Show BLE controls only for native backend
            document.getElementById('bleControls').classList.toggle('hidden', bleBackend !== 'native');
        }

        function handleControllerInfo(data) {
            hasController = true;
            bleBackend = data.bleBackend;
            document.getElementById('noController').classList.add('hidden');
            document.getElementById('workoutSelector').classList.remove('hidden');
            document.getElementById('bleControls').classList.toggle('hidden', bleBackend !== 'native');
        }

        // =============================================
        // UI State Management
        // =============================================
        function setState(newState) {
            appState = newState;
            document.getElementById('stateIdle').classList.toggle('hidden', newState !== 'idle');
            document.getElementById('stateReady').classList.toggle('hidden', newState !== 'ready');
            document.getElementById('stateActive').classList.toggle('hidden', newState !== 'active');
            document.getElementById('headerTitle').textContent =
                newState === 'active' ? 'Aktiv økt' : 'Tredemølle';
            document.getElementById('headerTitle').style.color =
                newState === 'active' ? 'var(--success)' : 'var(--text-sec)';
        }

        // =============================================
        // Workout list
        // =============================================
        async function fetchWorkouts() {
            try {
                const result = await sendCommand('list_workouts');
                renderWorkoutList(result.payload.workouts);
            } catch (e) {
                // Fallback: try HTTP API directly
                try {
                    const resp = await fetch('/api/workouts');
                    const workouts = await resp.json();
                    renderWorkoutList(workouts);
                } catch (e2) {
                    document.getElementById('workoutList').innerHTML =
                        '<div style="text-align:center;padding:20px;color:var(--text-sec)">Kunne ikke laste økter</div>';
                }
            }
        }

        function renderWorkoutList(workouts) {
            const list = document.getElementById('workoutList');
            if (!workouts || workouts.length === 0) {
                list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-sec)">Ingen økter funnet</div>';
                return;
            }
            list.innerHTML = workouts.map(w => {
                const segments = w.segment_count || 0;
                const dur = Math.round((w.total_duration_seconds || 0) / 60);
                return `<div class="workout-item" data-id="${w.id}" onclick="selectWorkout(${w.id}, this)">
                    <div class="workout-item-header">
                        <div>
                            <div class="workout-item-name">${escapeHtml(w.name)}</div>
                            <div class="workout-item-meta">${segments} segmenter · ${dur} min</div>
                        </div>
                        <div class="workout-item-badge"></div>
                    </div>
                </div>`;
            }).join('');
            selectedWorkoutId = null;
            document.getElementById('btnLoad').disabled = true;
        }

        function selectWorkout(id, el) {
            document.querySelectorAll('.workout-item').forEach(i => i.classList.remove('selected'));
            el.classList.add('selected');
            el.querySelector('.workout-item-badge').textContent = 'VALGT';
            document.querySelectorAll('.workout-item:not(.selected) .workout-item-badge').forEach(b => b.textContent = '');
            selectedWorkoutId = id;
            document.getElementById('btnLoad').disabled = false;
        }

        // =============================================
        // Actions
        // =============================================
        async function loadWorkout() {
            if (!selectedWorkoutId) return;
            const btn = document.getElementById('btnLoad');
            btn.disabled = true;
            btn.textContent = 'Laster...';
            try {
                await sendCommand('load_workout', { workoutId: selectedWorkoutId });
                // Fetch workout details for the ready screen
                const resp = await fetch(`/api/workouts/${selectedWorkoutId}`);
                loadedWorkoutData = await resp.json();
                showReadyState();
            } catch (e) {
                showToast(e.message || 'Kunne ikke laste økt', 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = 'Last inn økt';
            }
        }

        function showReadyState() {
            const w = loadedWorkoutData;
            document.getElementById('readyName').textContent = w.name;
            const segs = w.segments || [];
            const dur = Math.round(segs.reduce((s, seg) => s + seg.duration_seconds, 0) / 60);
            const speeds = segs.map(s => s.speed_kmh);
            const minSpeed = Math.min(...speeds).toFixed(1);
            const maxSpeed = Math.max(...speeds).toFixed(1);
            document.getElementById('readyMeta').textContent = `${segs.length} segmenter · ${dur} min · ${minSpeed}–${maxSpeed} km/t`;

            // Segment intensity bars
            const maxS = Math.max(...speeds, 1);
            document.getElementById('readyBars').innerHTML = segs.map(seg => {
                const pct = (seg.speed_kmh / maxS) * 100;
                const isHigh = seg.speed_kmh > maxS * 0.7;
                return `<div class="segment-bar" style="height:${pct}%;background:${isHigh ? 'var(--primary)' : 'var(--card-light)'}"></div>`;
            }).join('');

            setState('ready');
        }

        async function startSession() {
            const btn = document.getElementById('btnStart');
            btn.disabled = true;
            btn.textContent = 'Starter...';
            try {
                await sendCommand('start_session');
                // State will transition to 'active' when treadmill_state arrives with sessionActive: true
            } catch (e) {
                showToast(e.message || 'Kunne ikke starte økt', 'error');
                btn.disabled = false;
                btn.textContent = 'Start økt';
            }
        }

        async function stopSession() {
            if (!confirm('Stoppe økten?')) return;
            try {
                await sendCommand('stop_session');
            } catch (e) {
                showToast(e.message || 'Kunne ikke stoppe økt', 'error');
            }
        }

        async function skipSegment() {
            try {
                await sendCommand('skip_segment');
            } catch (e) {
                showToast(e.message || 'Kunne ikke hoppe segment', 'error');
            }
        }

        // Phase 2: BLE controls
        async function bleScan() {
            try {
                const result = await sendCommand('ble_scan');
                console.log('Scan results:', result.payload);
                showToast(`Fant ${result.payload.devices.length} enheter`, 'success');
            } catch (e) { showToast(e.message, 'error'); }
        }

        // =============================================
        // Dashboard rendering (active state)
        // =============================================
        function renderDashboard(data) {
            // Speed
            document.getElementById('vSpeed').textContent =
                data.speed != null ? data.speed.toFixed(1) : '--';
            const st = document.getElementById('vSpeedTarget');
            if (data.targetSpeed != null) { st.textContent = `Mål: ${data.targetSpeed.toFixed(1)}`; st.classList.remove('hidden'); }
            else { st.classList.add('hidden'); }

            // Incline
            document.getElementById('vIncline').textContent =
                data.incline != null ? data.incline.toFixed(1) : '--';
            const it = document.getElementById('vInclineTarget');
            if (data.targetIncline != null) { it.textContent = `Mål: ${data.targetIncline.toFixed(1)}`; it.classList.remove('hidden'); }
            else { it.classList.add('hidden'); }

            // HR
            const hrCard = document.getElementById('hrCard');
            if (data.heartRate && data.heartRate > 0) {
                document.getElementById('vHR').textContent = data.heartRate;
                hrCard.style.display = '';
                const zone = getHRZone(data.heartRate);
                if (zone) {
                    document.getElementById('vHRZone').textContent = zone.name;
                    document.getElementById('vHRZone').style.color = zone.color;
                    hrCard.style.borderColor = zone.color;
                }
            } else { hrCard.style.display = 'none'; }

            // Secondary
            document.getElementById('vDistance').textContent = (data.distance || 0).toFixed(2);
            document.getElementById('vTime').textContent = formatTime(data.elapsedTime || 0);
            document.getElementById('vCalories').textContent = Math.round(data.calories || 0);

            // Workout
            const ws = document.getElementById('workoutSection');
            if (data.workout) { ws.classList.remove('hidden'); renderWorkout(data.workout); }
            else { ws.classList.add('hidden'); }
        }

        function renderWorkout(w) {
            document.getElementById('vWorkoutName').textContent = w.name || '';
            document.getElementById('vSegBadge').textContent = `${(w.currentSegmentIndex || 0) + 1} / ${w.totalSegments || 0}`;

            if (w.currentSegment) {
                document.getElementById('vSegName').textContent = w.currentSegment.name || '';
                document.getElementById('vTargetSpeed').textContent = (w.currentSegment.targetSpeed || 0).toFixed(1);
                document.getElementById('vTargetIncline').textContent = (w.currentSegment.targetIncline || 0).toFixed(1);
                const segDur = w.currentSegment.durationSeconds || 0;
                const segRem = w.currentSegment.timeRemaining || 0;
                const segPct = segDur > 0 ? ((segDur - segRem) / segDur) * 100 : 0;
                document.getElementById('vSegProgress').style.width = Math.min(100, Math.max(0, segPct)) + '%';
                document.getElementById('vSegTimeLeft').textContent = formatTime(segRem) + ' igjen';
            }

            document.getElementById('vOverallProgress').style.width = Math.min(100, Math.max(0, w.overallProgress || 0)) + '%';
            document.getElementById('vOverallPct').textContent = Math.round(w.overallProgress || 0) + '%';
            const remaining = (w.totalDuration || 0) - (w.elapsedInWorkout || 0);
            document.getElementById('vWorkoutRemaining').textContent = formatTime(remaining) + ' igjen';

            const nextSec = document.getElementById('nextSegSection');
            if (w.nextSegment) {
                nextSec.classList.remove('hidden');
                const durMin = Math.round((w.nextSegment.durationSeconds || 0) / 60);
                document.getElementById('vNextInfo').textContent =
                    `${w.nextSegment.name} | ${(w.nextSegment.targetSpeed || 0).toFixed(1)} km/t | ${(w.nextSegment.targetIncline || 0).toFixed(1)}% | ${durMin} min`;
            } else { nextSec.classList.add('hidden'); }
        }

        // =============================================
        // Helpers
        // =============================================
        function getHRZone(hr) {
            if (!hr || hr <= 0) return null;
            const pct = (hr / MAX_HR) * 100;
            if (pct < 60) return { zone: 1, name: 'Sone 1', color: 'var(--zone1)' };
            if (pct < 70) return { zone: 2, name: 'Sone 2', color: 'var(--zone2)' };
            if (pct < 80) return { zone: 3, name: 'Sone 3', color: 'var(--zone3)' };
            if (pct < 90) return { zone: 4, name: 'Sone 4', color: 'var(--zone4)' };
            return { zone: 5, name: 'Sone 5', color: 'var(--zone5)' };
        }

        function formatTime(totalSec) {
            if (!totalSec || totalSec < 0) return '00:00';
            const m = Math.floor(totalSec / 60);
            const s = Math.floor(totalSec % 60);
            return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }

        function escapeHtml(str) {
            const d = document.createElement('div');
            d.textContent = str;
            return d.innerHTML;
        }

        function setServerStatus(status) {
            const dot = document.getElementById('dotServer');
            dot.className = 'dot ' + (status === 'connected' ? 'ok' : status === 'connecting' ? 'warn' : '');
        }

        function startStaleCheck() {
            stopStaleCheck();
            staleCheckTimer = setInterval(() => {
                if (appState === 'active' && Date.now() - lastStateTimestamp > 10000) {
                    // Still in active state but no updates — keep showing last data
                    // but don't revert to idle (user might be between updates)
                }
            }, 5000);
        }
        function stopStaleCheck() { if (staleCheckTimer) { clearInterval(staleCheckTimer); staleCheckTimer = null; } }

        function showToast(msg, type = 'info', duration = 3000) {
            const c = document.getElementById('toastContainer');
            const t = document.createElement('div');
            t.className = 'toast ' + type;
            t.textContent = msg;
            c.appendChild(t);
            setTimeout(() => t.remove(), duration);
        }

        // =============================================
        // Event listeners
        // =============================================
        document.addEventListener('DOMContentLoaded', () => {
            connect();

            document.getElementById('btnLoad').addEventListener('click', loadWorkout);
            document.getElementById('btnStart').addEventListener('click', startSession);
            document.getElementById('btnChange').addEventListener('click', () => {
                setState('idle');
                fetchWorkouts();
            });
            document.getElementById('btnStop').addEventListener('click', stopSession);
            document.getElementById('btnSkip').addEventListener('click', skipSegment);

            // Phase 2 BLE controls
            document.getElementById('btnBleScan').addEventListener('click', bleScan);

            // If no controller info received after 5s, show no-controller message
            setTimeout(() => {
                if (!hasController && appState === 'idle') {
                    document.getElementById('noController').classList.remove('hidden');
                    // Still show workout selector — HTTP API fallback works
                }
            }, 5000);
        });
    </script>
</body>
</html>
```

- [ ] **Step 2: Test view.html in browser**

Open `http://localhost:3000/view.html` and verify:
- Connects to WebSocket
- Shows workout list (via list_workouts command or HTTP fallback)
- Device status dots appear when controller is connected

- [ ] **Step 3: Commit**

```bash
git add public/view.html
git commit -m "feat: rewrite view.html with remote control UI (idle/ready/active states)"
```

---

### Task 5: Integration Test Phase 1

- [ ] **Step 1: Test full Phase 1 flow**

1. Start server: `npm start`
2. Open `https://localhost:3001/` (index.html) in desktop browser
3. Open `http://localhost:3000/view.html` in another browser/tab
4. Verify view.html shows workout list
5. Select a workout in view.html and click "Last inn økt"
6. Verify view.html transitions to Ready state
7. Verify index.html shows the workout as loaded
8. (If treadmill available) Click "Start økt" in view.html and verify session starts

- [ ] **Step 2: Deploy to RPi and test**

```bash
scp server.js docker-compose.yml pi@192.168.1.12:~/treadmill-controller/
scp public/view.html public/app.js pi@192.168.1.12:~/treadmill-controller/public/
ssh pi@192.168.1.12 "cd ~/treadmill-controller && docker compose build && docker rm -f treadmill-controller 2>/dev/null; docker compose up -d"
```

Test from iPhone: open `http://192.168.1.12:3000/view.html`

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: Phase 1 integration fixes"
```

---

## Phase 2: Native BLE Service on RPi

### Task 6: Create ble-service project structure

**Files:**
- Create: `ble-service/package.json`
- Create: `ble-service/ble-config.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "treadmill-ble-service",
  "version": "1.0.0",
  "description": "Native BLE service for treadmill FTMS and heart rate monitor",
  "main": "ble-service.js",
  "scripts": {
    "start": "node ble-service.js"
  },
  "dependencies": {
    "@abandonware/noble": "^1.9.2-26",
    "ws": "^8.19.0"
  }
}
```

- [ ] **Step 2: Create default ble-config.json**

```json
{
  "treadmill": {
    "address": null,
    "name": null
  },
  "hrm": {
    "address": null,
    "name": null
  },
  "autoConnect": true,
  "serverUrl": "ws://localhost:3000"
}
```

- [ ] **Step 3: Commit**

```bash
git add ble-service/package.json ble-service/ble-config.json
git commit -m "feat: create ble-service project structure"
```

---

### Task 7: Port FTMS protocol to noble (ftms-native.js)

**Files:**
- Create: `ble-service/ftms-native.js`

- [ ] **Step 1: Create ftms-native.js**

Port the Web Bluetooth FTMS logic from `public/ftms.js` to use `@abandonware/noble`. Key differences:
- noble uses `peripheral.connect()` instead of `navigator.bluetooth.requestDevice()`
- Characteristics are accessed via `service.discoverCharacteristics()` instead of `service.getCharacteristic()`
- Notifications use `characteristic.on('data', callback)` instead of event listeners
- Buffer handling uses Node.js Buffer instead of DataView

```javascript
const noble = require('@abandonware/noble');
const EventEmitter = require('events');

const FTMS_SERVICE_UUID = '1826';
const TREADMILL_DATA_UUID = '2acd';
const CONTROL_POINT_UUID = '2ad9';
const STATUS_UUID = '2ada';

class FtmsNative extends EventEmitter {
  constructor() {
    super();
    this.peripheral = null;
    this.controlPoint = null;
    this.lastWriteTime = 0;
    this.minCommandInterval = 400;
    this.lastReportedSpeed = null;
    this.lastReportedIncline = null;
    this._expectingSpeedConfirm = false;
    this._expectingInclineConfirm = false;
    this.pendingSpeedConfirm = null;
    this.pendingInclineConfirm = null;
  }

  async connectToPeripheral(peripheral) {
    this.peripheral = peripheral;

    await new Promise((resolve, reject) => {
      peripheral.connect((err) => {
        if (err) reject(err); else resolve();
      });
    });

    console.log(`Connected to ${peripheral.advertisement.localName || peripheral.id}`);

    const { services, characteristics } = await new Promise((resolve, reject) => {
      peripheral.discoverSomeServicesAndCharacteristics(
        [FTMS_SERVICE_UUID],
        [TREADMILL_DATA_UUID, CONTROL_POINT_UUID, STATUS_UUID],
        (err, services, characteristics) => {
          if (err) reject(err); else resolve({ services, characteristics });
        }
      );
    });

    for (const char of characteristics) {
      const uuid = char.uuid.replace(/-/g, '');
      if (uuid.includes(TREADMILL_DATA_UUID)) {
        char.on('data', (data) => this.handleTreadmillData(data));
        await new Promise((resolve, reject) => {
          char.subscribe((err) => { if (err) reject(err); else resolve(); });
        });
        console.log('Subscribed to Treadmill Data');
      } else if (uuid.includes(CONTROL_POINT_UUID)) {
        this.controlPoint = char;
        console.log('Found Control Point');
      } else if (uuid.includes(STATUS_UUID)) {
        char.on('data', (data) => this.handleStatusChange(data));
        await new Promise((resolve, reject) => {
          char.subscribe((err) => { if (err) reject(err); else resolve(); });
        });
        console.log('Subscribed to Machine Status');
      }
    }

    peripheral.once('disconnect', () => {
      console.log('Treadmill disconnected');
      this.peripheral = null;
      this.controlPoint = null;
      this.emit('disconnect');
    });

    return true;
  }

  handleTreadmillData(buffer) {
    const data = this.parseTreadmillData(buffer);
    if (data.speed_kmh !== undefined) this.lastReportedSpeed = data.speed_kmh;
    if (data.incline_percent !== undefined) this.lastReportedIncline = data.incline_percent;
    this.emit('data', data);
  }

  parseTreadmillData(buffer) {
    const flags = buffer.readUInt16LE(0);
    let offset = 2;
    const data = {};

    if (flags & 0x01) { offset += 1; }

    // Instantaneous Speed
    if (offset + 1 < buffer.length) {
      data.speed_kmh = buffer.readUInt16LE(offset) / 100;
      offset += 2;
    }

    // Average Speed
    if ((flags & 0x02) && offset + 1 < buffer.length) {
      data.avg_speed_kmh = buffer.readUInt16LE(offset) / 100;
      offset += 2;
    }

    // Total Distance (3 bytes)
    if ((flags & 0x04) && offset + 2 < buffer.length) {
      data.total_distance_m = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
      offset += 3;
    }

    // Inclination
    if ((flags & 0x08) && offset + 1 < buffer.length) {
      data.incline_percent = buffer.readInt16LE(offset) / 10;
      offset += 2;
    }

    // Ramp Angle
    if ((flags & 0x10) && offset + 1 < buffer.length) {
      offset += 2;
    }

    // Positive Elevation Gain
    if ((flags & 0x20) && offset + 1 < buffer.length) {
      offset += 2;
    }

    // Instantaneous Pace
    if ((flags & 0x40) && offset < buffer.length) {
      offset += 1;
    }

    // Average Pace
    if ((flags & 0x80) && offset < buffer.length) {
      offset += 1;
    }

    // Total Energy
    if ((flags & 0x100) && offset + 1 < buffer.length) {
      data.total_energy_kcal = buffer.readUInt16LE(offset) / 1000;
      offset += 2;
      if (offset + 1 < buffer.length) { offset += 2; } // energy/hour
      if (offset < buffer.length) { offset += 1; } // energy/min
    }

    // Metabolic Equivalent
    if ((flags & 0x200) && offset < buffer.length) {
      offset += 1;
    }

    // Heart Rate
    if ((flags & 0x400) && offset < buffer.length) {
      data.heart_rate = buffer.readUInt8(offset);
      offset += 1;
    }

    // Elapsed Time
    if ((flags & 0x800) && offset + 1 < buffer.length) {
      data.elapsed_time_s = buffer.readUInt16LE(offset);
      offset += 2;
    }

    // Remaining Time
    if ((flags & 0x1000) && offset + 1 < buffer.length) {
      data.remaining_time_s = buffer.readUInt16LE(offset);
      offset += 2;
    }

    return data;
  }

  handleStatusChange(buffer) {
    const statusCode = buffer.readUInt8(0);
    let isAppInitiated = false;

    if (statusCode === 0x0A && this.pendingSpeedConfirm) {
      clearTimeout(this.pendingSpeedConfirm.timeoutId);
      this.pendingSpeedConfirm.resolve(true);
      this.pendingSpeedConfirm = null;
      isAppInitiated = true;
    }
    if (statusCode === 0x0B && this.pendingInclineConfirm) {
      clearTimeout(this.pendingInclineConfirm.timeoutId);
      this.pendingInclineConfirm.resolve(true);
      this.pendingInclineConfirm = null;
      isAppInitiated = true;
    }
    if (statusCode === 0x0A && this._expectingSpeedConfirm) {
      isAppInitiated = true;
      this._expectingSpeedConfirm = false;
    }
    if (statusCode === 0x0B && this._expectingInclineConfirm) {
      isAppInitiated = true;
      this._expectingInclineConfirm = false;
    }

    this.emit('status', statusCode, isAppInitiated);
  }

  async _ensureCommandGap() {
    const now = Date.now();
    const elapsed = now - this.lastWriteTime;
    if (elapsed < this.minCommandInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minCommandInterval - elapsed));
    }
  }

  async setSpeed(speedKmh) {
    if (!this.controlPoint) throw new Error('Not connected');
    await this._ensureCommandGap();
    this._expectingSpeedConfirm = true;
    setTimeout(() => { this._expectingSpeedConfirm = false; }, 3000);

    const buf = Buffer.alloc(3);
    buf.writeUInt8(0x02, 0);
    buf.writeUInt16LE(Math.round(speedKmh * 100), 1);
    await this._writeControlPoint(buf);
    console.log(`Set speed to ${speedKmh} km/h`);
  }

  async setSpeedAndConfirm(speedKmh, timeoutMs = 3000) {
    if (this.pendingSpeedConfirm) {
      clearTimeout(this.pendingSpeedConfirm.timeoutId);
      this.pendingSpeedConfirm.resolve(false);
    }
    const confirmPromise = new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingSpeedConfirm = null;
        resolve(false);
      }, timeoutMs);
      this.pendingSpeedConfirm = { resolve, timeoutId };
    });
    await this.setSpeed(speedKmh);
    return confirmPromise;
  }

  async setIncline(inclinePercent) {
    if (!this.controlPoint) throw new Error('Not connected');
    await this._ensureCommandGap();
    this._expectingInclineConfirm = true;
    setTimeout(() => { this._expectingInclineConfirm = false; }, 3000);

    const buf = Buffer.alloc(3);
    buf.writeUInt8(0x03, 0);
    buf.writeInt16LE(Math.round(inclinePercent * 10), 1);
    await this._writeControlPoint(buf);
    console.log(`Set incline to ${inclinePercent}%`);
  }

  async setInclineAndConfirm(inclinePercent, timeoutMs = 3000) {
    if (this.pendingInclineConfirm) {
      clearTimeout(this.pendingInclineConfirm.timeoutId);
      this.pendingInclineConfirm.resolve(false);
    }
    const confirmPromise = new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingInclineConfirm = null;
        resolve(false);
      }, timeoutMs);
      this.pendingInclineConfirm = { resolve, timeoutId };
    });
    await this.setIncline(inclinePercent);
    return confirmPromise;
  }

  async start() {
    if (!this.controlPoint) throw new Error('Not connected');
    await this._ensureCommandGap();
    const buf = Buffer.alloc(1);
    buf.writeUInt8(0x07, 0);
    await this._writeControlPoint(buf);
    console.log('Started treadmill');
  }

  async stop() {
    if (!this.controlPoint) throw new Error('Not connected');
    await this._ensureCommandGap();
    const buf = Buffer.alloc(2);
    buf.writeUInt8(0x08, 0);
    buf.writeUInt8(0x01, 1);
    await this._writeControlPoint(buf);
    console.log('Stopped treadmill');
  }

  async _writeControlPoint(buffer) {
    return new Promise((resolve, reject) => {
      this.controlPoint.write(buffer, false, (err) => {
        this.lastWriteTime = Date.now();
        if (err) reject(err); else resolve();
      });
    });
  }

  isConnected() {
    return this.peripheral && this.peripheral.state === 'connected';
  }

  disconnect() {
    if (this.pendingSpeedConfirm) { clearTimeout(this.pendingSpeedConfirm.timeoutId); this.pendingSpeedConfirm = null; }
    if (this.pendingInclineConfirm) { clearTimeout(this.pendingInclineConfirm.timeoutId); this.pendingInclineConfirm = null; }
    if (this.peripheral) {
      this.peripheral.disconnect();
    }
  }

  getLastReportedSpeed() { return this.lastReportedSpeed; }
  getLastReportedIncline() { return this.lastReportedIncline; }
}

module.exports = FtmsNative;
```

- [ ] **Step 2: Commit**

```bash
git add ble-service/ftms-native.js
git commit -m "feat: port FTMS protocol to noble (ftms-native.js)"
```

---

### Task 8: Port HRM protocol to noble (hrm-native.js)

**Files:**
- Create: `ble-service/hrm-native.js`

- [ ] **Step 1: Create hrm-native.js**

```javascript
const EventEmitter = require('events');

const HR_SERVICE_UUID = '180d';
const HR_MEASUREMENT_UUID = '2a37';

class HrmNative extends EventEmitter {
  constructor() {
    super();
    this.peripheral = null;
    this.currentHeartRate = null;
  }

  async connectToPeripheral(peripheral) {
    this.peripheral = peripheral;

    await new Promise((resolve, reject) => {
      peripheral.connect((err) => {
        if (err) reject(err); else resolve();
      });
    });

    console.log(`HRM connected to ${peripheral.advertisement.localName || peripheral.id}`);

    const { characteristics } = await new Promise((resolve, reject) => {
      peripheral.discoverSomeServicesAndCharacteristics(
        [HR_SERVICE_UUID],
        [HR_MEASUREMENT_UUID],
        (err, services, characteristics) => {
          if (err) reject(err); else resolve({ characteristics });
        }
      );
    });

    for (const char of characteristics) {
      if (char.uuid.includes(HR_MEASUREMENT_UUID)) {
        char.on('data', (data) => this.handleHeartRate(data));
        await new Promise((resolve, reject) => {
          char.subscribe((err) => { if (err) reject(err); else resolve(); });
        });
        console.log('Subscribed to Heart Rate Measurement');
      }
    }

    peripheral.once('disconnect', () => {
      console.log('HRM disconnected');
      this.peripheral = null;
      this.currentHeartRate = null;
      this.emit('disconnect');
      this.emit('heartRate', null);
    });

    return true;
  }

  handleHeartRate(buffer) {
    const flags = buffer.readUInt8(0);
    const rate16Bits = flags & 0x01;
    let heartRate;
    let offset = 1;

    if (rate16Bits) {
      heartRate = buffer.readUInt16LE(offset);
    } else {
      heartRate = buffer.readUInt8(offset);
    }

    // Check sensor contact
    const contactSupported = (flags & 0x04) !== 0;
    const contactGood = (flags & 0x02) !== 0;
    if (contactSupported && !contactGood) {
      heartRate = null;
    }

    this.currentHeartRate = heartRate;
    this.emit('heartRate', heartRate);
  }

  isConnected() {
    return this.peripheral && this.peripheral.state === 'connected';
  }

  disconnect() {
    if (this.peripheral) {
      this.peripheral.disconnect();
    }
    this.currentHeartRate = null;
  }

  getCurrentHeartRate() { return this.currentHeartRate; }
}

module.exports = HrmNative;
```

- [ ] **Step 2: Commit**

```bash
git add ble-service/hrm-native.js
git commit -m "feat: port HRM protocol to noble (hrm-native.js)"
```

---

### Task 9: Create ble-service.js (main service with session management)

**Files:**
- Create: `ble-service/ble-service.js`

- [ ] **Step 1: Create ble-service.js**

This is the main entry point. It:
- Scans for and connects to BLE devices using noble
- Manages the WebSocket connection to server.js
- Handles remote commands (load/start/stop/skip)
- Runs workout segment execution (ported from app.js)
- Records and buffers session data to the server via HTTP

```javascript
const noble = require('@abandonware/noble');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const FtmsNative = require('./ftms-native');
const HrmNative = require('./hrm-native');

// =============================================
// Configuration
// =============================================
const CONFIG_PATH = path.join(__dirname, 'ble-config.json');
let config = {
  treadmill: { address: null, name: null },
  hrm: { address: null, name: null },
  autoConnect: true,
  serverUrl: 'ws://localhost:3000'
};

try {
  config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
} catch (e) {
  console.log('No ble-config.json found, using defaults');
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// =============================================
// BLE Instances
// =============================================
const ftms = new FtmsNative();
const hrm = new HrmNative();

// =============================================
// Session state (mirrors app.js logic)
// =============================================
let currentSession = null;
let currentWorkout = null;
let loadedWorkout = null;
let currentSegmentIndex = 0;
let segmentTimeRemaining = 0;
let workoutTimer = null;
let localElapsedTime = 0;
let localTimeTimer = null;
let currentTargetSpeed = null;
let currentTargetIncline = null;
let driftCheckTimer = null;

let sessionData = { distance: 0, time: 0, heartRates: [], calories: 0 };
let dataBuffer = [];
let isFlushingBuffer = false;
let consecutiveFailures = 0;

let treadmillHeartRate = null;
let hrmHeartRate = null;

// =============================================
// WebSocket to server
// =============================================
let ws = null;
let wsReconnectTimer = null;

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  console.log(`Connecting to server at ${config.serverUrl}...`);
  try { ws = new WebSocket(config.serverUrl); } catch (e) { scheduleWsReconnect(); return; }

  ws.on('open', () => {
    console.log('Connected to server');
    ws.send(JSON.stringify({ type: 'register', role: 'controller', bleBackend: 'native' }));
    broadcastDeviceStatus();
    startStateBroadcast();
  });

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'remote_command') handleRemoteCommand(data);
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log('Server connection lost');
    ws = null;
    stopStateBroadcast();
    scheduleWsReconnect();
  });

  ws.on('error', () => { if (ws) ws.close(); });
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocket();
  }, 3000);
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// =============================================
// State broadcast (same as app.js)
// =============================================
let stateBroadcastTimer = null;

function startStateBroadcast() {
  if (stateBroadcastTimer) return;
  stateBroadcastTimer = setInterval(() => {
    wsSend(buildCurrentState());
  }, 2000);
  wsSend(buildCurrentState());
}

function stopStateBroadcast() {
  if (stateBroadcastTimer) { clearInterval(stateBroadcastTimer); stateBroadcastTimer = null; }
}

function buildCurrentState() {
  let hr = hrmHeartRate || treadmillHeartRate || null;

  let workoutInfo = null;
  if (currentWorkout && currentWorkout.segments) {
    const segments = currentWorkout.segments;
    const totalDuration = segments.reduce((sum, s) => sum + s.duration_seconds, 0);
    const currentSeg = segments[currentSegmentIndex];
    const elapsedSegments = segments.slice(0, currentSegmentIndex).reduce((sum, s) => sum + s.duration_seconds, 0);
    const elapsedInCurrent = currentSeg ? currentSeg.duration_seconds - segmentTimeRemaining : 0;
    const elapsedInWorkout = elapsedSegments + elapsedInCurrent;

    workoutInfo = {
      name: currentWorkout.name,
      totalSegments: segments.length,
      currentSegmentIndex,
      currentSegment: currentSeg ? {
        name: currentSeg.segment_name || `Segment ${currentSegmentIndex + 1}`,
        targetSpeed: currentSeg.speed_kmh,
        targetIncline: currentSeg.incline_percent,
        durationSeconds: currentSeg.duration_seconds,
        timeRemaining: segmentTimeRemaining
      } : null,
      nextSegment: segments[currentSegmentIndex + 1] ? {
        name: segments[currentSegmentIndex + 1].segment_name || `Segment ${currentSegmentIndex + 2}`,
        targetSpeed: segments[currentSegmentIndex + 1].speed_kmh,
        targetIncline: segments[currentSegmentIndex + 1].incline_percent,
        durationSeconds: segments[currentSegmentIndex + 1].duration_seconds
      } : null,
      totalDuration,
      elapsedInWorkout,
      overallProgress: totalDuration > 0 ? (elapsedInWorkout / totalDuration) * 100 : 0
    };
  }

  return {
    type: 'treadmill_state',
    timestamp: Date.now(),
    sessionActive: !!currentSession,
    speed: ftms.getLastReportedSpeed(),
    incline: ftms.getLastReportedIncline(),
    heartRate: hr,
    heartRateSource: hrmHeartRate ? 'hrm' : treadmillHeartRate ? 'treadmill' : 'none',
    distance: sessionData.distance,
    elapsedTime: localElapsedTime,
    calories: sessionData.calories,
    targetSpeed: currentTargetSpeed,
    targetIncline: currentTargetIncline,
    workout: workoutInfo
  };
}

function broadcastDeviceStatus() {
  wsSend({
    type: 'device_status',
    treadmill: ftms.isConnected() ? 'connected' : 'disconnected',
    hrm: hrm.isConnected() ? 'connected' : 'disconnected',
    bleBackend: 'native'
  });
}

// =============================================
// Remote command handler
// =============================================
async function handleRemoteCommand(data) {
  const { id, action, payload } = data;
  console.log(`Remote command: ${action}`, payload || '');

  try {
    switch (action) {
      case 'load_workout': {
        const resp = await fetch(`http://localhost:3000/api/workouts/${payload.workoutId}`);
        if (!resp.ok) throw new Error('Workout not found');
        loadedWorkout = await resp.json();
        sendResult(id, action, true);
        break;
      }
      case 'start_session': {
        if (!loadedWorkout) { sendResult(id, action, false, 'No workout loaded'); return; }
        if (!ftms.isConnected()) { sendResult(id, action, false, 'Treadmill not connected'); return; }
        currentWorkout = loadedWorkout;
        currentSegmentIndex = 0;
        await startSession(loadedWorkout.id);
        startLocalTimer();
        await executeSegment(0);
        loadedWorkout = null;
        sendResult(id, action, true);
        break;
      }
      case 'stop_session': {
        if (!currentSession) { sendResult(id, action, false, 'No active session'); return; }
        await stopWorkout();
        sendResult(id, action, true);
        break;
      }
      case 'skip_segment': {
        if (!currentWorkout || !currentSession) { sendResult(id, action, false, 'No active workout'); return; }
        if (workoutTimer) clearInterval(workoutTimer);
        await executeSegment(currentSegmentIndex + 1);
        sendResult(id, action, true);
        break;
      }
      case 'ble_scan': {
        const devices = await scanForDevices(10000);
        sendResult(id, action, true, null, { devices });
        break;
      }
      case 'ble_connect': {
        await connectDevice(payload.device, payload.address);
        sendResult(id, action, true);
        break;
      }
      case 'ble_disconnect': {
        if (payload.device === 'treadmill') ftms.disconnect();
        else if (payload.device === 'hrm') hrm.disconnect();
        broadcastDeviceStatus();
        sendResult(id, action, true);
        break;
      }
      case 'ble_reconnect': {
        await connectDevice(payload.device);
        sendResult(id, action, true);
        break;
      }
      default:
        sendResult(id, action, false, `Unknown action: ${action}`);
    }
  } catch (error) {
    console.error(`Command ${action} failed:`, error.message);
    sendResult(id, action, false, error.message);
  }
}

function sendResult(id, action, success, error = null, payload = null) {
  const result = { type: 'command_result', id, action, success };
  if (error) result.error = error;
  if (payload) result.payload = payload;
  wsSend(result);
}

// =============================================
// Session management (mirrors app.js)
// =============================================
async function startSession(workoutId) {
  const resp = await fetch('http://localhost:3000/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workout_id: workoutId,
      heart_rate_source: hrmHeartRate ? 'hrm' : 'treadmill'
    })
  });
  const data = await resp.json();
  currentSession = data.id;
  sessionData = { distance: 0, time: 0, heartRates: [], calories: 0 };
  dataBuffer = [];
  consecutiveFailures = 0;
  console.log(`Session ${currentSession} started`);
}

async function endSession() {
  if (!currentSession) return;
  try { await flushDataBuffer(); } catch (e) { console.warn('Buffer flush failed:', e.message); }

  try {
    const statsResp = await fetch(`http://localhost:3000/api/sessions/${currentSession}/stats`);
    const stats = await statsResp.json();
    const avgHR = stats.avg_heart_rate || (sessionData.heartRates.length > 0
      ? Math.round(sessionData.heartRates.reduce((a, b) => a + b, 0) / sessionData.heartRates.length)
      : null);

    await fetch(`http://localhost:3000/api/sessions/${currentSession}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        total_distance_km: stats.max_distance || sessionData.distance,
        total_time_seconds: stats.total_seconds || localElapsedTime,
        avg_heart_rate: avgHR,
        calories_burned: stats.max_calories || sessionData.calories
      })
    });
    console.log(`Session ${currentSession} ended`);
  } catch (e) { console.error('End session error:', e.message); }

  currentSession = null;
  // Broadcast final inactive state
  wsSend({ type: 'treadmill_state', timestamp: Date.now(), sessionActive: false });
}

async function stopWorkout() {
  if (workoutTimer) { clearInterval(workoutTimer); workoutTimer = null; }
  if (driftCheckTimer) { clearInterval(driftCheckTimer); driftCheckTimer = null; }
  stopLocalTimer();
  try { await ftms.stop(); } catch (e) { console.warn('Failed to stop treadmill:', e.message); }
  currentWorkout = null;
  currentSegmentIndex = 0;
  currentTargetSpeed = null;
  currentTargetIncline = null;
  await endSession();
}

// =============================================
// Segment execution (mirrors app.js)
// =============================================
async function executeSegment(index) {
  if (!currentWorkout || index >= currentWorkout.segments.length) {
    console.log('Workout complete!');
    try { await ftms.stop(); } catch (e) {}
    await stopWorkout();
    return;
  }

  const segment = currentWorkout.segments[index];
  currentSegmentIndex = index;

  try {
    if (index === 0) {
      await ftms.start();
      await new Promise(r => setTimeout(r, 500));
    }

    currentTargetSpeed = segment.speed_kmh;
    currentTargetIncline = segment.incline_percent;

    await ftms.setSpeedAndConfirm(segment.speed_kmh);
    await ftms.setInclineAndConfirm(segment.incline_percent);

    startDriftDetection();
  } catch (error) {
    console.error('Error setting treadmill parameters:', error.message);
  }

  segmentTimeRemaining = segment.duration_seconds;

  if (workoutTimer) clearInterval(workoutTimer);
  workoutTimer = setInterval(async () => {
    if (!ftms.isConnected()) {
      clearInterval(workoutTimer); workoutTimer = null;
      console.warn('Treadmill disconnected during workout');
      return;
    }
    segmentTimeRemaining--;
    if (segmentTimeRemaining <= 0) {
      clearInterval(workoutTimer);
      await executeSegment(index + 1);
    }
  }, 1000);
}

// =============================================
// Drift detection (mirrors app.js)
// =============================================
function startDriftDetection() {
  if (driftCheckTimer) clearInterval(driftCheckTimer);
  driftCheckTimer = setInterval(async () => {
    if (!ftms.isConnected() || !currentTargetSpeed) return;
    const actualSpeed = ftms.getLastReportedSpeed();
    const actualIncline = ftms.getLastReportedIncline();

    if (actualSpeed !== null && Math.abs(actualSpeed - currentTargetSpeed) > 0.3) {
      console.log(`Speed drift: actual=${actualSpeed}, target=${currentTargetSpeed}`);
      try { await ftms.setSpeed(currentTargetSpeed); } catch (e) {}
    }
    if (actualIncline !== null && Math.abs(actualIncline - currentTargetIncline) > 0.5) {
      console.log(`Incline drift: actual=${actualIncline}, target=${currentTargetIncline}`);
      try { await ftms.setIncline(currentTargetIncline); } catch (e) {}
    }
  }, 8000);
}

// =============================================
// Local timer
// =============================================
function startLocalTimer() {
  localElapsedTime = 0;
  if (localTimeTimer) clearInterval(localTimeTimer);
  localTimeTimer = setInterval(() => { localElapsedTime++; }, 1000);
}

function stopLocalTimer() {
  if (localTimeTimer) { clearInterval(localTimeTimer); localTimeTimer = null; }
}

// =============================================
// Data recording (mirrors app.js)
// =============================================
function recordSessionData(data) {
  if (!currentSession) return;
  const hr = hrmHeartRate || data.heart_rate || null;
  if (hr && hr > 0 && hr < 255) sessionData.heartRates.push(hr);
  if (data.total_distance_m) sessionData.distance = data.total_distance_m / 1000;
  if (data.total_energy_kcal) sessionData.calories = Math.round(data.total_energy_kcal);
  sessionData.time = localElapsedTime;

  dataBuffer.push({
    speed_kmh: data.speed_kmh || 0,
    incline_percent: data.incline_percent || 0,
    distance_km: sessionData.distance,
    heart_rate: hr,
    calories: sessionData.calories,
    segment_index: currentSegmentIndex
  });

  if (dataBuffer.length >= 5) flushDataBuffer().catch(() => {});
}

async function flushDataBuffer() {
  if (isFlushingBuffer || dataBuffer.length === 0) return;
  isFlushingBuffer = true;
  try {
    while (dataBuffer.length > 0) {
      const item = dataBuffer[0];
      const resp = await fetch(`http://localhost:3000/api/sessions/${currentSession}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      dataBuffer.shift();
      consecutiveFailures = 0;
    }
  } catch (e) {
    consecutiveFailures++;
    if (consecutiveFailures >= 5) console.error('Too many consecutive flush failures');
  } finally {
    isFlushingBuffer = false;
  }
}

// =============================================
// BLE Scanning & Connecting
// =============================================
async function scanForDevices(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const found = [];
    const onDiscover = (peripheral) => {
      const name = peripheral.advertisement.localName;
      const services = peripheral.advertisement.serviceUuids || [];
      if (name || services.length > 0) {
        found.push({
          name: name || 'Unknown',
          address: peripheral.address,
          rssi: peripheral.rssi,
          services: services
        });
      }
    };

    noble.on('discover', onDiscover);
    noble.startScanning([], false);
    setTimeout(() => {
      noble.stopScanning();
      noble.removeListener('discover', onDiscover);
      resolve(found);
    }, timeoutMs);
  });
}

async function connectDevice(type, address = null) {
  const addr = address || (type === 'treadmill' ? config.treadmill.address : config.hrm.address);
  if (!addr) throw new Error(`No address configured for ${type}`);

  console.log(`Scanning for ${type} at ${addr}...`);

  const peripheral = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      noble.stopScanning();
      noble.removeListener('discover', onDiscover);
      reject(new Error(`Device ${addr} not found`));
    }, 15000);

    const onDiscover = (p) => {
      if (p.address === addr || (p.advertisement.localName && p.advertisement.localName === addr)) {
        clearTimeout(timeout);
        noble.stopScanning();
        noble.removeListener('discover', onDiscover);
        resolve(p);
      }
    };

    noble.on('discover', onDiscover);
    noble.startScanning([], false);
  });

  if (type === 'treadmill') {
    await ftms.connectToPeripheral(peripheral);
    config.treadmill.address = peripheral.address;
    config.treadmill.name = peripheral.advertisement.localName;
    saveConfig();
  } else {
    await hrm.connectToPeripheral(peripheral);
    config.hrm.address = peripheral.address;
    config.hrm.name = peripheral.advertisement.localName;
    saveConfig();
  }

  broadcastDeviceStatus();
}

// =============================================
// BLE event handlers
// =============================================
ftms.on('data', (data) => {
  if (data.heart_rate && data.heart_rate > 0 && data.heart_rate < 255) {
    treadmillHeartRate = data.heart_rate;
  }
  recordSessionData(data);
});

ftms.on('status', (code, isAppInitiated) => {
  if (code === 0x04) { // Started
    console.log('Treadmill started (physical button)');
    if (loadedWorkout && !currentSession) {
      // Auto-start loaded workout when physical start pressed
      handleRemoteCommand({ id: 'physical-start', action: 'start_session' });
    }
  } else if (code === 0x02 && currentSession) { // Stopped
    console.log('Treadmill stopped (physical button)');
    stopWorkout();
  }
});

ftms.on('disconnect', () => {
  broadcastDeviceStatus();
  // Auto-reconnect
  if (config.treadmill.address) {
    setTimeout(() => {
      if (!ftms.isConnected()) {
        console.log('Attempting treadmill reconnect...');
        connectDevice('treadmill').catch(e => console.error('Reconnect failed:', e.message));
      }
    }, 5000);
  }
});

hrm.on('heartRate', (hr) => { hrmHeartRate = hr; });

hrm.on('disconnect', () => {
  hrmHeartRate = null;
  broadcastDeviceStatus();
  if (config.hrm.address) {
    setTimeout(() => {
      if (!hrm.isConnected()) {
        console.log('Attempting HRM reconnect...');
        connectDevice('hrm').catch(e => console.error('HRM reconnect failed:', e.message));
      }
    }, 5000);
  }
});

// =============================================
// Startup
// =============================================
console.log('Treadmill BLE Service starting...');

noble.on('stateChange', (state) => {
  console.log(`Bluetooth adapter state: ${state}`);
  if (state === 'poweredOn') {
    connectWebSocket();
    if (config.autoConnect) {
      if (config.treadmill.address) {
        console.log(`Auto-connecting treadmill: ${config.treadmill.name || config.treadmill.address}`);
        connectDevice('treadmill').catch(e => console.error('Auto-connect treadmill failed:', e.message));
      }
      if (config.hrm.address) {
        console.log(`Auto-connecting HRM: ${config.hrm.name || config.hrm.address}`);
        connectDevice('hrm').catch(e => console.error('Auto-connect HRM failed:', e.message));
      }
    }
  }
});

// Keep alive
process.on('SIGINT', () => {
  console.log('Shutting down...');
  ftms.disconnect();
  hrm.disconnect();
  if (ws) ws.close();
  process.exit(0);
});
```

- [ ] **Step 2: Commit**

```bash
git add ble-service/ble-service.js
git commit -m "feat: create ble-service.js with session management and BLE device control"
```

---

### Task 10: Create systemd service and install script

**Files:**
- Create: `ble-service/treadmill-ble.service`
- Create: `ble-service/install.sh`

- [ ] **Step 1: Create systemd unit file**

```ini
[Unit]
Description=Treadmill BLE Service
After=bluetooth.target network.target
Wants=bluetooth.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/pi/treadmill-controller/ble-service
ExecStartPre=/bin/bash -c 'rfkill unblock bluetooth; sleep 1; bluetoothctl power on'
ExecStart=/usr/bin/node ble-service.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Create install script**

```bash
#!/bin/bash
set -e

echo "=== Treadmill BLE Service Installer ==="

# Check we're on the Pi
if [ ! -f /proc/device-tree/model ]; then
    echo "Warning: This doesn't look like a Raspberry Pi"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Install Node.js dependencies
echo "Installing dependencies..."
npm install --production

# Enable Bluetooth
echo "Enabling Bluetooth..."
sudo rfkill unblock bluetooth
sudo systemctl enable bluetooth
sudo systemctl start bluetooth

# Wait for Bluetooth to be ready
sleep 2
sudo bluetoothctl power on || true

# Install systemd service
echo "Installing systemd service..."
sudo cp treadmill-ble.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable treadmill-ble
sudo systemctl start treadmill-ble

echo ""
echo "=== Done! ==="
echo "Service status: sudo systemctl status treadmill-ble"
echo "View logs: sudo journalctl -u treadmill-ble -f"
echo ""
echo "To configure devices, edit ble-config.json or use the scan feature from view.html"
```

- [ ] **Step 3: Make install.sh executable**

```bash
chmod +x ble-service/install.sh
```

- [ ] **Step 4: Commit**

```bash
git add ble-service/treadmill-ble.service ble-service/install.sh
git commit -m "feat: add systemd service and install script for BLE service"
```

---

### Task 11: Update CLAUDE.md and deploy scripts

**Files:**
- Modify: `CLAUDE.md`
- Modify: `deploy-to-pi.sh` (if exists) or document deploy steps

- [ ] **Step 1: Update CLAUDE.md with new architecture info**

Add to the Architecture section:

```markdown
**BLE Service** (Phase 2): Separate Node.js process on RPi host (not Docker). Uses `@abandonware/noble` for BLE. Files in `ble-service/`. Runs as systemd service (`treadmill-ble.service`). Connects to server via WebSocket on `ws://localhost:3000`.

**Dual HTTP/HTTPS**: server.js listens on HTTP (port 3000) and HTTPS (port 3001, if certs exist). view.html uses HTTP to avoid cert warnings on iOS. index.html uses HTTPS for Web Bluetooth.

**WebSocket Hub**: server.js routes commands between viewer clients (view.html) and the active controller (index.html browser or native BLE service). Controllers register with `{ type: "register", role: "controller" }`. Native BLE service takes priority over browser controllers.
```

Add to Commands section:

```markdown
# BLE Service (on RPi, outside Docker)
cd ~/treadmill-controller/ble-service && npm install
sudo systemctl start treadmill-ble    # Start BLE service
sudo systemctl status treadmill-ble   # Check status
sudo journalctl -u treadmill-ble -f   # View logs
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with BLE service and dual-serve architecture"
```

---

### Task 12: Deploy and test on RPi

- [ ] **Step 1: Deploy Phase 1 files to RPi**

```bash
scp server.js docker-compose.yml pi@192.168.1.12:~/treadmill-controller/
scp public/view.html public/app.js pi@192.168.1.12:~/treadmill-controller/public/
ssh pi@192.168.1.12 "cd ~/treadmill-controller && docker compose build && docker rm -f treadmill-controller 2>/dev/null; docker compose up -d"
```

- [ ] **Step 2: Deploy Phase 2 BLE service to RPi**

```bash
scp -r ble-service pi@192.168.1.12:~/treadmill-controller/
ssh pi@192.168.1.12 "cd ~/treadmill-controller/ble-service && bash install.sh"
```

- [ ] **Step 3: Verify BLE service starts**

```bash
ssh pi@192.168.1.12 "sudo systemctl status treadmill-ble"
ssh pi@192.168.1.12 "sudo journalctl -u treadmill-ble --no-pager -n 20"
```

- [ ] **Step 4: Test from phone**

Open `http://192.168.1.12:3000/view.html` on iPhone/iPad.
Verify: workout list loads, device status shows, can load and interact.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: deployment and integration fixes"
```
