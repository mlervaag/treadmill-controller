#!/usr/bin/env node
// Native BLE Service for Treadmill Controller
// Runs as a headless daemon, connects to the server via WebSocket,
// and drives FTMS treadmill + HRM via node-ble (D-Bus/BlueZ).

const { createBluetooth } = require('node-ble');
const { bluetooth, destroy: destroyBluetooth } = createBluetooth();
let adapter = null;
const WebSocket = require('ws');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const FTMSNative = require('./ftms-native');
const HRMNative = require('./hrm-native');
const FitshowNative = require('./fitshow-native');
const HRZoneController = require('./hr-zone-controller');

// ── Config ──────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'ble-config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { treadmillAddress: null, hrmAddress: null, autoConnect: true, serverUrl: 'ws://localhost:3000' };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

let config = loadConfig();

// Derive HTTP base URL from the WebSocket URL
function httpBase() {
  return config.serverUrl.replace(/^ws/, 'http').replace(/\/$/, '');
}

// ── State ───────────────────────────────────────────────────────────────────
const ftms = new FTMSNative();
const hrm = new HRMNative();
const fitshow = new FitshowNative();

let ws = null;
let wsReconnectDelay = 1000;
const WS_MAX_RECONNECT = 30000;

let ftmsReconnectDelay = 1000;
let hrmReconnectDelay = 1000;
const BLE_MAX_RECONNECT = 60000;            // cap backoff at 60s — 5min was too long when standing on treadmill
const BLE_FAST_RETRY_ATTEMPTS = 3;          // first N retries skip backoff (devices often need 1-2 quick retries after a transient drop)
let ftmsReconnectAttempts = 0;
let hrmReconnectAttempts = 0;
let ftmsGattTimeoutStreak = 0;              // consecutive GATT discovery failures — triggers BlueZ cache clear
let hrmGattTimeoutStreak = 0;

let currentWorkout = null;       // { id, segments }
let currentSegmentIndex = 0;
let segmentTimer = null;
let segmentStartTime = null;
let sessionId = null;
let sessionStartTime = null;
let sessionActive = false;
let currentTargetSpeed = 0;
let currentTargetIncline = 0;
let activeHRZoneController = null;
let hrZoneControlEnabled = false;
let sessionMaxHR = null;
let sessionProfile = null;  // { weight_kg, age, gender } for calorie calculation
let sessionCalories = 0;    // accumulated kcal from Keytel formula
let lastCalorieTickAt = 0;  // timestamp of last calorie accumulation, for time-based delta

// Keytel (2005) calorie formula — kcal per minute from heart rate
function keytelCaloriesPerMinute(hr, weightKg, age, gender) {
  if (!hr || !weightKg || !age) return 0;
  if (gender === 'female') {
    return (-20.4022 + 0.4472 * hr - 0.1263 * weightKg + 0.074 * age) / 4.184;
  }
  return (-55.0969 + 0.6309 * hr + 0.1988 * weightKg + 0.2017 * age) / 4.184;
}

// Data buffer — flushed periodically
let dataBuffer = [];
const DATA_FLUSH_INTERVAL = 1000; // ms — ~1 data point per second, matching app.js
let dataFlushTimer = null;

// Drift detection
let driftTimer = null;
const DRIFT_CHECK_INTERVAL = 8000; // ms

// State broadcast timer
let stateBroadcastTimer = null;
const STATE_BROADCAST_INTERVAL = 2000;

// ── WebSocket Connection ────────────────────────────────────────────────────
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  console.log('[WS] Connecting to', config.serverUrl);
  try {
    ws = new WebSocket(config.serverUrl);
  } catch (err) {
    console.error('[WS] Failed to create WebSocket:', err.message);
    scheduleWsReconnect();
    return;
  }

  ws.on('open', () => {
    console.log('[WS] Connected');
    wsReconnectDelay = 1000; // reset backoff

    // Register as native BLE controller
    wsSend({
      type: 'register',
      role: 'controller',
      bleBackend: 'native'
    });

    // Start broadcasting state and device status
    startStateBroadcast();
    broadcastDeviceStatus();
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleServerMessage(msg);
    } catch { /* ignore malformed */ }
  });

  ws.on('close', () => {
    console.log('[WS] Disconnected');
    stopStateBroadcast();
    scheduleWsReconnect();
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
    // 'close' will fire after this
  });
}

function scheduleWsReconnect() {
  ws = null;
  console.log(`[WS] Reconnecting in ${wsReconnectDelay / 1000}s...`);
  setTimeout(() => {
    connectWebSocket();
  }, wsReconnectDelay);
  wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT);
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ── State Broadcasting ──────────────────────────────────────────────────────
function buildCurrentState() {
  let workoutInfo = null;
  if (currentWorkout && currentWorkout.segments) {
    const segments = currentWorkout.segments;
    const totalDuration = segments.reduce((s, seg) => s + seg.duration_seconds, 0);
    let elapsedInWorkout = 0;
    for (let i = 0; i < currentSegmentIndex && i < segments.length; i++) {
      elapsedInWorkout += segments[i].duration_seconds;
    }
    if (segmentStartTime && currentSegmentIndex < segments.length) {
      elapsedInWorkout += (Date.now() - segmentStartTime) / 1000;
    }

    const currentSeg = segments[currentSegmentIndex];
    const segElapsed = segmentStartTime ? (Date.now() - segmentStartTime) / 1000 : 0;

    workoutInfo = {
      workoutId: currentWorkout.id,
      name: currentWorkout.name,
      currentSegmentIndex,
      totalSegments: segments.length,
      currentSegment: currentSeg ? {
        name: currentSeg.segment_name,
        targetSpeed: currentSeg.speed_kmh,
        targetIncline: currentSeg.incline_percent,
        durationSeconds: currentSeg.duration_seconds,
        timeRemaining: Math.max(0, currentSeg.duration_seconds - segElapsed),
        targetZone: currentSeg.target_max_zone || null
      } : null,
      nextSegment: segments[currentSegmentIndex + 1] ? {
        name: segments[currentSegmentIndex + 1].segment_name,
        targetSpeed: segments[currentSegmentIndex + 1].speed_kmh,
        targetIncline: segments[currentSegmentIndex + 1].incline_percent,
        durationSeconds: segments[currentSegmentIndex + 1].duration_seconds
      } : null,
      totalDuration,
      elapsedInWorkout,
      overallProgress: totalDuration > 0 ? (elapsedInWorkout / totalDuration) * 100 : 0
    };
  }

  const elapsed = sessionActive && sessionStartTime ? Math.floor((Date.now() - sessionStartTime) / 1000) : 0;

  return {
    type: 'treadmill_state',
    timestamp: Date.now(),
    sessionActive,
    speed: ftms.getLastReportedSpeed(),
    incline: ftms.getLastReportedIncline(),
    heartRate: hrm.getCurrentHeartRate(),
    heartRateSource: hrm.isConnected() ? 'ble' : 'none',
    distance: ftms.getLastReportedDistance(),
    elapsedTime: elapsed,
    calories: sessionCalories > 0 ? Math.round(sessionCalories) : ftms.getLastReportedCalories(),
    targetSpeed: currentTargetSpeed,
    targetIncline: currentTargetIncline,
    workout: workoutInfo,
    bleBackend: 'native',
    ftmsConnected: ftms.isConnected(),
    hrmConnected: hrm.isConnected(),
    fitshow: fitshow.isConnected() ? fitshow.getState() : null,
    hrZoneControl: activeHRZoneController ? activeHRZoneController.getState() : null
  };
}

