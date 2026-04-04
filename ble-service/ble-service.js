#!/usr/bin/env node
// Native BLE Service for Treadmill Controller
// Runs as a headless daemon, connects to the server via WebSocket,
// and drives FTMS treadmill + HRM via noble (no browser required).

const noble = require('@abandonware/noble');
const WebSocket = require('ws');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const FTMSNative = require('./ftms-native');
const HRMNative = require('./hrm-native');
const FitshowNative = require('./fitshow-native');

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
const BLE_MAX_RECONNECT = 30000;

let currentWorkout = null;       // { id, segments }
let currentSegmentIndex = 0;
let segmentTimer = null;
let segmentStartTime = null;
let sessionId = null;
let sessionStartTime = null;
let sessionActive = false;
let currentTargetSpeed = 0;
let currentTargetIncline = 0;

// Data buffer — flushed periodically
let dataBuffer = [];
const DATA_FLUSH_INTERVAL = 5000; // ms
let dataFlushTimer = null;

// Drift detection
let driftTimer = null;
const DRIFT_CHECK_INTERVAL = 8000; // ms

// Scan guard
let scanInProgress = false;

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

    workoutInfo = {
      id: currentWorkout.id,
      name: currentWorkout.name,
      currentSegmentIndex,
      totalSegments: segments.length,
      currentSegment: segments[currentSegmentIndex] ? {
        name: segments[currentSegmentIndex].segment_name,
        targetSpeed: segments[currentSegmentIndex].speed_kmh,
        targetIncline: segments[currentSegmentIndex].incline_percent,
        durationSeconds: segments[currentSegmentIndex].duration_seconds,
        elapsed: segmentStartTime ? (Date.now() - segmentStartTime) / 1000 : 0
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
    distance: null, // computed server-side
    elapsedTime: elapsed,
    calories: null,
    targetSpeed: currentTargetSpeed,
    targetIncline: currentTargetIncline,
    workout: workoutInfo,
    bleBackend: 'native',
    ftmsConnected: ftms.isConnected(),
    hrmConnected: hrm.isConnected(),
    fitshow: fitshow.isConnected() ? fitshow.getState() : null
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

let deviceStatusTimer = null;

function broadcastDeviceStatus() {
  if (deviceStatusTimer) clearInterval(deviceStatusTimer);
  const send = () => {
    wsSend({
      type: 'device_status',
      treadmill: ftms.isConnected() ? 'connected' : 'disconnected',
      hrm: hrm.isConnected() ? 'connected' : 'disconnected',
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
    default:
      sendCommandResponse(commandId, command, false, `Unknown command: ${command}`);
      break;
  }
}

function sendCommandResponse(commandId, command, success, error, extra) {
  const msg = { type: 'command_response', commandId, command, success };
  if (error) msg.error = error;
  if (extra) Object.assign(msg, extra);
  wsSend(msg);
}

// ── BLE Scan ────────────────────────────────────────────────────────────────
async function handleBleScan(commandId, params) {
  if (scanInProgress) {
    sendCommandResponse(commandId, 'ble_scan', false, 'Scan already in progress');
    return;
  }

  const duration = (params && params.duration) || 10000;
  scanInProgress = true;
  const discovered = [];

  console.log(`[BLE] Starting scan for ${duration / 1000}s...`);

  // Ensure noble is powered on
  if (noble.state !== 'poweredOn') {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(), 5000);
      noble.once('stateChange', (state) => {
        clearTimeout(timeout);
        resolve();
      });
      if (noble.state === 'poweredOn') { clearTimeout(timeout); resolve(); }
    });
  }

  if (noble.state !== 'poweredOn') {
    scanInProgress = false;
    sendCommandResponse(commandId, 'ble_scan', false, 'Bluetooth not powered on');
    return;
  }

  const onDiscover = (peripheral) => {
    const name = peripheral.advertisement.localName || null;
    const addr = peripheral.address || peripheral.id;
    const serviceUuids = peripheral.advertisement.serviceUuids || [];
    const hasFTMS = serviceUuids.some(u => u.toLowerCase().replace(/-/g, '').includes('1826'));
    const hasHRM = serviceUuids.some(u => u.toLowerCase().replace(/-/g, '').includes('180d'));

    // Only report devices that have FTMS, HRM, or a recognizable name
    if (hasFTMS || hasHRM || name) {
      const entry = { name, address: addr, services: serviceUuids, hasFTMS, hasHRM };
      // Avoid duplicates
      if (!discovered.find(d => d.address === addr)) {
        discovered.push(entry);
        // Send incremental result
        wsSend({ type: 'ble_scan_device', device: entry });
      }
    }
  };

  noble.on('discover', onDiscover);

  try {
    await new Promise((resolve, reject) => {
      noble.startScanning([], true, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  } catch (err) {
    scanInProgress = false;
    noble.removeListener('discover', onDiscover);
    sendCommandResponse(commandId, 'ble_scan', false, err.message);
    return;
  }

  // Stop after duration
  setTimeout(() => {
    noble.stopScanning();
    noble.removeListener('discover', onDiscover);
    scanInProgress = false;
    console.log(`[BLE] Scan complete, found ${discovered.length} device(s)`);
    sendCommandResponse(commandId, 'ble_scan', true, null, { devices: discovered });
  }, duration);
}

// ── BLE Connect ─────────────────────────────────────────────────────────────
async function handleBleConnect(commandId, params) {
  const { deviceType, address } = params || {};
  if (!address) {
    sendCommandResponse(commandId, 'ble_connect', false, 'No address provided');
    return;
  }

  try {
    const peripheral = await findPeripheralByAddress(address);
    if (!peripheral) {
      sendCommandResponse(commandId, 'ble_connect', false, 'Device not found. Try scanning first.');
      return;
    }

    if (deviceType === 'treadmill') {
      await ftms.connect(peripheral);
      setupFtmsListeners();
      // Also connect FitShow FFF0 using pre-discovered characteristics
      try {
        await fitshow.connectWithCharacteristics(peripheral, ftms.getAllCharacteristics());
        setupFitshowListeners();
        console.log('[BLE] FitShow FFF0 protocol connected');
      } catch (e) {
        console.log('[BLE] FitShow FFF0 not available:', e.message);
      }
      config.treadmillAddress = address;
      saveConfig(config);
      ftmsReconnectDelay = 1000;
      sendCommandResponse(commandId, 'ble_connect', true, null, { deviceType: 'treadmill', name: peripheral.advertisement.localName, fitshow: fitshow.isConnected() });
    } else if (deviceType === 'hrm') {
      await hrm.connect(peripheral);
      setupHrmListeners();
      config.hrmAddress = address;
      saveConfig(config);
      hrmReconnectDelay = 1000;
      sendCommandResponse(commandId, 'ble_connect', true, null, { deviceType: 'hrm', name: peripheral.advertisement.localName });
    } else {
      sendCommandResponse(commandId, 'ble_connect', false, 'Unknown device type');
    }
  } catch (err) {
    console.error(`[BLE] Connect failed (${deviceType}):`, err.message);
    sendCommandResponse(commandId, 'ble_connect', false, err.message);
  }
}

async function findPeripheralByAddress(address) {
  const addr = address.toLowerCase();

  // Ensure powered on
  if (noble.state !== 'poweredOn') {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(), 5000);
      noble.once('stateChange', () => { clearTimeout(timeout); resolve(); });
      if (noble.state === 'poweredOn') { clearTimeout(timeout); resolve(); }
    });
  }

  if (noble.state !== 'poweredOn') throw new Error('Bluetooth not powered on');

  return new Promise((resolve, reject) => {
    let found = null;
    const scanTimeout = setTimeout(() => {
      noble.stopScanning();
      noble.removeListener('discover', onDiscover);
      scanInProgress = false;
      if (found) resolve(found);
      else reject(new Error(`Device ${address} not found after scan`));
    }, 15000);

    const onDiscover = (peripheral) => {
      const pAddr = (peripheral.address || peripheral.id || '').toLowerCase();
      if (pAddr === addr) {
        found = peripheral;
        clearTimeout(scanTimeout);
        noble.stopScanning();
        noble.removeListener('discover', onDiscover);
        scanInProgress = false;
        resolve(peripheral);
      }
    };

    noble.on('discover', onDiscover);
    scanInProgress = true;
    noble.startScanning([], true, (err) => {
      if (err) {
        clearTimeout(scanTimeout);
        noble.removeListener('discover', onDiscover);
        scanInProgress = false;
        reject(err);
      }
    });
  });
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
async function handleBleReconnect(commandId, params) {
  const { deviceType } = params || {};
  try {
    if (deviceType === 'treadmill' && config.treadmillAddress) {
      await reconnectFtms();
      sendCommandResponse(commandId, 'ble_reconnect', true, null, { deviceType: 'treadmill' });
    } else if (deviceType === 'hrm' && config.hrmAddress) {
      await reconnectHrm();
      sendCommandResponse(commandId, 'ble_reconnect', true, null, { deviceType: 'hrm' });
    } else {
      sendCommandResponse(commandId, 'ble_reconnect', false, 'No saved address');
    }
  } catch (err) {
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
      dataBuffer.push({
        speed_kmh: data.speed_kmh || 0,
        incline_percent: data.incline_percent || 0,
        distance_km: data.total_distance_m ? data.total_distance_m / 1000 : 0,
        heart_rate: hrm.getCurrentHeartRate() || null,
        calories: data.total_energy_kcal || null,
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

    // On FTMS stopped (0x02) + active session → auto-stop
    if (statusCode === 0x02 && sessionActive) {
      console.log('[Service] Treadmill stopped — auto-stopping session');
      handleStopSession('physical-stop', {});
    }
  });

  ftms.on('disconnect', () => {
    console.log('[Service] FTMS disconnected — scheduling reconnect');
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
function scheduleReconnect(deviceType) {
  if (deviceType === 'treadmill' && config.treadmillAddress) {
    const delay = ftmsReconnectDelay;
    console.log(`[BLE] Treadmill reconnect in ${delay / 1000}s...`);
    setTimeout(async () => {
      try {
        await reconnectFtms();
        ftmsReconnectDelay = 1000; // reset on success
      } catch (err) {
        console.error('[BLE] Treadmill reconnect failed:', err.message);
        ftmsReconnectDelay = Math.min(ftmsReconnectDelay * 2, BLE_MAX_RECONNECT);
        scheduleReconnect('treadmill');
      }
    }, delay);
    ftmsReconnectDelay = Math.min(ftmsReconnectDelay * 2, BLE_MAX_RECONNECT);
  }

  if (deviceType === 'hrm' && config.hrmAddress) {
    const delay = hrmReconnectDelay;
    console.log(`[BLE] HRM reconnect in ${delay / 1000}s...`);
    setTimeout(async () => {
      try {
        await reconnectHrm();
        hrmReconnectDelay = 1000; // reset on success
      } catch (err) {
        console.error('[BLE] HRM reconnect failed:', err.message);
        hrmReconnectDelay = Math.min(hrmReconnectDelay * 2, BLE_MAX_RECONNECT);
        scheduleReconnect('hrm');
      }
    }, delay);
    hrmReconnectDelay = Math.min(hrmReconnectDelay * 2, BLE_MAX_RECONNECT);
  }
}

async function reconnectFtms() {
  if (ftms.isConnected()) return;
  if (!config.treadmillAddress) throw new Error('No treadmill address saved');
  const peripheral = await findPeripheralByAddress(config.treadmillAddress);
  await ftms.connect(peripheral);
  setupFtmsListeners();
  try {
    await fitshow.connectWithCharacteristics(peripheral, ftms.getAllCharacteristics());
    setupFitshowListeners();
    console.log('[BLE] FitShow reconnected');
  } catch (e) {
    console.log('[BLE] FitShow reconnect skipped:', e.message);
  }
  broadcastDeviceStatus();
  console.log('[BLE] Treadmill reconnected');
}

async function reconnectHrm() {
  if (hrm.isConnected()) return;
  if (!config.hrmAddress) throw new Error('No HRM address saved');
  const peripheral = await findPeripheralByAddress(config.hrmAddress);
  await hrm.connect(peripheral);
  setupHrmListeners();
  broadcastDeviceStatus();
  console.log('[BLE] HRM reconnected');
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

  try {
    const body = {
      workout_id: currentWorkout ? currentWorkout.id : null,
      heart_rate_source: hrm.isConnected() ? 'ble' : 'none'
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

    console.log(`[Session] Started session ${sessionId}`);

    startDataFlush();
    startDriftDetection();

    if (currentWorkout && currentWorkout.segments && currentWorkout.segments.length > 0) {
      currentSegmentIndex = 0;
      executeSegment(currentSegmentIndex);
    }

    sendCommandResponse(commandId, 'start_session', true);
  } catch (err) {
    console.error('[Session] Failed to start session:', err.message);
    sendCommandResponse(commandId, 'start_session', false, err.message);
  }
}

async function handleStopSession(commandId, params) {
  if (!sessionActive) {
    sendCommandResponse(commandId, 'stop_session', false, 'No active session');
    return;
  }

  stopSegmentTimer();
  stopDataFlush();
  stopDriftDetection();

  await flushDataBuffer();

  const elapsed = sessionStartTime ? Math.floor((Date.now() - sessionStartTime) / 1000) : 0;
  try {
    await fetch(`${httpBase()}/api/sessions/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        total_distance_km: 0,
        total_time_seconds: elapsed,
        avg_heart_rate: null,
        calories_burned: 0
      })
    });
    console.log(`[Session] Session ${sessionId} completed (${elapsed}s)`);
  } catch (err) {
    console.error('[Session] Failed to complete session:', err.message);
  }

  wsSend({ type: 'treadmill_state', timestamp: Date.now(), sessionActive: false });

  sessionActive = false;
  sessionId = null;
  sessionStartTime = null;
  currentWorkout = null;
  currentSegmentIndex = 0;
  currentTargetSpeed = 0;
  currentTargetIncline = 0;

  sendCommandResponse(commandId, 'stop_session', true);
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

// ── Segment Execution ───────────────────────────────────────────────────────
async function executeSegment(index) {
  if (!currentWorkout || !currentWorkout.segments || index >= currentWorkout.segments.length) {
    console.log('[Session] All segments complete — stopping session');
    handleStopSession('auto-complete', {});
    return;
  }

  const segment = currentWorkout.segments[index];
  currentTargetSpeed = segment.speed_kmh;
  currentTargetIncline = segment.incline_percent || 0;
  segmentStartTime = Date.now();

  console.log(`[Session] Segment ${index}: "${segment.segment_name || 'unnamed'}" — ${currentTargetSpeed} km/h, ${currentTargetIncline}% for ${segment.duration_seconds}s`);

  // Send commands to treadmill
  if (ftms.isConnected()) {
    try {
      await ftms.setSpeed(currentTargetSpeed);
      await ftms.setIncline(currentTargetIncline);
    } catch (err) {
      console.error('[Session] Failed to set segment targets:', err.message);
    }
  }

  // Set timer for segment duration
  stopSegmentTimer();
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

  // Wait for Bluetooth to be ready
  if (noble.state !== 'poweredOn') {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(), 10000);
      noble.once('stateChange', (state) => {
        clearTimeout(timeout);
        resolve();
      });
      if (noble.state === 'poweredOn') { clearTimeout(timeout); resolve(); }
    });
  }

  if (noble.state !== 'poweredOn') {
    console.log('[BLE] Bluetooth not available, skipping auto-connect');
    return;
  }

  if (config.treadmillAddress) {
    console.log(`[BLE] Auto-connecting to treadmill: ${config.treadmillAddress}`);
    try {
      await reconnectFtms();
    } catch (err) {
      console.error('[BLE] Treadmill auto-connect failed:', err.message);
      scheduleReconnect('treadmill');
    }
  }

  if (config.hrmAddress) {
    console.log(`[BLE] Auto-connecting to HRM: ${config.hrmAddress}`);
    try {
      await reconnectHrm();
    } catch (err) {
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

// Auto-connect to BLE devices
noble.on('stateChange', (state) => {
  console.log(`[BLE] Adapter state: ${state}`);
  if (state === 'poweredOn') {
    autoConnect();
  }
});

// If already powered on
if (noble.state === 'poweredOn') {
  autoConnect();
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[Service] Shutting down...');
  stopStateBroadcast();
  stopDataFlush();
  stopDriftDetection();
  stopSegmentTimer();
  ftms.disconnect();
  hrm.disconnect();
  if (ws) ws.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Service] Terminated');
  ftms.disconnect();
  hrm.disconnect();
  if (ws) ws.close();
  process.exit(0);
});