function startStateBroadcast() {
  stopStateBroadcast();
  stateBroadcastTimer = setInterval(() => {
    wsSend(buildCurrentState());
  }, STATE_BROADCAST_INTERVAL);
  // Send immediately
  wsSend(buildCurrentState());
}

function stopStateBroadcast() {
  if (stateBroadcastTimer) {
    clearInterval(stateBroadcastTimer);
    stateBroadcastTimer = null;
  }
}

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

let deviceStatusTimer = null;

function broadcastDeviceStatus() {
  if (deviceStatusTimer) clearInterval(deviceStatusTimer);
  const send = () => {
    wsSend({
      type: 'device_status',
      treadmill: ftms.isConnected() ? 'connected' : 'disconnected',
      treadmillName: ftms.isConnected() ? (fitshow.isConnected() ? fitshow.getState().model : 'Tredemølle') : null,
      treadmillRetrying: !ftms.isConnected() && ftmsReconnectAttempts > 0,
      treadmillNextRetryAt: !ftms.isConnected() ? Date.now() + ftmsReconnectDelay : null,
      treadmillAttempts: ftmsReconnectAttempts,
      hrm: hrm.isConnected() ? 'connected' : 'disconnected',
      hrmName: hrm.isConnected() ? hrm.getDeviceName() : null,
      hrmRetrying: !hrm.isConnected() && hrmReconnectAttempts > 0,
      hrmNextRetryAt: !hrm.isConnected() ? Date.now() + hrmReconnectDelay : null,
      hrmAttempts: hrmReconnectAttempts,
      heartRate: hrm.getCurrentHeartRate(),
      bleBackend: 'native'
    });
  };
  send();
  deviceStatusTimer = setInterval(send, 5000);
}

// ── Server Message Handler ──────────────────────────────────────────────────
function handleServerMessage(msg) {
  // The server forwards viewer commands as: { type: 'remote_command', commandId, command, params }
  if (msg.type !== 'remote_command') return;

  const { commandId, command, params } = msg;

  switch (command) {
    case 'load_workout':
      handleLoadWorkout(commandId, params);
      break;
    case 'start_session':
      handleStartSession(commandId, params);
      break;
    case 'stop_session':
      handleStopSession(commandId, params);
      break;
    case 'skip_segment':
      handleSkipSegment(commandId, params);
      break;
    case 'fitshow_query':
      if (!fitshow.isConnected()) {
        sendCommandResponse(commandId, 'fitshow_query', false, 'FitShow not connected');
      } else {
        sendCommandResponse(commandId, 'fitshow_query', true, null, fitshow.getState());
      }
      break;
    case 'fitshow_key':
      if (!fitshow.isConnected()) {
        sendCommandResponse(commandId, 'fitshow_key', false, 'FitShow not connected');
      } else {
        fitshow.sendKey(params.keyCode || 0).then(() => {
          sendCommandResponse(commandId, 'fitshow_key', true);
        }).catch((err) => {
          sendCommandResponse(commandId, 'fitshow_key', false, err.message);
        });
      }
      break;
    case 'ble_scan':
      handleBleScan(commandId, params);
      break;
    case 'ble_connect':
      handleBleConnect(commandId, params);
      break;
    case 'ble_disconnect':
      handleBleDisconnect(commandId, params);
      break;
    case 'ble_reconnect':
      handleBleReconnect(commandId, params);
      break;
    case 'ble_force_reset':
      handleBleForceReset(commandId, params);
      break;
    case 'set_speed':
      handleSetSpeed(commandId, params);
      break;
    case 'set_incline':
      handleSetIncline(commandId, params);
      break;
    default:
      sendCommandResponse(commandId, command, false, `Unknown command: ${command}`);
      break;
  }
}

function sendCommandResponse(commandId, command, success, error, data) {
  const msg = { type: 'command_response', commandId, command, success };
  if (error) msg.error = error;
  if (data) msg.data = data;
  wsSend(msg);
}

// ── BLE Scan ────────────────────────────────────────────────────────────────
async function handleBleScan(commandId, params) {
  try {
    const devices = await doBleScan(params);
    sendCommandResponse(commandId, 'ble_scan', true, null, { devices });
  } catch (err) {
    sendCommandResponse(commandId, 'ble_scan', false, err.message);
  }
}

async function doBleScan(params) {
  const duration = (params && params.duration) || 10000;
  console.log(`[BLE] Starting scan for ${duration / 1000}s...`);

  if (!adapter) adapter = await bluetooth.defaultAdapter();
  if (!await adapter.isPowered()) throw new Error('Bluetooth adapter not powered on');

  if (!await adapter.isDiscovering()) {
    await adapter.startDiscovery();
  }

  await new Promise(r => setTimeout(r, duration));

  try { await adapter.stopDiscovery(); } catch (e) { /* may already be stopped */ }

  const deviceAddresses = await adapter.devices();
  const discovered = [];

  for (const addr of deviceAddresses) {
    try {
      const device = await adapter.waitDevice(addr, 1000);
      const name = await device.getName().catch(() => null);
      const uuids = await device.getUUIDs().catch(() => []);
      const hasFTMS = uuids.some(u => u.toLowerCase().includes('1826'));
      const hasHRM = uuids.some(u => u.toLowerCase().includes('180d'));

      if (hasFTMS || hasHRM || name) {
        discovered.push({ name, address: addr, services: uuids, hasFTMS, hasHRM });
      }
    } catch (e) { /* Device may have gone out of range */ }
  }

  console.log(`[BLE] Scan complete, found ${discovered.length} device(s)`);
  return discovered;
}

// ── BLE Connect ─────────────────────────────────────────────────────────────
async function handleBleConnect(commandId, params) {
  const { deviceType, address } = params || {};
  if (!address) {
    sendCommandResponse(commandId, 'ble_connect', false, 'No address provided');
    return;
  }
  try {
    const result = await doBleConnect(deviceType, address);
    sendCommandResponse(commandId, 'ble_connect', true, null, result);
  } catch (err) {
    console.error(`[BLE] Connect failed (${deviceType}):`, err.message);
    sendCommandResponse(commandId, 'ble_connect', false, err.message);
  }
}

async function doBleConnect(deviceType, address) {
  if (!adapter) adapter = await bluetooth.defaultAdapter();

  // Brief discovery to ensure BlueZ sees the device
  if (!await adapter.isDiscovering()) {
    await adapter.startDiscovery();
    await new Promise(r => setTimeout(r, 3000));
    try { await adapter.stopDiscovery(); } catch (e) {}
  }

  const device = await adapter.waitDevice(address, 15000);
  const name = await device.getName().catch(() => address);

  if (deviceType === 'treadmill') {
    await ftms.connect(device);
    setupFtmsListeners();
    try {
      const gattServer = ftms.getGattServer();
      await fitshow.connectWithGatt(gattServer);
      setupFitshowListeners();
      console.log('[BLE] FitShow FFF0 protocol connected');
    } catch (e) {
      console.log('[BLE] FitShow FFF0 not available:', e.message);
    }
    config.treadmillAddress = address;
    saveConfig(config);
    ftmsReconnectDelay = 1000;
    broadcastDeviceStatus();
    return { deviceType: 'treadmill', name, fitshow: fitshow.isConnected() };
  } else if (deviceType === 'hrm') {
    await hrm.connect(device, name);
    setupHrmListeners();
    config.hrmAddress = address;
    saveConfig(config);
    hrmReconnectDelay = 1000;
    broadcastDeviceStatus();
    return { deviceType: 'hrm', name };
  } else {
    throw new Error('Unknown device type');
  }
}

// ── BLE Disconnect ──────────────────────────────────────────────────────────
function handleBleDisconnect(commandId, params) {
  const { deviceType } = params || {};
  if (deviceType === 'treadmill') {
    ftms.disconnect();
    sendCommandResponse(commandId, 'ble_disconnect', true);
  } else if (deviceType === 'hrm') {
    hrm.disconnect();
    sendCommandResponse(commandId, 'ble_disconnect', true);
  } else {
    sendCommandResponse(commandId, 'ble_disconnect', false, 'Unknown device type');
  }
}

// ── BLE Reconnect ───────────────────────────────────────────────────────────

// Power-cycle the BlueZ adapter. Needed when the adapter is stale after long idle —
// scans return 0 devices and waitDevice times out even though everything is on.
// Only safe when no devices are currently connected; otherwise we'd kick them off.
async function powerCycleAdapter() {
  try {
    await execAsync('bluetoothctl power off');
    await new Promise(r => setTimeout(r, 500));
    await execAsync('bluetoothctl power on');
    await new Promise(r => setTimeout(r, 1500));
    adapter = null; // force fresh adapter reference
    console.log('[BLE] Adapter power-cycled');
  } catch (e) {
    console.log('[BLE] Power cycle failed (non-fatal):', e.message);
  }
}

// Forcibly remove a single device from BlueZ's cache. Useful when GATT discovery
// hangs because BlueZ holds a stale device reference.
async function clearBluezDeviceCache(address) {
  try {
    await execAsync(`bluetoothctl remove ${address}`);
    console.log(`[BLE] Cleared BlueZ cache for ${address}`);
    await new Promise(r => setTimeout(r, 500));
  } catch (e) {
    // Device may already be gone — non-fatal
    console.log(`[BLE] Cache clear for ${address} (non-fatal): ${e.message.split('\n')[0]}`);
  }
}

// Rediscover a device by name when its saved address no longer responds. Polar H10
// (and others) can rotate their BLE MAC after a hard reset / battery swap. We scan,
// match by name, and update the saved address.
async function rediscoverByName(savedAddress, expectedNamePrefix) {
  try {
    if (!adapter) adapter = await bluetooth.defaultAdapter();
    if (!await adapter.isDiscovering()) {
      await adapter.startDiscovery();
    }
    await new Promise(r => setTimeout(r, 6000));
    try { await adapter.stopDiscovery(); } catch (e) {}

    const addresses = await adapter.devices();
    for (const addr of addresses) {
      if (addr.toLowerCase() === savedAddress.toLowerCase()) continue; // already tried this
      try {
        const device = await adapter.waitDevice(addr, 1000);
        const name = await device.getName().catch(() => null);
        if (name && name.toLowerCase().includes(expectedNamePrefix.toLowerCase())) {
          console.log(`[BLE] Rediscovered "${name}" at new address ${addr} (was ${savedAddress})`);
          return addr;
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) {
    console.log('[BLE] Rediscovery failed:', e.message);
  }
  return null;
}

// Nuclear-option recovery: tear down everything, clear BlueZ cache for both saved
// addresses, power-cycle the adapter, reset attempt counters, attempt fresh connect.
async function handleBleForceReset(commandId, params) {
  console.log('[BLE] Force reset requested');
  try {
    try { ftms.disconnect(); } catch (e) {}
    try { hrm.disconnect(); } catch (e) {}
    try { fitshow.disconnect(); } catch (e) {}

    if (config.treadmillAddress) await clearBluezDeviceCache(config.treadmillAddress);
    if (config.hrmAddress) await clearBluezDeviceCache(config.hrmAddress);

    await powerCycleAdapter();

    ftmsReconnectAttempts = 0; ftmsReconnectDelay = 1000; ftmsGattTimeoutStreak = 0;
    hrmReconnectAttempts = 0; hrmReconnectDelay = 1000; hrmGattTimeoutStreak = 0;

    if (config.treadmillAddress) {
      reconnectFtms().catch(() => scheduleReconnect('treadmill'));
    }
    if (config.hrmAddress) {
      reconnectHrm().catch(() => scheduleReconnect('hrm'));
    }

    broadcastDeviceStatus();
    sendCommandResponse(commandId, 'ble_force_reset', true);
  } catch (err) {
    console.error('[BLE] Force reset failed:', err.message);
    sendCommandResponse(commandId, 'ble_force_reset', false, err.message);
  }
}

async function handleBleReconnect(commandId, params) {
  const { deviceType } = params || {};
  try {
    // If both devices are down, the adapter itself is likely stale — power-cycle it
    // before attempting reconnect. If only one is down, leave the adapter alone so
    // we don't knock out the other device.
    const bothDown = !ftms.isConnected() && !hrm.isConnected();
    if (bothDown) await powerCycleAdapter();

    if (deviceType === 'treadmill' && config.treadmillAddress) {
      ftmsReconnectAttempts = 0;
      ftmsReconnectDelay = 1000;
      await reconnectFtms();
      sendCommandResponse(commandId, 'ble_reconnect', true, null, { deviceType: 'treadmill' });
    } else if (deviceType === 'hrm' && config.hrmAddress) {
      hrmReconnectAttempts = 0;
      hrmReconnectDelay = 1000;
      await reconnectHrm();
      sendCommandResponse(commandId, 'ble_reconnect', true, null, { deviceType: 'hrm' });
    } else {
      sendCommandResponse(commandId, 'ble_reconnect', false, 'No saved address');
    }
  } catch (err) {
    // First attempt failed — schedule retry loop
    if (deviceType === 'treadmill') scheduleReconnect('treadmill');
    if (deviceType === 'hrm') scheduleReconnect('hrm');
    sendCommandResponse(commandId, 'ble_reconnect', false, err.message);
  }
}

// ── FTMS Event Wiring ───────────────────────────────────────────────────────
function setupFtmsListeners() {
  // Remove previous listeners to avoid duplicates on reconnect
  ftms.removeAllListeners('data');
  ftms.removeAllListeners('status');
  ftms.removeAllListeners('disconnect');

  ftms.on('data', (data) => {
    if (sessionActive && sessionId) {
      const hr = hrm.getCurrentHeartRate() || null;

      // Time-based calorie accumulation. FTMS sends data at variable rate (~3 Hz on
      // our treadmill), so per-event accumulation overestimates by ~3x.
      if (hr && sessionProfile && sessionProfile.weight_kg && sessionProfile.age) {
        const now = Date.now();
        if (lastCalorieTickAt > 0) {
          const dtMs = Math.min(now - lastCalorieTickAt, 5000); // cap at 5s gap (e.g. paused/disconnect)
          const kcalPerMin = keytelCaloriesPerMinute(hr, sessionProfile.weight_kg, sessionProfile.age, sessionProfile.gender);
          sessionCalories += kcalPerMin * (dtMs / 60000);
        }
        lastCalorieTickAt = now;
      }

      dataBuffer.push({
        speed_kmh: data.speed_kmh || 0,
        incline_percent: data.incline_percent || 0,
        distance_km: data.total_distance_m ? data.total_distance_m / 1000 : 0,
        heart_rate: hr,
        calories: Math.round(sessionCalories),
        segment_index: currentSegmentIndex
      });
    }
  });

  ftms.on('status', (statusStr, statusCode, isAppInitiated) => {
    console.log(`[Service] FTMS status: ${statusStr} (0x${statusCode.toString(16)}) appInitiated=${isAppInitiated}`);

    // On FTMS started (0x04) + loaded workout → auto-start session
    if (statusCode === 0x04 && currentWorkout && !sessionActive) {
      console.log('[Service] Treadmill started with loaded workout — auto-starting session');
      handleStartSession('physical-start', {});
    }

    // On FTMS stopped (0x02) or reset (0x01) + active session → auto-stop
    if ((statusCode === 0x02 || statusCode === 0x01) && sessionActive) {
      console.log('[Service] Treadmill stopped/reset — auto-stopping session');
      handleStopSession('physical-stop', {});
    }

    // Manual speed/incline change on treadmill (not from app)
    if (!isAppInitiated && sessionActive) {
      if (statusCode === 0x0A) { // Target Speed Changed
        const newSpeed = ftms.getLastReportedSpeed();
        if (newSpeed !== null && Math.abs(newSpeed - currentTargetSpeed) > 0.3) {
          currentTargetSpeed = newSpeed;
          console.log(`[Service] Manual speed change on treadmill: ${newSpeed} km/t`);
          if (activeHRZoneController) {
            activeHRZoneController.pause(45000);
            activeHRZoneController.updateBaseline(newSpeed, currentTargetIncline);
            console.log('[HRZone] Manual treadmill override — pausing controller for 45s');
          }
        }
      }
      if (statusCode === 0x0B) { // Target Incline Changed
        const newIncline = ftms.getLastReportedIncline();
        if (newIncline !== null && Math.abs(newIncline - currentTargetIncline) > 0.3) {
          currentTargetIncline = newIncline;
          console.log(`[Service] Manual incline change on treadmill: ${newIncline}%`);
          if (activeHRZoneController) {
            activeHRZoneController.pause(45000);
            activeHRZoneController.updateBaseline(currentTargetSpeed, newIncline);
            console.log('[HRZone] Manual treadmill override — pausing controller for 45s');
          }
        }
      }
    }
  });

  ftms.on('disconnect', () => {
    console.log('[Service] FTMS disconnected — scheduling reconnect');
    // Pause segment timer during disconnect to prevent blind advancement
    if (sessionActive && segmentTimer) {
      stopSegmentTimer();
      console.log('[Service] Segment timer paused due to disconnect');
      if (activeHRZoneController) {
        activeHRZoneController.pause(300000);
        console.log('[Service] HR zone controller paused due to disconnect');
      }
    }
    broadcastDeviceStatus();
    scheduleReconnect('treadmill');
  });
}

// ── HRM Event Wiring ────────────────────────────────────────────────────────
function setupHrmListeners() {
  hrm.removeAllListeners('heartRate');
  hrm.removeAllListeners('disconnect');

  hrm.on('heartRate', (hr) => {
    // Heart rate is picked up in the data buffer via hrm.getCurrentHeartRate()
  });

  hrm.on('disconnect', () => {
    console.log('[Service] HRM disconnected — scheduling reconnect');
    broadcastDeviceStatus();
    if (sessionActive) {
      wsSend({ type: 'coaching_event', event: 'hrm_lost', timestamp: Date.now() });
      if (activeHRZoneController) {
        activeHRZoneController.pause(120000);
        console.log('[HRZone] Paused due to HRM drop (120s)');
      }
    }
    scheduleReconnect('hrm');
  });
}

// ── FitShow Event Wiring ───────────────────────────────────────────────────
function setupFitshowListeners() {
  fitshow.removeAllListeners();

  fitshow.on('deviceInfo', (info) => {
    console.log('[FitShow] Device info updated');
    wsSend({ type: 'fitshow_info', info });
  });

  fitshow.on('data', (data) => {
    // FitShow provides steps which FTMS doesn't
    if (data.steps > 0) {
      wsSend({ type: 'fitshow_data', steps: data.steps, calories: data.calories });
    }
  });

  fitshow.on('error', (code, name) => {
    console.error('[FitShow] Error:', name);
    wsSend({ type: 'fitshow_error', errorCode: code, errorName: name });
  });

  fitshow.on('status', (status, details) => {
    if (status === 'safety_key_removed') {
      wsSend({ type: 'fitshow_alert', alert: 'safety_key_removed', message: 'Sikkerhetsnøkkel fjernet!' });
    }
    if (status === 'error') {
      wsSend({ type: 'fitshow_alert', alert: 'error', message: details.errorName || 'Ukjent feil' });
    }
  });

  fitshow.on('disconnect', () => {
    console.log('[FitShow] Disconnected');
  });
}

// ── Auto-Reconnect with Exponential Backoff ─────────────────────────────────
// Reconnect retries forever (no give-up cliff). The first BLE_FAST_RETRY_ATTEMPTS
// attempts run with no backoff — most transient drops resolve in under a minute.
// After that, exponential backoff up to BLE_MAX_RECONNECT (60s).
async function handleReconnectFailure(deviceType, err) {
  const isGattTimeout = /GATT discovery timeout/i.test(err.message);

  if (deviceType === 'treadmill') {
    if (isGattTimeout) {
      ftmsGattTimeoutStreak++;
      if (ftmsGattTimeoutStreak >= 1 && config.treadmillAddress) {
        console.log('[BLE] Treadmill GATT timeout — clearing BlueZ cache');
        await clearBluezDeviceCache(config.treadmillAddress);
        ftmsGattTimeoutStreak = 0;
      }
    } else {
      ftmsGattTimeoutStreak = 0;
    }
  } else {
    if (isGattTimeout) {
      hrmGattTimeoutStreak++;
      if (hrmGattTimeoutStreak >= 1 && config.hrmAddress) {
        console.log('[BLE] HRM GATT timeout — clearing BlueZ cache');
        await clearBluezDeviceCache(config.hrmAddress);
        hrmGattTimeoutStreak = 0;
      }
    } else {
      hrmGattTimeoutStreak = 0;
    }
  }
}

function scheduleReconnect(deviceType) {
  if (deviceType === 'treadmill' && config.treadmillAddress) {
    ftmsReconnectAttempts++;
    const isFastRetry = ftmsReconnectAttempts <= BLE_FAST_RETRY_ATTEMPTS;
    const delay = isFastRetry ? 100 : ftmsReconnectDelay;
    console.log(`[BLE] Treadmill reconnect in ${delay / 1000}s... (attempt ${ftmsReconnectAttempts})`);
    setTimeout(async () => {
      try {
        await reconnectFtms();
        ftmsReconnectDelay = 1000;
        ftmsReconnectAttempts = 0;
        ftmsGattTimeoutStreak = 0;
      } catch (err) {
        console.error('[BLE] Treadmill reconnect failed:', err.message);
        await handleReconnectFailure('treadmill', err);
        if (!isFastRetry) {
          ftmsReconnectDelay = Math.min(ftmsReconnectDelay * 2, BLE_MAX_RECONNECT);
        }
        scheduleReconnect('treadmill');
      }
    }, delay);
  }

  if (deviceType === 'hrm' && config.hrmAddress) {
    hrmReconnectAttempts++;
    const isFastRetry = hrmReconnectAttempts <= BLE_FAST_RETRY_ATTEMPTS;
    const delay = isFastRetry ? 100 : hrmReconnectDelay;
    console.log(`[BLE] HRM reconnect in ${delay / 1000}s... (attempt ${hrmReconnectAttempts})`);
    setTimeout(async () => {
      try {
        await reconnectHrm();
        hrmReconnectDelay = 1000;
        hrmReconnectAttempts = 0;
        hrmGattTimeoutStreak = 0;
      } catch (err) {
        console.error('[BLE] HRM reconnect failed:', err.message);
        await handleReconnectFailure('hrm', err);
        if (!isFastRetry) {
          hrmReconnectDelay = Math.min(hrmReconnectDelay * 2, BLE_MAX_RECONNECT);
        }
        scheduleReconnect('hrm');
      }
    }, delay);
  }
}

async function reconnectFtms() {
  if (ftms.isConnected()) return;
  if (!config.treadmillAddress) throw new Error('No treadmill address saved');

  if (!adapter) adapter = await bluetooth.defaultAdapter();

  // Brief discovery to ensure BlueZ sees the device
  try {
    if (!await adapter.isDiscovering()) {
      await adapter.startDiscovery();
    }
    await new Promise(r => setTimeout(r, 3000));
    try { await adapter.stopDiscovery(); } catch (e) {}
  } catch (e) {
    console.log('[BLE] Discovery error (non-fatal):', e.message);
  }

  let device;
  try {
    device = await Promise.race([
      adapter.waitDevice(config.treadmillAddress, 8000),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Device not found (8s)')), 9000))
    ]);
  } catch (e) {
    // Saved address didn't respond — try to rediscover by name (e.g. after factory reset)
    if (ftmsReconnectAttempts >= 3) {
      const newAddr = await rediscoverByName(config.treadmillAddress, 'FitShow');
      if (newAddr) {
        config.treadmillAddress = newAddr;
        saveConfig(config);
        device = await adapter.waitDevice(newAddr, 8000);
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }
  await ftms.connect(device);
  setupFtmsListeners();
  try {
    const gattServer = ftms.getGattServer();
    await fitshow.connectWithGatt(gattServer);
    setupFitshowListeners();
    console.log('[BLE] FitShow reconnected');
  } catch (e) {
    console.log('[BLE] FitShow reconnect skipped:', e.message);
  }
  broadcastDeviceStatus();
  console.log('[BLE] Treadmill reconnected');

  // Resume workout if session was active during disconnect
  if (sessionActive && currentTargetSpeed > 0 && currentWorkout) {
    try {
      await ftms.setSpeed(currentTargetSpeed);
      await ftms.setIncline(currentTargetIncline);
      // Resume segment timer for remaining time
      const seg = currentWorkout.segments[currentSegmentIndex];
      if (seg && segmentStartTime) {
        const elapsed = (Date.now() - segmentStartTime) / 1000;
        const remaining = seg.duration_seconds - elapsed;
        if (remaining > 0) {
          segmentTimer = setTimeout(() => {
            currentSegmentIndex++;
            executeSegment(currentSegmentIndex);
          }, remaining * 1000);
          console.log(`[BLE] Resumed segment ${currentSegmentIndex} with ${Math.round(remaining)}s remaining`);
        } else {
          currentSegmentIndex++;
          executeSegment(currentSegmentIndex);
        }
      }
      // Resume HR zone controller if it was paused
      if (activeHRZoneController && activeHRZoneController.paused) {
        activeHRZoneController.resume();
        console.log('[BLE] Resumed HR zone controller after reconnect');
      }
    } catch (e) {
      console.error('[BLE] Failed to re-send targets after reconnect:', e.message);
    }
  }
}

async function reconnectHrm() {
  if (hrm.isConnected()) return;
  if (!config.hrmAddress) throw new Error('No HRM address saved');

  if (!adapter) adapter = await bluetooth.defaultAdapter();

  // Brief discovery to ensure BlueZ sees the device
  try {
    if (!await adapter.isDiscovering()) {
      await adapter.startDiscovery();
    }
    await new Promise(r => setTimeout(r, 3000));
    try { await adapter.stopDiscovery(); } catch (e) {}
  } catch (e) {
    console.log('[BLE] Discovery error (non-fatal):', e.message);
  }

  let device;
  try {
    device = await Promise.race([
      adapter.waitDevice(config.hrmAddress, 8000),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Device not found (8s)')), 9000))
    ]);
  } catch (e) {
    // Saved address didn't respond — Polar H10 rotates MAC after hard reset.
    // Try to rediscover by name after a few failed attempts.
    if (hrmReconnectAttempts >= 3) {
      const newAddr = await rediscoverByName(config.hrmAddress, 'Polar');
      if (newAddr) {
        config.hrmAddress = newAddr;
        saveConfig(config);
        device = await adapter.waitDevice(newAddr, 8000);
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }
  const name = await device.getName().catch(() => config.hrmAddress);
  await hrm.connect(device, name);
  setupHrmListeners();
  broadcastDeviceStatus();
  console.log('[BLE] HRM reconnected');

  if (sessionActive) {
    wsSend({ type: 'coaching_event', event: 'hrm_recovered', timestamp: Date.now() });
    if (activeHRZoneController && activeHRZoneController.paused) {
      activeHRZoneController.resume();
    }
  }
}

// ── Workout / Session Management ────────────────────────────────────────────
async function handleLoadWorkout(commandId, params) {
  const workoutId = params && (params.workoutId || params.workout_id);
  if (!workoutId) {
    sendCommandResponse(commandId, 'load_workout', false, 'No workout ID');
    return;
  }

  try {
    const url = `${httpBase()}/api/workouts/${workoutId}`;
    console.log(`[Session] Loading workout ${workoutId} from ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const workout = await res.json();

    currentWorkout = workout;
    currentSegmentIndex = 0;
    console.log(`[Session] Loaded workout "${workout.name}" with ${workout.segments.length} segment(s)`);
    sendCommandResponse(commandId, 'load_workout', true);
  } catch (err) {
    console.error('[Session] Failed to load workout:', err.message);
    sendCommandResponse(commandId, 'load_workout', false, err.message);
  }
}

async function handleStartSession(commandId, params) {
  if (sessionActive) {
    sendCommandResponse(commandId, 'start_session', false, 'Session already active');
    return;
  }
  if (!ftms.isConnected() && commandId !== 'physical-start') {
    sendCommandResponse(commandId, 'start_session', false, 'Treadmill not connected');
    return;
  }

  try {
    const body = {
      workout_id: currentWorkout ? currentWorkout.id : null,
      heart_rate_source: hrm.isConnected() ? 'ble' : 'none',
      profile_id: params.profileId || params.profile_id || null,
      hr_zone_control_enabled: params.hr_zone_control_enabled ? 1 : 0
    };
    const res = await fetch(`${httpBase()}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();

    sessionId = result.id;
    sessionActive = true;
    sessionStartTime = Date.now();
    dataBuffer = [];

    hrZoneControlEnabled = !!params.hr_zone_control_enabled;
    sessionMaxHR = null;
    sessionProfile = null;
    sessionCalories = 0;
    lastCalorieTickAt = 0;

    // Fetch profile for HR zone control and calorie calculation
    const pid = parseInt(params.profileId || params.profile_id);
    if (pid) {
      try {
        const profileRes = await fetch(`${httpBase()}/api/profiles/${pid}`);
        if (profileRes.ok) {
          const profile = await profileRes.json();
          sessionMaxHR = profile.max_hr;
          sessionProfile = { weight_kg: profile.weight_kg, age: profile.age, gender: profile.gender || 'male' };
          if (sessionProfile.weight_kg && sessionProfile.age) {
            console.log(`[Session] Calorie calc: Keytel formula (${sessionProfile.weight_kg}kg, age ${sessionProfile.age}, ${sessionProfile.gender})`);
          }
        }
      } catch (e) {
        console.error('[Session] Failed to fetch profile:', e.message);
      }
    }

    if (hrZoneControlEnabled && !hrm.isConnected()) {
      console.log('[HRZone] HRM not connected — disabling HR zone control');
      hrZoneControlEnabled = false;
      wsSend({ type: 'hr_zone_status', action: 'disabled', reason: 'hrm_not_connected' });
    }
    if (hrZoneControlEnabled && !sessionMaxHR) {
      console.log('[HRZone] No maxHR available — disabling HR zone control');
      hrZoneControlEnabled = false;
      wsSend({ type: 'hr_zone_status', action: 'disabled', reason: 'no_max_hr' });
    }

    console.log(`[Session] Started session ${sessionId}`);

    startDataFlush();
    startDriftDetection();
    startHRZoneTick();

    if (currentWorkout && currentWorkout.segments && currentWorkout.segments.length > 0) {
      currentSegmentIndex = 0;
      executeSegment(currentSegmentIndex);
    }

    sendCommandResponse(commandId, 'start_session', true, null, { workout_id: currentWorkout ? currentWorkout.id : null });
  } catch (err) {
    console.error('[Session] Failed to start session:', err.message);
    sendCommandResponse(commandId, 'start_session', false, err.message);
  }
}

async function handleStopSession(commandId, params) {
  if (!sessionActive) {
    if (commandId && !['physical-stop', 'auto-complete', 'auto-skip-end'].includes(commandId)) {
      sendCommandResponse(commandId, 'stop_session', false, 'No active session');
    }
    return;
  }

  stopSegmentTimer();
  stopDataFlush();
  stopDriftDetection();
  if (activeHRZoneController) {
    activeHRZoneController.stop();
    activeHRZoneController = null;
  }
  hrZoneControlEnabled = false;
  sessionMaxHR = null;
  stopHRZoneTick();

  // Stop the treadmill belt (unless it was a physical stop — belt already stopped)
  if (commandId !== 'physical-stop' && ftms.isConnected()) {
    try {
      await ftms.stop();
      console.log('[Session] Sent FTMS stop command');
    } catch (e) {
      console.error('[Session] FTMS stop failed:', e.message);
    }
  }

  await flushDataBuffer();

  const elapsed = sessionStartTime ? Math.floor((Date.now() - sessionStartTime) / 1000) : 0;

  // Fetch computed stats from recorded data points
  let distance = 0, avgHr = null, calories = 0;
  try {
    const statsRes = await fetch(`${httpBase()}/api/sessions/${sessionId}/details`);
    if (statsRes.ok) {
      const details = await statsRes.json();
      const points = details.dataPoints || details.data_points;
      if (points && points.length > 0) {
        const lastPoint = points[points.length - 1];
        distance = lastPoint.distance_km || 0;
        calories = lastPoint.calories || 0;
        const hrPoints = points.filter(p => p.heart_rate && p.heart_rate > 0);
        if (hrPoints.length > 0) {
          avgHr = Math.round(hrPoints.reduce((s, p) => s + p.heart_rate, 0) / hrPoints.length);
        }
      }
    }
  } catch (e) {
    console.error('[Session] Failed to fetch stats:', e.message);
  }

  try {
    await fetch(`${httpBase()}/api/sessions/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        total_distance_km: distance,
        total_time_seconds: elapsed,
        avg_heart_rate: avgHr,
        calories_burned: calories
      })
    });
    console.log(`[Session] Session ${sessionId} completed (${elapsed}s, ${distance.toFixed(2)}km, HR:${avgHr || 'n/a'})`);
  } catch (err) {
    console.error('[Session] Failed to complete session:', err.message);
  }

  wsSend({ type: 'treadmill_state', timestamp: Date.now(), sessionActive: false });

  sessionActive = false;
  sessionId = null;
  sessionStartTime = null;
  sessionProfile = null;
  sessionCalories = 0;
  lastCalorieTickAt = 0;
  currentWorkout = null;
  currentSegmentIndex = 0;
  currentTargetSpeed = 0;
  currentTargetIncline = 0;

  if (commandId && !['physical-stop', 'auto-complete', 'auto-skip-end'].includes(commandId)) {
    sendCommandResponse(commandId, 'stop_session', true);
  }
}

function handleSkipSegment(commandId, params) {
  if (!sessionActive || !currentWorkout || !currentWorkout.segments) {
    sendCommandResponse(commandId, 'skip_segment', false, 'No active workout');
    return;
  }

  const nextIndex = currentSegmentIndex + 1;
  if (nextIndex >= currentWorkout.segments.length) {
    console.log('[Session] No more segments to skip to — stopping session');
    handleStopSession('auto-skip-end', {});
    sendCommandResponse(commandId, 'skip_segment', true);
    return;
  }

  console.log(`[Session] Skipping from segment ${currentSegmentIndex} to ${nextIndex}`);
  stopSegmentTimer();
  currentSegmentIndex = nextIndex;
  executeSegment(currentSegmentIndex);
  sendCommandResponse(commandId, 'skip_segment', true);
}

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

// ── Segment Execution ───────────────────────────────────────────────────────
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

  const isHRControlled = hrZoneControlEnabled && segment.hr_zone_control === 1 && segment.target_max_zone && sessionMaxHR;

  if (!isHRControlled && activeHRZoneController) {
    activeHRZoneController.stop();
    activeHRZoneController = null;
    console.log('[HRZone] Segment not HR-controlled — stopped controller');
  }

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
        wsSend({ type: 'hr_zone_status', ...status });
      },
    });
    console.log(`[HRZone] Started controller: zone ${segment.target_max_zone}, mode ${segment.hr_zone_control_mode || 'speed'}, maxHR ${sessionMaxHR}`);
  }

  stopSegmentTimer();
  segmentStartTime = Date.now();
  segmentTimer = setTimeout(() => {
    currentSegmentIndex++;
    executeSegment(currentSegmentIndex);
  }, segment.duration_seconds * 1000);
}

function stopSegmentTimer() {
  if (segmentTimer) {
    clearTimeout(segmentTimer);
    segmentTimer = null;
  }
  segmentStartTime = null;
}

// ── Data Buffer Flush ───────────────────────────────────────────────────────
function startDataFlush() {
  stopDataFlush();
  dataFlushTimer = setInterval(() => {
    flushDataBuffer();
  }, DATA_FLUSH_INTERVAL);
}

function stopDataFlush() {
  if (dataFlushTimer) {
    clearInterval(dataFlushTimer);
    dataFlushTimer = null;
  }
}

async function flushDataBuffer() {
  if (!sessionId || dataBuffer.length === 0) return;

  const toFlush = dataBuffer.splice(0);
  // Send most recent data point (latest snapshot)
  const latest = toFlush[toFlush.length - 1];

  try {
    await fetch(`${httpBase()}/api/sessions/${sessionId}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(latest)
    });
  } catch (err) {
    console.error('[Session] Data flush failed:', err.message);
    // Re-add to buffer for retry
    dataBuffer.unshift(...toFlush);
  }
}

// ── Drift Detection ─────────────────────────────────────────────────────────
function startDriftDetection() {
  stopDriftDetection();
  driftTimer = setInterval(() => {
    checkDrift();
  }, DRIFT_CHECK_INTERVAL);
}

function stopDriftDetection() {
  if (driftTimer) {
    clearInterval(driftTimer);
    driftTimer = null;
  }
}

async function checkDrift() {
  if (!sessionActive || !ftms.isConnected()) return;

  const actualSpeed = ftms.getLastReportedSpeed();
  const actualIncline = ftms.getLastReportedIncline();

  if (actualSpeed === null || currentTargetSpeed === 0) return;

  const speedDrift = Math.abs(actualSpeed - currentTargetSpeed);
  const inclineDrift = actualIncline !== null ? Math.abs(actualIncline - currentTargetIncline) : 0;

  // Correct if drift exceeds threshold (0.5 km/h for speed, 0.5% for incline)
  if (speedDrift > 0.5) {
    console.log(`[Drift] Speed drift: actual=${actualSpeed} target=${currentTargetSpeed} — correcting`);
    try {
      await ftms.setSpeed(currentTargetSpeed);
    } catch (err) {
      console.error('[Drift] Speed correction failed:', err.message);
    }
  }

  if (inclineDrift > 0.5) {
    console.log(`[Drift] Incline drift: actual=${actualIncline} target=${currentTargetIncline} — correcting`);
    try {
      await ftms.setIncline(currentTargetIncline);
    } catch (err) {
      console.error('[Drift] Incline correction failed:', err.message);
    }
  }
}

// ── Auto-Connect on Startup ─────────────────────────────────────────────────
async function autoConnect() {
  if (!config.autoConnect) return;
  try {
    adapter = await bluetooth.defaultAdapter();
    if (!await adapter.isPowered()) {
      console.log('[BLE] Bluetooth not powered, waiting...');
      setTimeout(() => autoConnect(), 5000);
      return;
    }
  } catch (e) {
    console.error('[BLE] Failed to get adapter:', e.message);
    setTimeout(() => autoConnect(), 5000);
    return;
  }

  if (config.treadmillAddress) {
    console.log(`[BLE] Auto-connecting to treadmill: ${config.treadmillAddress}`);
    try { await reconnectFtms(); } catch (err) {
      console.error('[BLE] Treadmill auto-connect failed:', err.message);
      scheduleReconnect('treadmill');
    }
  }
  if (config.hrmAddress) {
    console.log(`[BLE] Auto-connecting to HRM: ${config.hrmAddress}`);
    try { await reconnectHrm(); } catch (err) {
      console.error('[BLE] HRM auto-connect failed:', err.message);
      scheduleReconnect('hrm');
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
console.log('[Service] Treadmill BLE Service starting...');
console.log(`[Service] Server URL: ${config.serverUrl}`);
console.log(`[Service] Treadmill address: ${config.treadmillAddress || 'not set'}`);
console.log(`[Service] HRM address: ${config.hrmAddress || 'not set'}`);
console.log(`[Service] Auto-connect: ${config.autoConnect}`);

// Connect to server WebSocket
connectWebSocket();

// Auto-connect to BLE devices (after short delay to let BlueZ settle)
setTimeout(() => autoConnect(), 2000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[Service] Shutting down...');
  stopStateBroadcast();
  stopDataFlush();
  stopDriftDetection();
  stopSegmentTimer();
  ftms.disconnect();
  hrm.disconnect();
  fitshow.disconnect();
  if (ws) ws.close();
  destroyBluetooth();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Service] Terminated');
  ftms.disconnect();
  hrm.disconnect();
  fitshow.disconnect();
  if (ws) ws.close();
  destroyBluetooth();
  process.exit(0);
});
