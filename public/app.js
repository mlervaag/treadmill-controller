// HTML escape utility to prevent XSS in innerHTML
function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Global state
let treadmill = null;
let currentSession = null;
let currentWorkout = null;
let loadedWorkout = null; // Workout loaded but not started
let workoutTimer = null;
let currentSegmentIndex = 0;
let segmentTimeRemaining = 0;
let sessionStartTime = null;
let currentViewMode = 'focus';
let localTimeTimer = null;
let localElapsedTime = 0;
let isRunning = false;
let currentHistoryView = 'historyOverview';
// Removed: currentWorkoutView - simplified to single list view
let allWorkouts = [];
let sessionData = {
    distance: 0,
    time: 0,
    heartRates: [],
    calories: 0
};
let hrm = null; // Heart Rate Monitor instance
let hrmHeartRate = null; // Current HR from HRM

// Data recording buffer for retry on failure
let dataBuffer = [];
let isFlushingBuffer = false;
let consecutiveFailures = 0;
const MAX_BUFFER_SIZE = 300; // 5 min of data at 1/sec

// Manual override tracking for drift detection
let lastManualOverrideTime = 0;
const MANUAL_OVERRIDE_COOLDOWN = 15000; // 15s pause after manual change
let treadmillHeartRate = null; // Current HR from treadmill
let activeHeartRateSource = 'none'; // 'hrm', 'treadmill', or 'none'
let driftCheckTimer = null;
let currentTargetSpeed = null;
let currentTargetIncline = null;
let quickAccessInitialized = false;
let stateBroadcastWs = null;
let stateBroadcastTimer = null;
let deviceStatusTimer = null;

// Session graph (Chart.js)
let sessionChart = null;

// Sound alerts
let soundAlertsEnabled = localStorage.getItem('soundAlerts') !== 'false';

// Workout editing
let editingWorkoutId = null;

// Auto BLE reconnect
let shouldAutoReconnect = localStorage.getItem('autoReconnect') !== 'false';
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let reconnectTimer = null;

function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-visible'));
    setTimeout(() => {
        toast.classList.remove('toast-visible');
        toast.addEventListener('transitionend', () => toast.remove());
    }, duration);
}

// Profile state
let allProfiles = [];
let activeProfileFilterId = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    setupEventListeners();
    setupQuickAccessModals();
    loadWorkouts();
    initStateBroadcast();
    loadProfilesForUI().then(() => loadSessions());
    loadOverallStats();
    updateLoadedWorkoutUI(); // Initialize loaded workout UI

    // Check if Web Bluetooth is supported
    checkBluetoothSupport();

    // Check Strava connection status
    checkStravaConnection();

    // Sound alerts toggle
    const soundToggle = document.getElementById('soundToggle');
    if (soundToggle) {
        soundToggle.checked = soundAlertsEnabled;
        soundToggle.addEventListener('change', () => {
            soundAlertsEnabled = soundToggle.checked;
            localStorage.setItem('soundAlerts', soundAlertsEnabled ? 'true' : 'false');
        });
    }

    // Auto reconnect toggle
    const autoReconnectToggle = document.getElementById('autoReconnectToggle');
    if (autoReconnectToggle) {
        autoReconnectToggle.checked = shouldAutoReconnect;
        autoReconnectToggle.addEventListener('change', () => {
            shouldAutoReconnect = autoReconnectToggle.checked;
            localStorage.setItem('autoReconnect', shouldAutoReconnect ? 'true' : 'false');
        });
    }
});

function setupTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.dataset.tab;

            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(tabName).classList.add('active');
        });
    });
}

function checkBluetoothSupport() {
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const isHTTPS = window.location.protocol === 'https:';

    if (!navigator.bluetooth) {
        const errorMsg = document.createElement('div');
        errorMsg.style.cssText = 'background: #ef4444; color: white; padding: 16px; margin: 16px; border-radius: 8px; font-weight: bold;';

        if (!isLocalhost && !isHTTPS) {
            errorMsg.innerHTML = `
                <h3 style="margin-top: 0;">⚠️ Web Bluetooth krever localhost eller HTTPS</h3>
                <p>Du har åpnet appen via IP-adresse (${window.location.host}), som ikke støtter Web Bluetooth.</p>
                <h4>Løsning:</h4>
                <ol style="text-align: left; margin-bottom: 0;">
                    <li>Sørg for at du bruker <strong>HTTPS</strong> hvis du ikke er på localhost.</li>
                    <li>Sjekk dokumentasjonen for hvordan aktivere HTTPS (sertifikater).</li>
                </ol>
                <p style="margin-bottom: 0;"><small>Se README.md for detaljer</small></p>
            `;
        } else {
            errorMsg.innerHTML = `
                <h3 style="margin-top: 0;">❌ Web Bluetooth ikke støttet</h3>
                <p>Vennligst bruk Chrome, Edge, eller Opera på Windows/Mac/Linux/Android.</p>
                <p style="margin-bottom: 0;"><small>Safari og iOS støtter ikke Web Bluetooth</small></p>
            `;
        }

        document.querySelector('.container').insertBefore(errorMsg, document.querySelector('.container').firstChild);

        // Disable bluetooth buttons
        document.getElementById('connectBtn').disabled = true;
        document.getElementById('scanAllBtn').disabled = true;
    }
}

function setupEventListeners() {
    document.getElementById('connectBtn').addEventListener('click', () => connectToTreadmill(false));
    document.getElementById('scanAllBtn').addEventListener('click', () => connectToTreadmill(true));
    document.getElementById('discoverBtn').addEventListener('click', discoverDeviceInfo);
    document.getElementById('connectHRMBtn').addEventListener('click', connectHRM);
}

async function connectToTreadmill(acceptAllDevices = false) {
    const btn = document.getElementById('connectBtn');
    const status = document.getElementById('connectionStatus');

    if (treadmill && treadmill.isConnected()) {
        treadmill.disconnect();
        treadmill = null;
        btn.textContent = 'Koble til Tredemølle';
        status.textContent = 'Ikke tilkoblet';
        status.className = 'status-disconnected';
        disableControls();
        return;
    }

    try {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Kobler til...';

        treadmill = new TreadmillController();

        // Set up data callback
        treadmill.onData((data) => {
            updateStats(data);
            if (currentSession) {
                recordSessionData(data);
            } else {
                console.warn('Data received but no active session (currentSession is null)');
            }
        });

        // Set up status callback (isAppInitiated = true when status is response to our command)
        treadmill.onStatus((status, code, isAppInitiated) => {
            console.log('Treadmill status:', status, isAppInitiated ? '(app-initiated)' : '');
            handleTreadmillStatus(status, code, isAppInitiated);
        });

        await treadmill.connect(acceptAllDevices);

        btn.textContent = 'Koble fra';
        status.textContent = 'Tilkoblet';
        status.className = 'status-connected';
        enableControls();

        treadmill.device.addEventListener('gattserverdisconnected', () => {
            console.log('Treadmill disconnected');
            stopDriftDetection();
            // Do NOT stop broadcast or timer — keep session alive during reconnect
            // stopStateBroadcast();
            // stopLocalTimer();
            if (workoutTimer) {
                clearInterval(workoutTimer);
                workoutTimer = null;
            }
            document.getElementById('connectionStatus').textContent = 'Frakoblet';
            document.getElementById('connectionStatus').className = 'status-disconnected';
            document.getElementById('connectBtn').textContent = 'Koble til Tredemølle';
            document.getElementById('connectBtn').disabled = false;

            if (currentSession) {
                // Session is active — keep timer running, show reconnect message
                showToast('Tredemølle frakoblet — forsøker gjentilkobling. Økt pågår fortsatt.', 'error', 8000);
                pauseLocalTimer(); // Pause timer during disconnect (treadmill isn't running)
            } else {
                showToast('Tredemølle frakoblet', 'error');
                stopStateBroadcast();
                stopLocalTimer();
            }

            // Auto reconnect if enabled
            if (shouldAutoReconnect) {
                reconnectAttempts = 0;
                setTimeout(() => attemptReconnect(), 2000);
            }
        });

    } catch (error) {
        console.error('Connection error:', error);
        alert('Kunne ikke koble til tredemølle: ' + error.message);
        btn.textContent = '📱 Koble til Tredemølle';
        btn.disabled = false;
    }
}

function updateStats(data) {
    // Update overview mode
    if (data.speed_kmh !== undefined) {
        document.getElementById('currentSpeed').textContent = data.speed_kmh.toFixed(1);
        document.getElementById('focusSpeed').textContent = data.speed_kmh.toFixed(1);
        document.getElementById('minimalSpeed').textContent = data.speed_kmh.toFixed(1);
    }
    if (data.incline_percent !== undefined) {
        document.getElementById('currentIncline').textContent = data.incline_percent.toFixed(1);
        document.getElementById('focusIncline').textContent = data.incline_percent.toFixed(0) + '%';
    }
    if (data.total_distance_m !== undefined) {
        const distanceKm = data.total_distance_m / 1000;
        document.getElementById('currentDistance').textContent = distanceKm.toFixed(2);
        document.getElementById('focusDistance').textContent = distanceKm.toFixed(2) + ' km';
        document.getElementById('minimalDistance').textContent = distanceKm.toFixed(2);
        sessionData.distance = distanceKm;
    }

    // Time: Use treadmill time if available, otherwise use local timer
    if (data.elapsed_time_s !== undefined) {
        // Treadmill provides time
        const minutes = Math.floor(data.elapsed_time_s / 60);
        const seconds = data.elapsed_time_s % 60;
        const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        document.getElementById('currentTime').textContent = timeStr;
        document.getElementById('focusTime').textContent = timeStr;
        document.getElementById('minimalTime').textContent = timeStr;
        sessionData.time = data.elapsed_time_s;

        // Sync local timer with treadmill time
        localElapsedTime = data.elapsed_time_s;
    }
    // If treadmill doesn't provide time, updateLocalTime() will handle it

    // Heart rate: Track treadmill heart rate and update display with prioritized source
    if (data.heart_rate !== undefined) {
        const isValidHR = data.heart_rate > 0 && data.heart_rate < 255;
        treadmillHeartRate = isValidHR ? data.heart_rate : null;
        updateHeartRateSource();
        updateHeartRateDisplay();
    }
    if (data.total_energy_kcal !== undefined) {
        const kcal = Math.round(data.total_energy_kcal);
        document.getElementById('currentCalories').textContent = kcal + ' kcal';
        document.getElementById('focusCalories').textContent = kcal + ' kcal';
        sessionData.calories = Math.round(data.total_energy_kcal);
    }
    if (data.power_watts !== undefined) {
        document.getElementById('currentPower').textContent = data.power_watts;
    }
}

function updateLocalTime() {
    if (!isRunning) return;

    localElapsedTime++;
    sessionData.time = localElapsedTime;

    const minutes = Math.floor(localElapsedTime / 60);
    const seconds = localElapsedTime % 60;
    const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    document.getElementById('currentTime').textContent = timeStr;
    document.getElementById('focusTime').textContent = timeStr;
    document.getElementById('minimalTime').textContent = timeStr;
}

function startLocalTimer() {
    if (localTimeTimer) {
        clearInterval(localTimeTimer);
    }
    isRunning = true;
    localTimeTimer = setInterval(updateLocalTime, 1000);
}

function pauseLocalTimer() {
    isRunning = false;
}

function stopLocalTimer() {
    if (localTimeTimer) {
        clearInterval(localTimeTimer);
        localTimeTimer = null;
    }
    isRunning = false;
}

function resetLocalTimer() {
    stopLocalTimer();
    localElapsedTime = 0;
    const timeStr = '00:00';
    document.getElementById('currentTime').textContent = timeStr;
    document.getElementById('focusTime').textContent = timeStr;
    document.getElementById('minimalTime').textContent = timeStr;
}

function setViewMode(mode) {
    currentViewMode = mode;

    // Update button states
    document.querySelectorAll('.view-mode-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-mode="${mode}"]`).classList.add('active');

    // Update view visibility
    document.querySelectorAll('.focus-view, .overview-view, .minimal-view').forEach(view => {
        view.classList.remove('active-view');
    });

    if (mode === 'focus') {
        document.getElementById('focusView').classList.add('active-view');
    } else if (mode === 'overview') {
        document.getElementById('overviewView').classList.add('active-view');
    } else if (mode === 'minimal') {
        document.getElementById('minimalView').classList.add('active-view');
    }
}

function recordSessionData(data) {
    // Only record valid heart rate (not 0 or 255)
    const validHR = (data.heart_rate && data.heart_rate > 0 && data.heart_rate < 255) ? data.heart_rate : null;

    // Only record calories if present and valid
    const validCalories = (data.total_energy_kcal && data.total_energy_kcal > 0) ? Math.round(data.total_energy_kcal) : null;

    const dataBody = {
        speed_kmh: data.speed_kmh,
        incline_percent: data.incline_percent,
        distance_km: data.total_distance_m ? data.total_distance_m / 1000 : null,
        heart_rate: validHR,
        calories: validCalories
    };

    // Include segment index if a structured workout is active
    if (currentWorkout && currentSegmentIndex !== undefined) {
        dataBody.segment_index = currentSegmentIndex;
    }

    // Buffer data point and flush asynchronously
    dataBuffer.push(dataBody);

    // Trim buffer if too large (keep newest data)
    if (dataBuffer.length > MAX_BUFFER_SIZE) {
        console.warn(`Data buffer overflow (${dataBuffer.length}), dropping oldest points`);
        dataBuffer = dataBuffer.slice(-MAX_BUFFER_SIZE);
    }

    flushDataBuffer();
}

async function flushDataBuffer() {
    if (isFlushingBuffer || dataBuffer.length === 0 || !currentSession) return;
    isFlushingBuffer = true;

    try {
        while (dataBuffer.length > 0) {
            const item = dataBuffer[0];
            try {
                const resp = await fetch(`/api/sessions/${currentSession}/data`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(item)
                });

                if (!resp.ok) {
                    const errText = await resp.text().catch(() => 'unknown');
                    console.error(`Session data rejected (${resp.status}):`, errText, JSON.stringify(item));

                    // 4xx = bad data, skip it and continue with next
                    if (resp.status >= 400 && resp.status < 500) {
                        dataBuffer.shift();
                        continue;
                    }
                    // 5xx = server error, stop and retry later
                    consecutiveFailures++;
                    break;
                }

                // Success
                dataBuffer.shift();
                if (consecutiveFailures > 0) {
                    consecutiveFailures = 0;
                    console.log(`Data recording recovered, buffer: ${dataBuffer.length} remaining`);
                }
            } catch (networkErr) {
                // Network failure — keep item in buffer for retry
                consecutiveFailures++;
                console.error(`Network error recording data (attempt ${consecutiveFailures}):`, networkErr.message);

                if (consecutiveFailures === 5) {
                    showToast('Problemer med datalagring — prøver på nytt...', 'error', 5000);
                }
                if (consecutiveFailures >= 15) {
                    showToast('Kan ikke lagre treningsdata. Sjekk nettverkstilkobling.', 'error', 10000);
                    consecutiveFailures = 0; // Reset to avoid spamming
                }
                break; // Stop flushing, retry on next data point
            }
        }
    } finally {
        isFlushingBuffer = false;
    }

    // If there's still data in buffer, schedule a retry
    if (dataBuffer.length > 0 && currentSession) {
        setTimeout(() => flushDataBuffer(), 2000);
    }
}

function enableControls() {
    document.getElementById('startBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = false;
    document.getElementById('stopBtn').disabled = false;
    document.getElementById('resetBtn').disabled = false;
    document.getElementById('speedInput').disabled = false;
    document.getElementById('inclineInput').disabled = false;
    document.getElementById('discoverBtn').disabled = false;
}

function disableControls() {
    document.getElementById('startBtn').disabled = true;
    document.getElementById('pauseBtn').disabled = true;
    document.getElementById('stopBtn').disabled = true;
    document.getElementById('resetBtn').disabled = true;
    document.getElementById('speedInput').disabled = true;
    document.getElementById('inclineInput').disabled = true;
    document.getElementById('discoverBtn').disabled = true;
}

async function discoverDeviceInfo() {
    if (!treadmill || !treadmill.isConnected()) {
        alert('Ikke tilkoblet tredemølle');
        return;
    }

    try {
        const btn = document.getElementById('discoverBtn');
        btn.disabled = true;
        btn.textContent = 'Skanner...';

        const deviceInfo = await treadmill.discoverServices();

        // Create a formatted display
        let info = `Enhet: ${deviceInfo.name}\n`;
        info += `ID: ${deviceInfo.id}\n\n`;
        info += `Funnet ${deviceInfo.services.length} services:\n\n`;

        deviceInfo.services.forEach(service => {
            const serviceName = treadmill.getServiceName(service.uuid);
            info += `📡 Service: ${serviceName}\n`;
            info += `   UUID: ${service.uuid}\n`;
            info += `   Characteristics: ${service.characteristics.length}\n\n`;

            service.characteristics.forEach(char => {
                const charName = treadmill.getCharacteristicName(char.uuid);
                info += `   📊 ${charName}\n`;
                info += `      UUID: ${char.uuid}\n`;

                const props = [];
                if (char.properties.read) props.push('Read');
                if (char.properties.write) props.push('Write');
                if (char.properties.writeWithoutResponse) props.push('Write w/o Response');
                if (char.properties.notify) props.push('Notify');
                if (char.properties.indicate) props.push('Indicate');

                info += `      Properties: ${props.join(', ')}\n`;

                if (char.value) {
                    info += `      Value: ${char.value}\n`;
                }
                info += '\n';
            });
        });

        // Display in console for easy copying
        console.log('=== DEVICE INFORMATION ===');
        console.log(info);
        console.log('=== RAW DATA ===');
        console.log(JSON.stringify(deviceInfo, null, 2));

        // Show in alert (limited, but works)
        alert('Enhetsinformasjon er logget i konsollen! Trykk F12 for å se detaljene.\n\n' +
            info.substring(0, 500) + (info.length > 500 ? '...\n\n(Se konsoll for fullstendig info)' : ''));

        btn.textContent = 'Vis enhetsinformasjon';
        btn.disabled = false;

    } catch (error) {
        console.error('Error discovering device info:', error);
        alert('Kunne ikke hente enhetsinformasjon: ' + error.message);
        document.getElementById('discoverBtn').textContent = 'Vis enhetsinformasjon';
        document.getElementById('discoverBtn').disabled = false;
    }
}

async function startTreadmill() {
    if (!treadmill) return;
    try {
        await treadmill.start();
        startLocalTimer(); // Start local timer
        if (!currentSession) {
            await startSession();
        }
    } catch (error) {
        alert('Kunne ikke starte tredemølle: ' + error.message);
    }
}

async function pauseTreadmill() {
    if (!treadmill) return;
    try {
        await treadmill.pause();
        pauseLocalTimer(); // Pause local timer
    } catch (error) {
        alert('Kunne ikke pause tredemølle: ' + error.message);
    }
}

async function stopTreadmill() {
    if (!treadmill) return;
    try {
        await treadmill.stop();
        stopLocalTimer();
        stopDriftDetection();
        if (currentSession) {
            await endSession();
        }
        if (workoutTimer) {
            clearInterval(workoutTimer);
            workoutTimer = null;
        }
        document.getElementById('workoutProgress').classList.add('hidden');
    } catch (error) {
        alert('Kunne ikke stoppe tredemølle: ' + error.message);
    }
}

function startDriftDetection() {
    stopDriftDetection();
    driftCheckTimer = setInterval(async () => {
        if (!treadmill || !treadmill.isConnected() || !currentWorkout) return;
        if (currentTargetSpeed === null) return;

        // Respect manual override cooldown — user changed speed/incline on treadmill
        if (Date.now() - lastManualOverrideTime < MANUAL_OVERRIDE_COOLDOWN) {
            console.log('Drift check skipped — manual override cooldown active');
            return;
        }

        const actualSpeed = treadmill.getLastReportedSpeed();
        const actualIncline = treadmill.getLastReportedIncline();

        // Update actual display
        const verificationEl = document.getElementById('segmentVerification');
        if (verificationEl) {
            verificationEl.style.display = 'block';
            document.getElementById('actualSpeedDisplay').textContent = actualSpeed !== null ? actualSpeed.toFixed(1) : '--';
            document.getElementById('actualInclineDisplay').textContent = actualIncline !== null ? actualIncline.toFixed(1) : '--';
        }

        if (actualSpeed !== null && Math.abs(actualSpeed - currentTargetSpeed) > 0.3) {
            console.warn(`Speed drift: target=${currentTargetSpeed}, actual=${actualSpeed}. Re-sending.`);
            try { await treadmill.setSpeed(currentTargetSpeed); } catch (e) { console.error('Drift correction failed:', e); }
        }

        if (actualIncline !== null && Math.abs(actualIncline - currentTargetIncline) > 0.5) {
            console.warn(`Incline drift: target=${currentTargetIncline}, actual=${actualIncline}. Re-sending.`);
            try { await treadmill.setIncline(currentTargetIncline); } catch (e) { console.error('Drift correction failed:', e); }
        }
    }, 8000);
}

function stopDriftDetection() {
    if (driftCheckTimer) {
        clearInterval(driftCheckTimer);
        driftCheckTimer = null;
    }
    currentTargetSpeed = null;
    currentTargetIncline = null;
    const verificationEl = document.getElementById('segmentVerification');
    if (verificationEl) verificationEl.style.display = 'none';
}

// --- WebSocket State Broadcast for View-Only Clients ---
function buildCurrentState() {
    let hr = null;
    if (hrmHeartRate !== null && hrmHeartRate > 0) {
        hr = hrmHeartRate;
    } else if (treadmillHeartRate !== null && treadmillHeartRate > 0 && treadmillHeartRate < 255) {
        hr = treadmillHeartRate;
    }

    let workoutInfo = null;
    if (currentWorkout && currentWorkout.segments) {
        const segments = currentWorkout.segments;
        const totalDuration = segments.reduce((sum, s) => sum + s.duration_seconds, 0);
        const currentSeg = segments[currentSegmentIndex];
        const elapsedSegments = segments.slice(0, currentSegmentIndex).reduce((sum, s) => sum + s.duration_seconds, 0);
        const elapsedInCurrent = currentSeg ? currentSeg.duration_seconds - segmentTimeRemaining : 0;
        const elapsedInWorkout = elapsedSegments + elapsedInCurrent;

        workoutInfo = {
            workoutId: currentWorkout.id,
            name: currentWorkout.name,
            totalSegments: segments.length,
            currentSegmentIndex: currentSegmentIndex,
            currentSegment: currentSeg ? {
                name: currentSeg.segment_name || `Segment ${currentSegmentIndex + 1}`,
                targetSpeed: currentSeg.speed_kmh,
                targetIncline: currentSeg.incline_percent,
                durationSeconds: currentSeg.duration_seconds,
                timeRemaining: segmentTimeRemaining,
                targetZone: currentSeg.target_max_zone || null
            } : null,
            nextSegment: segments[currentSegmentIndex + 1] ? {
                name: segments[currentSegmentIndex + 1].segment_name || `Segment ${currentSegmentIndex + 2}`,
                targetSpeed: segments[currentSegmentIndex + 1].speed_kmh,
                targetIncline: segments[currentSegmentIndex + 1].incline_percent,
                durationSeconds: segments[currentSegmentIndex + 1].duration_seconds
            } : null,
            totalDuration: totalDuration,
            elapsedInWorkout: elapsedInWorkout,
            overallProgress: totalDuration > 0 ? (elapsedInWorkout / totalDuration) * 100 : 0
        };
    }

    return {
        type: 'treadmill_state',
        timestamp: Date.now(),
        sessionActive: !!currentSession,
        speed: treadmill ? treadmill.getLastReportedSpeed() : null,
        incline: treadmill ? treadmill.getLastReportedIncline() : null,
        heartRate: hr,
        heartRateSource: activeHeartRateSource,
        distance: sessionData.distance,
        elapsedTime: sessionData.time,
        calories: sessionData.calories,
        targetSpeed: currentTargetSpeed,
        targetIncline: currentTargetIncline,
        workout: workoutInfo
    };
}

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
        stateBroadcastWs.send(JSON.stringify({
            type: 'register',
            role: 'controller',
            bleBackend: 'browser'
        }));
        broadcastDeviceStatus();
        startStateBroadcastTimer();
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
        // Auto-reconnect always (connection must stay open for remote commands)
        setTimeout(initStateBroadcast, 3000);
    };

    stateBroadcastWs.onerror = () => {
        if (stateBroadcastWs) stateBroadcastWs.close();
    };
}

function startStateBroadcastTimer() {
    if (stateBroadcastTimer) clearInterval(stateBroadcastTimer);
    stateBroadcastTimer = setInterval(() => {
        if (!stateBroadcastWs || stateBroadcastWs.readyState !== WebSocket.OPEN) return;
        stateBroadcastWs.send(JSON.stringify(buildCurrentState()));
    }, 2000);
    // Send immediately
    if (stateBroadcastWs && stateBroadcastWs.readyState === WebSocket.OPEN) {
        stateBroadcastWs.send(JSON.stringify(buildCurrentState()));
    }
}

function stopStateBroadcast() {
    if (stateBroadcastTimer) {
        clearInterval(stateBroadcastTimer);
        stateBroadcastTimer = null;
    }
    // Send final state with sessionActive=false but keep WebSocket open for remote commands
    if (stateBroadcastWs && stateBroadcastWs.readyState === WebSocket.OPEN) {
        stateBroadcastWs.send(JSON.stringify({
            type: 'treadmill_state',
            timestamp: Date.now(),
            sessionActive: false
        }));
    }
}

function broadcastDeviceStatus() {
    if (deviceStatusTimer) {
        clearInterval(deviceStatusTimer);
        deviceStatusTimer = null;
    }
    const sendStatus = () => {
        if (!stateBroadcastWs || stateBroadcastWs.readyState !== WebSocket.OPEN) return;
        stateBroadcastWs.send(JSON.stringify({
            type: 'device_status',
            treadmill: (treadmill && treadmill.isConnected()) ? 'connected' : 'disconnected',
            hrm: (hrm && hrm.isConnected()) ? 'connected' : 'disconnected',
            bleBackend: 'browser'
        }));
    };
    sendStatus();
    deviceStatusTimer = setInterval(sendStatus, 5000);
}

async function handleRemoteCommand(data) {
    const { commandId, command, params } = data;
    console.log('Received remote command:', command, params);

    try {
        switch (command) {
            case 'load_workout': {
                const response = await fetch(`/api/workouts/${params.workoutId}`);
                if (!response.ok) throw new Error(`Failed to fetch workout: ${response.status}`);
                const workout = await response.json();
                loadedWorkout = workout;
                updateLoadedWorkoutUI();
                sendCommandResponse(commandId, command, true);
                break;
            }
            case 'start_session': {
                if (!loadedWorkout) {
                    sendCommandResponse(commandId, command, false, 'No workout loaded');
                    return;
                }
                if (!treadmill || !treadmill.isConnected()) {
                    sendCommandResponse(commandId, command, false, 'Treadmill not connected');
                    return;
                }
                try {
                    currentWorkout = loadedWorkout;
                    currentSegmentIndex = 0;

                    document.getElementById('workoutProgress').classList.remove('hidden');
                    document.getElementById('activeWorkoutName').textContent = currentWorkout.name;
                    document.getElementById('totalSegments').textContent = currentWorkout.segments.length;

                    buildWorkoutTimeline();

                    await startSession(loadedWorkout.id, params.profileId || null);
                    startLocalTimer();
                    await executeSegment(0);

                    loadedWorkout = null;
                    updateLoadedWorkoutUI();
                    sendCommandResponse(commandId, command, true, null, { workout_id: currentWorkout ? currentWorkout.id : null });
                } catch (error) {
                    console.error('Failed to start workout via remote:', error);
                    currentWorkout = null;
                    currentSegmentIndex = 0;
                    sendCommandResponse(commandId, command, false, error.message);
                }
                break;
            }
            case 'stop_session': {
                await stopWorkout(true);
                sendCommandResponse(commandId, command, true);
                break;
            }
            case 'skip_segment': {
                if (workoutTimer) {
                    clearInterval(workoutTimer);
                    workoutTimer = null;
                }
                await executeSegment(currentSegmentIndex + 1);
                sendCommandResponse(commandId, command, true);
                break;
            }
            default:
                sendCommandResponse(commandId, command, false, `Unknown command: ${command}`);
        }
    } catch (error) {
        console.error('Error handling remote command:', error);
        sendCommandResponse(commandId, command, false, error.message);
    }
}

function sendCommandResponse(commandId, command, success, error, data) {
    if (!stateBroadcastWs || stateBroadcastWs.readyState !== WebSocket.OPEN) return;
    const msg = { type: 'command_response', commandId, command, success };
    if (error) msg.error = error;
    if (data) msg.data = data;
    stateBroadcastWs.send(JSON.stringify(msg));
}

async function stopWorkout(autoStop = false) {
    if (!autoStop && !confirm('Er du sikker på at du vil avslutte økten?')) {
        return;
    }

    currentWorkout = null;
    currentSegmentIndex = 0;
    stopDriftDetection();

    if (workoutTimer) {
        clearInterval(workoutTimer);
        workoutTimer = null;
    }

    if (!autoStop) {
        await stopTreadmill();
    }
}

async function resetTreadmill() {
    if (!treadmill) return;
    try {
        await treadmill.reset();
        resetLocalTimer(); // Reset local timer
        resetStats();
    } catch (error) {
        alert('Kunne ikke resette tredemølle: ' + error.message);
    }
}

function resetStats() {
    document.getElementById('currentSpeed').textContent = '0.0';
    document.getElementById('focusSpeed').textContent = '0.0';
    document.getElementById('minimalSpeed').textContent = '0.0';
    document.getElementById('currentIncline').textContent = '0.0';
    document.getElementById('focusIncline').textContent = '0%';
    document.getElementById('currentDistance').textContent = '0.0';
    document.getElementById('focusDistance').textContent = '0.0 km';
    document.getElementById('minimalDistance').textContent = '0.0';
    document.getElementById('currentHR').textContent = '--';
    document.getElementById('focusHR').textContent = '-- bpm';
    document.getElementById('minimalHR').textContent = '--';
    document.getElementById('currentCalories').textContent = '0';
    document.getElementById('focusCalories').textContent = '0 kcal';
    document.getElementById('currentPower').textContent = '0';
    sessionData = { distance: 0, time: 0, heartRates: [], calories: 0 };

    // Show HR containers again (they might have been hidden)
    const hrContainers = [
        document.getElementById('currentHR')?.closest('.stat-card'),
        document.getElementById('focusHR')?.closest('.stat-card'),
        document.getElementById('minimalHR')?.closest('.minimal-stat-small')
    ];
    hrContainers.forEach(container => {
        if (container) container.style.display = '';
    });
}

function adjustSpeed(delta) {
    const input = document.getElementById('speedInput');
    const newValue = parseFloat(input.value) + delta;
    // Treadmill supports 0.1 - 14.0 km/t
    input.value = Math.max(0.1, Math.min(14.0, newValue)).toFixed(1);
}

function adjustIncline(delta) {
    const input = document.getElementById('inclineInput');
    const newValue = parseFloat(input.value) + delta;
    // Treadmill supports 0 - 12% in 1% increments
    input.value = Math.max(0, Math.min(12, Math.round(newValue)));
}

async function setSpeed() {
    if (!treadmill) return;
    const speed = parseFloat(document.getElementById('speedInput').value);
    try {
        await treadmill.setSpeed(speed);
    } catch (error) {
        alert('Kunne ikke sette hastighet: ' + error.message);
    }
}

async function setIncline() {
    if (!treadmill) return;
    const incline = parseFloat(document.getElementById('inclineInput').value);
    try {
        await treadmill.setIncline(incline);
    } catch (error) {
        alert('Kunne ikke sette stigning: ' + error.message);
    }
}

// Workouts Management
async function loadWorkouts() {
    const workoutsList = document.getElementById('workoutsList');
    if (workoutsList) workoutsList.innerHTML = '<div class="loading-state"><span class="spinner"></span> Laster treningsøkter...</div>';

    try {
        const response = await fetch('/api/workouts');
        allWorkouts = await response.json();

        // Populate control panel dropdown
        const select = document.getElementById('workoutSelect');
        select.innerHTML = '<option value="">Manuell kontroll</option>';
        allWorkouts.forEach(workout => {
            const option = document.createElement('option');
            option.value = workout.id;
            option.textContent = workout.name;
            select.appendChild(option);
        });

        // Populate template dropdown in create form
        const templateSelect = document.getElementById('templateSelect');
        if (templateSelect) {
            templateSelect.innerHTML = '<option value="">-- Start fra scratch --</option>';
            allWorkouts.forEach(workout => {
                const option = document.createElement('option');
                option.value = workout.id;
                option.textContent = workout.name + (workout.is_template ? ' (mal)' : '');
                templateSelect.appendChild(option);
            });
        }

        populateFilterTags();
        applyFilters(); // This calls displayWorkouts()
    } catch (error) {
        console.error('Failed to load workouts:', error);
    }
}

// HR Zone filter state
let hrZoneFilterActive = false;

// Filtering Logic
let activeFilters = {
    difficulty: [],
    tags: [],
    maxDuration: 120
};

function toggleFilter() {
    const menu = document.getElementById('filterMenu');
    menu.classList.toggle('hidden');
    // Save state if needed, but simple toggle is fine
}

function updateDurationLabel() {
    const val = document.getElementById('filterDuration').value;
    document.getElementById('durationValue').textContent = val >= 120 ? 'Alt' : val;
}

function populateFilterTags() {
    const tagContainer = document.getElementById('tagFilters');
    tagContainer.innerHTML = '';

    // Extract all unique tags
    const allTags = new Set();
    allWorkouts.forEach(w => {
        if (w.tags && Array.isArray(w.tags)) {
            w.tags.forEach(t => allTags.add(t));
        }
    });

    const sortedTags = Array.from(allTags).sort();

    // Define categories for consistent ordering/grouping if desired, 
    // or just list them all. For now, simple list.
    sortedTags.forEach(tag => {
        const label = document.createElement('label');
        label.className = 'tag-checkbox';
        label.innerHTML = `
            <input type="checkbox" value="${tag}" onchange="applyFilters()">
            <span>${tag}</span>
        `;
        tagContainer.appendChild(label);
    });
}

function applyFilters() {
    // 1. Get selected difficulties
    const diffCheckboxes = document.querySelectorAll('.filter-difficulty:checked');
    const selectedDifficulties = Array.from(diffCheckboxes).map(cb => cb.value);

    // 2. Get selected tags
    const tagCheckboxes = document.querySelectorAll('#tagFilters input:checked');
    const selectedTags = Array.from(tagCheckboxes).map(cb => cb.value);

    // 3. Get max duration
    const durationInput = document.getElementById('filterDuration');
    const maxDuration = parseInt(durationInput.value);

    // Update UI state
    const indicator = document.getElementById('filterIndicator');
    const hasActiveFilters = selectedDifficulties.length > 0 || selectedTags.length > 0 || maxDuration < 120;

    if (indicator) {
        if (hasActiveFilters) {
            indicator.classList.remove('hidden');
            indicator.textContent = `(${selectedDifficulties.length + selectedTags.length + (maxDuration < 120 ? 1 : 0)})`;
        } else {
            indicator.classList.add('hidden');
        }
    }

    // Filter Logic
    const filteredWorkouts = allWorkouts.filter(workout => {
        // Difficulty Match (OR logic)
        if (selectedDifficulties.length > 0 && !selectedDifficulties.includes(workout.difficulty)) {
            return false;
        }

        // Duration Match (Les than or equal)
        // Backend returns total_duration_seconds. If missing, estimate from segment_count
        let durationMinutes = 0;
        if (workout.total_duration_seconds) {
            durationMinutes = workout.total_duration_seconds / 60;
        } else {
            // Fallback estimate: 3 mins per segment if data missing
            durationMinutes = workout.segment_count * 3;
        }

        // If maxDuration is < 120, we filter. If 120, we show all (120+)
        if (maxDuration < 120 && durationMinutes > maxDuration) {
            return false;
        }

        // Tag Match (AND logic - must contain ALL selected tags? OR logic - must contain ANY?
        // Usually Attribute filtering is AND across categories, OR within category.
        // Since we have a flat tag list for now, let's go with OR logic for simplicity (matches ANY selected tag).
        // If the user wants specific "Interval" AND "Hills", they might expect AND.
        // Let's stick to: If tags selected, workout must have AT LEAST ONE of them.
        if (selectedTags.length > 0) {
            if (!workout.tags || !workout.tags.some(tag => selectedTags.includes(tag))) {
                return false;
            }
        }

        // HR zone eligible filter
        if (hrZoneFilterActive && workout.hr_zone_eligible !== 1) {
            return false;
        }

        return true;
    });

    displayWorkouts(filteredWorkouts);
}

function toggleHRZoneFilter() {
    const checkbox = document.getElementById('hrZoneFilterBtn');
    hrZoneFilterActive = checkbox ? checkbox.checked : !hrZoneFilterActive;
    applyFilters();
}

function resetFilters() {
    // Uncheck all boxes
    document.querySelectorAll('.filter-difficulty, #tagFilters input').forEach(cb => cb.checked = false);

    // Reset slider
    document.getElementById('filterDuration').value = 120;
    document.getElementById('durationValue').textContent = 'Alt';

    // Reset HR zone filter
    hrZoneFilterActive = false;
    const hrBtn = document.getElementById('hrZoneFilterBtn');
    if (hrBtn) hrBtn.checked = false;

    applyFilters();
}

function displayWorkouts(workoutsToDisplay = allWorkouts) {
    const list = document.getElementById('workoutsList');
    list.innerHTML = '';

    if (workoutsToDisplay.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>Ingen treningsøkter funnet</p><p class="empty-state-hint">Opprett din første treningsøkt med knappen over</p></div>';
        return;
    }

    workoutsToDisplay.forEach(workout => {
        const card = createWorkoutCard(workout, workout.is_template);
        list.appendChild(card);
    });
}

function createWorkoutCard(workout, isTemplate) {
    const card = document.createElement('div');
    card.className = 'workout-card';
    if (isTemplate) {
        card.classList.add('template');
    }

    // Calculate total duration
    let totalMinutes = 'Ukjent';
    let totalDistanceStr = '';

    if (workout.total_duration_seconds) {
        totalMinutes = Math.round(workout.total_duration_seconds / 60) + ' min';
    } else if (workout.segment_count > 0) {
        totalMinutes = '~' + Math.round(workout.segment_count * 3) + ' min';
    }

    if (workout.total_distance_km) {
        totalDistanceStr = ` • ${workout.total_distance_km.toFixed(1)} km`;
    }

    // Difficulty badge
    const difficultyMap = {
        'beginner': 'Nybegynner',
        'intermediate': 'Middels',
        'advanced': 'Avansert'
    };
    const difficultyText = difficultyMap[workout.difficulty] || 'Nybegynner';

    // Tags
    let tagsHtml = '';
    if (workout.tags && Array.isArray(workout.tags) && workout.tags.length > 0) {
        tagsHtml = `<div class="workout-tags">
            ${workout.tags.map(tag => `<span class="tag-badge">${escapeHtml(tag)}</span>`).join('')}
        </div>`;
    }

    card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
            <h3>${escapeHtml(workout.name)}</h3>
            <span class="difficulty-badge ${escapeHtml(workout.difficulty || 'beginner')}">${escapeHtml(difficultyText)}</span>
        </div>
        <p>${escapeHtml(workout.description || 'Ingen beskrivelse')}</p>
        ${tagsHtml}
        <div class="workout-meta">
            <span>📋 ${workout.segment_count} segmenter</span>
            <span>⏱️ ${totalMinutes}${totalDistanceStr}</span>
        </div>
        <div class="workout-details" id="workoutDetails${workout.id}">
            <button class="btn-details" onclick="toggleWorkoutDetails(${workout.id})">Vis detaljer</button>
            <div class="workout-segments-preview" id="segmentsPreview${workout.id}"></div>
        </div>
        <div class="workout-actions">
            <button class="btn btn-primary" onclick="loadWorkoutFromCard(${workout.id})">Last økt</button>
            ${!isTemplate ? `<button class="btn btn-secondary" onclick="editWorkout(${workout.id})">Rediger</button>` : ''}
            ${!isTemplate ? `<button class="btn btn-danger" onclick="deleteWorkout(${workout.id})">Slett</button>` : ''}
        </div>
    `;

    return card;
}

async function toggleWorkoutDetails(workoutId) {
    const previewDiv = document.getElementById(`segmentsPreview${workoutId}`);
    const btn = event.target;

    if (previewDiv.classList.contains('expanded')) {
        previewDiv.classList.remove('expanded');
        btn.textContent = 'Vis detaljer';
    } else {
        // Load workout details if not already loaded
        if (previewDiv.innerHTML === '') {
            await loadWorkoutDetailsPreview(workoutId);
        }
        previewDiv.classList.add('expanded');
        btn.textContent = 'Skjul detaljer';
    }
}

async function loadWorkoutDetailsPreview(workoutId) {
    try {
        const response = await fetch(`/api/workouts/${workoutId}`);
        const workout = await response.json();

        const previewDiv = document.getElementById(`segmentsPreview${workoutId}`);
        previewDiv.innerHTML = '';

        if (workout.segments && workout.segments.length > 0) {
            workout.segments.forEach((segment, index) => {
                const segmentEl = document.createElement('div');
                segmentEl.className = 'segment-preview';
                segmentEl.innerHTML = `
                    <span class="segment-preview-name">${escapeHtml(segment.segment_name || `Segment ${index + 1}`)}</span>
                    <div class="segment-preview-stats">
                        <span>⏱️ ${Math.round(segment.duration_seconds / 60)} min</span>
                        <span>🏃 ${segment.speed_kmh} km/t</span>
                        <span>⛰️ ${segment.incline_percent}%</span>
                    </div>
                `;
                previewDiv.appendChild(segmentEl);
            });
        }
    } catch (error) {
        console.error('Failed to load workout details:', error);
    }
}

function showCreateWorkout() {
    document.getElementById('createWorkoutForm').classList.remove('hidden');
    document.getElementById('workoutsListView').classList.add('hidden');
    document.getElementById('templateSelect').value = '';
    document.getElementById('segmentsList').innerHTML = '';
    document.getElementById('workoutName').value = '';
    document.getElementById('workoutDescription').value = '';
    document.getElementById('workoutDifficulty').value = 'beginner';
    addSegment();
    updateWorkoutSummary();
}

function cancelCreateWorkout() {
    editingWorkoutId = null;
    const formTitle = document.querySelector('#createWorkoutForm .form-header h3');
    if (formTitle) formTitle.textContent = 'Lag ny treningsøkt';
    document.getElementById('createWorkoutForm').classList.add('hidden');
    document.getElementById('workoutsListView').classList.remove('hidden');
}

async function loadTemplateData() {
    const templateId = document.getElementById('templateSelect').value;

    if (!templateId) {
        // Reset form to empty
        document.getElementById('workoutName').value = '';
        document.getElementById('workoutDescription').value = '';
        document.getElementById('workoutDifficulty').value = 'beginner';
        document.getElementById('segmentsList').innerHTML = '';
        addSegment();
        updateWorkoutSummary();
        return;
    }

    try {
        const response = await fetch(`/api/workouts/${templateId}`);
        const workout = await response.json();

        // Populate form with template data
        document.getElementById('workoutName').value = workout.name;
        document.getElementById('workoutDescription').value = workout.description || '';
        document.getElementById('workoutDifficulty').value = workout.difficulty || 'beginner';

        // Clear segments and add template segments
        document.getElementById('segmentsList').innerHTML = '';

        if (workout.segments && workout.segments.length > 0) {
            workout.segments.forEach(segment => {
                addSegment();
                const lastSegment = document.getElementById('segmentsList').lastElementChild;
                lastSegment.querySelector('.segment-name').value = segment.segment_name || '';
                lastSegment.querySelector('.segment-duration').value = Math.round(segment.duration_seconds / 60);
                lastSegment.querySelector('.segment-speed').value = segment.speed_kmh.toFixed(1);
                lastSegment.querySelector('.segment-incline').value = segment.incline_percent.toFixed(1);
            });
        } else {
            addSegment();
        }

        updateWorkoutSummary();
    } catch (error) {
        console.error('Failed to load template:', error);
        alert('Kunne ikke laste mal: ' + error.message);
    }
}

function updateWorkoutSummary() {
    const segments = document.querySelectorAll('.segment-item');

    if (segments.length === 0) {
        document.getElementById('workoutSummary').style.display = 'none';
        return;
    }

    document.getElementById('workoutSummary').style.display = 'block';

    let totalDuration = 0;
    let totalDistance = 0;
    let weightedSpeed = 0;

    segments.forEach(segment => {
        const duration = parseInt(segment.querySelector('.segment-duration').value) * 60 || 0;
        const speed = parseFloat(segment.querySelector('.segment-speed').value) || 0;

        totalDuration += duration;
        totalDistance += (speed * duration) / 3600; // km
        weightedSpeed += speed * duration;
    });

    const avgSpeed = totalDuration > 0 ? weightedSpeed / totalDuration : 0;

    document.getElementById('summaryDuration').textContent = Math.round(totalDuration / 60) + ' min';
    document.getElementById('summaryDistance').textContent = totalDistance.toFixed(2) + ' km';
    document.getElementById('summaryAvgSpeed').textContent = avgSpeed.toFixed(1) + ' km/t';
}

let segmentCounter = 0;

function addSegment() {
    const list = document.getElementById('segmentsList');
    const segmentId = segmentCounter++;

    const segment = document.createElement('div');
    segment.className = 'segment-item';
    segment.dataset.segmentId = segmentId;
    segment.innerHTML = `
        <div class="segment-header">
            <h4>Segment ${segmentId + 1}</h4>
            <button class="btn btn-danger btn-small" onclick="removeSegment(${segmentId})">Fjern</button>
        </div>
        <div class="form-group">
            <label>Navn (valgfritt)</label>
            <input type="text" class="segment-name" placeholder="F.eks. Oppvarming">
        </div>
        <div class="segment-fields">
            <div class="form-group">
                <label>Varighet (minutter)</label>
                <input type="number" class="segment-duration" min="1" max="120" value="5" onchange="updateWorkoutSummary()">
            </div>
            <div class="form-group">
                <label>Hastighet (km/t)</label>
                <input type="number" class="segment-speed" min="0" max="14" step="0.5" value="8.0" onchange="updateWorkoutSummary()">
            </div>
            <div class="form-group">
                <label>Stigning (%)</label>
                <input type="number" class="segment-incline" min="0" max="12" step="0.5" value="0">
            </div>
        </div>
    `;
    list.appendChild(segment);
    updateWorkoutSummary();
}

function removeSegment(segmentId) {
    const segment = document.querySelector(`[data-segment-id="${segmentId}"]`);
    if (segment) {
        segment.remove();
        updateWorkoutSummary();
    }
}

async function saveWorkout() {
    const name = document.getElementById('workoutName').value.trim();
    const description = document.getElementById('workoutDescription').value.trim();
    const difficulty = document.getElementById('workoutDifficulty').value;

    if (!name) {
        alert('Vennligst gi økten et navn');
        document.getElementById('workoutName').focus();
        return;
    }

    if (name.length > 200) {
        alert('Navn kan ikke være lengre enn 200 tegn');
        document.getElementById('workoutName').focus();
        return;
    }

    const segmentElements = document.querySelectorAll('.segment-item');
    if (segmentElements.length === 0) {
        alert('Legg til minst ett segment');
        return;
    }

    // Validate all segments
    const segments = [];
    let isValid = true;

    for (const el of segmentElements) {
        const duration = parseInt(el.querySelector('.segment-duration').value);
        const speed = parseFloat(el.querySelector('.segment-speed').value);
        const incline = parseFloat(el.querySelector('.segment-incline').value);

        if (isNaN(duration) || duration < 1 || duration > 120) {
            alert('Varighet må være mellom 1 og 120 minutter');
            el.querySelector('.segment-duration').focus();
            isValid = false;
            break;
        }

        if (isNaN(speed) || speed < 0 || speed > 14) {
            alert('Hastighet må være mellom 0 og 14 km/t');
            el.querySelector('.segment-speed').focus();
            isValid = false;
            break;
        }

        if (isNaN(incline) || incline < 0 || incline > 12) {
            alert('Stigning må være mellom 0 og 12%');
            el.querySelector('.segment-incline').focus();
            isValid = false;
            break;
        }

        segments.push({
            duration_seconds: duration * 60,
            speed_kmh: speed,
            incline_percent: incline,
            segment_name: el.querySelector('.segment-name').value.trim()
        });
    }

    if (!isValid) return;

    try {
        let url = '/api/workouts';
        let method = 'POST';

        if (editingWorkoutId) {
            url = `/api/workouts/${editingWorkoutId}`;
            method = 'PUT';
        }

        const response = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description, difficulty, segments })
        });

        if (response.ok) {
            const wasEditing = !!editingWorkoutId;
            editingWorkoutId = null;
            // Reset form title
            const formTitle = document.querySelector('#createWorkoutForm .form-header h3');
            if (formTitle) formTitle.textContent = 'Lag ny treningsøkt';
            cancelCreateWorkout();
            await loadWorkouts();
            showToast(wasEditing ? 'Treningsøkt oppdatert!' : 'Treningsøkt lagret!', 'success');
        } else {
            const errorData = await response.json().catch(() => ({}));
            alert(errorData.error || 'Kunne ikke lagre økt');
        }
    } catch (error) {
        console.error('Error saving workout:', error);
        alert('Feil ved lagring: ' + error.message);
    }
}

async function deleteWorkout(id) {
    if (!confirm('Er du sikker på at du vil slette denne økten?')) return;

    try {
        await fetch(`/api/workouts/${id}`, { method: 'DELETE' });
        loadWorkouts();
        showToast('Treningsøkt slettet', 'info');
    } catch (error) {
        alert('Kunne ikke slette økt: ' + error.message);
    }
}

async function deleteSession(id) {
    if (!confirm('Er du sikker på at du vil slette denne treningsøkten fra historikken?')) return;

    try {
        await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
        loadSessions();
        loadOverallStats();
        showToast('Økt slettet', 'info');
    } catch (error) {
        alert('Kunne ikke slette økt: ' + error.message);
    }
}

async function viewWorkout(id) {
    try {
        const response = await fetch(`/api/workouts/${id}`);
        const workout = await response.json();

        let details = `${workout.name}\n\n${workout.description}\n\nSegmenter:\n`;
        workout.segments.forEach((seg, i) => {
            details += `\n${i + 1}. ${seg.duration_seconds / 60} min - ${seg.speed_kmh} km/t - ${seg.incline_percent}% stigning`;
        });

        alert(details);
    } catch (error) {
        alert('Kunne ikke laste økt: ' + error.message);
    }
}

async function selectWorkout(id) {
    document.getElementById('workoutSelect').value = id;
}

async function loadWorkoutFromCard(id) {
    try {
        const response = await fetch(`/api/workouts/${id}`);
        loadedWorkout = await response.json();

        // Switch to control tab
        document.querySelector('.tab-btn[data-tab="control"]').click();

        // Update loaded workout UI
        updateLoadedWorkoutUI();

        alert(`✅ "${loadedWorkout.name}" er lastet og klar!\n\nTrykk "Start Lastet Økt" i portalen, eller trykk Start på tredemøllen.`);
    } catch (error) {
        alert('Kunne ikke laste økt: ' + error.message);
    }
}

async function startWorkout() {
    const workoutId = document.getElementById('workoutSelect').value;
    if (!workoutId) {
        alert('Velg en treningsøkt først');
        return;
    }

    try {
        const response = await fetch(`/api/workouts/${workoutId}`);
        loadedWorkout = await response.json();

        // Switch to control tab
        document.querySelector('.tab-btn[data-tab="control"]').click();

        // Update loaded workout UI
        updateLoadedWorkoutUI();

        alert(`✅ "${loadedWorkout.name}" er klar!\n\nTrykk "Start Lastet Økt" i portalen, eller trykk Start på tredemøllen.`);
    } catch (error) {
        alert('Kunne ikke laste økt: ' + error.message);
    }
}

async function startLoadedWorkout() {
    if (!loadedWorkout) {
        alert('Ingen økt er lastet. Gå til Treningsøkter og velg en økt først.');
        return;
    }

    if (!treadmill || !treadmill.isConnected()) {
        alert('Koble til tredemølle først');
        return;
    }

    try {
        currentWorkout = loadedWorkout;
        currentSegmentIndex = 0;

        // Show workout progress panel
        document.getElementById('workoutProgress').classList.remove('hidden');
        document.getElementById('activeWorkoutName').textContent = currentWorkout.name;
        document.getElementById('totalSegments').textContent = currentWorkout.segments.length;

        // Build timeline
        buildWorkoutTimeline();

        await startSession(loadedWorkout.id);
        startLocalTimer(); // Ensure timer runs for loaded workouts
        await executeSegment(0);

        // Clear loaded workout UI
        loadedWorkout = null;
        updateLoadedWorkoutUI();
    } catch (error) {
        console.error('Failed to start workout:', error);
        currentWorkout = null;
        currentSegmentIndex = 0;
        showToast('Kunne ikke starte økt: ' + error.message, 'error');
    }
}

function updateLoadedWorkoutUI() {
    const loadedWorkoutCard = document.getElementById('loadedWorkoutCard');
    const startLoadedBtn = document.getElementById('startLoadedWorkoutBtn');
    const loadedWorkoutName = document.getElementById('loadedWorkoutName');
    const loadedWorkoutInfo = document.getElementById('loadedWorkoutInfo');

    if (loadedWorkout) {
        loadedWorkoutCard.classList.remove('hidden');
        loadedWorkoutName.textContent = loadedWorkout.name;

        const totalDuration = loadedWorkout.segments.reduce((sum, seg) => sum + seg.duration_seconds, 0);
        const minutes = Math.floor(totalDuration / 60);
        loadedWorkoutInfo.textContent = `${loadedWorkout.segments.length} segmenter • ${minutes} min`;

        startLoadedBtn.disabled = false;
    } else {
        loadedWorkoutCard.classList.add('hidden');
        startLoadedBtn.disabled = true;
    }
}

function buildWorkoutTimeline() {
    const timelineContainer = document.getElementById('timelineSegments');
    timelineContainer.innerHTML = '';

    currentWorkout.segments.forEach((segment, index) => {
        const segmentDiv = document.createElement('div');
        segmentDiv.className = 'timeline-segment';
        segmentDiv.id = `timeline-segment-${index}`;
        segmentDiv.title = `Segment ${index + 1}: ${segment.speed_kmh} km/t, ${segment.incline_percent}%, ${Math.round(segment.duration_seconds / 60)} min`;

        // Determine icon based on speed/incline
        let icon = '🏃';
        if (segment.incline_percent > 5) {
            icon = '⛰️';
        } else if (segment.speed_kmh > 10) {
            icon = '⚡';
        } else if (segment.speed_kmh < 4) {
            icon = '🚶';
        }

        segmentDiv.innerHTML = `
            <div class="timeline-segment-number">${index + 1}</div>
            <div class="timeline-segment-icon">${icon}</div>
        `;

        timelineContainer.appendChild(segmentDiv);
    });
}

async function executeSegment(index) {
    if (!currentWorkout || index >= currentWorkout.segments.length) {
        playSegmentAlert('complete');
        await stopTreadmill();
        document.getElementById('workoutProgress').classList.add('hidden');
        showToast('Treningsøkt fullført! 🎉', 'success', 5000);
        return;
    }

    const segment = currentWorkout.segments[index];
    currentSegmentIndex = index;

    // Update segment counter
    document.getElementById('currentSegment').textContent = index + 1;

    // Update current segment display
    document.getElementById('currentSegmentSpeed').textContent = segment.speed_kmh.toFixed(1) + ' km/t';
    document.getElementById('currentSegmentIncline').textContent = segment.incline_percent.toFixed(1) + '%';

    // Update timeline - mark previous as completed, current as active
    document.querySelectorAll('.timeline-segment').forEach((el, i) => {
        el.classList.remove('active', 'completed');
        if (i < index) {
            el.classList.add('completed');
        } else if (i === index) {
            el.classList.add('active');
        }
    });

    // Show next segment if available
    const nextSegmentCard = document.getElementById('nextSegmentCard');
    if (index + 1 < currentWorkout.segments.length) {
        const nextSeg = currentWorkout.segments[index + 1];
        nextSegmentCard.style.display = 'block';
        document.getElementById('nextSegmentName').textContent = nextSeg.segment_name || `Segment ${index + 2}`;
        document.getElementById('nextSegmentSpeed').textContent = nextSeg.speed_kmh.toFixed(1) + ' km/t';
        document.getElementById('nextSegmentIncline').textContent = nextSeg.incline_percent.toFixed(1) + '%';
        document.getElementById('nextSegmentDuration').textContent = Math.round(nextSeg.duration_seconds / 60) + ' min';
    } else {
        nextSegmentCard.style.display = 'none';
    }

    // Set treadmill speed and incline with confirmation
    try {
        if (index === 0) {
            // First segment: start treadmill, then set targets
            await treadmill.start();
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        currentTargetSpeed = segment.speed_kmh;
        currentTargetIncline = segment.incline_percent;

        const speedConfirmed = await treadmill.setSpeedAndConfirm(segment.speed_kmh);
        if (!speedConfirmed) {
            console.warn('Speed confirmation not received, proceeding anyway');
        }

        const inclineConfirmed = await treadmill.setInclineAndConfirm(segment.incline_percent);
        if (!inclineConfirmed) {
            console.warn('Incline confirmation not received, proceeding anyway');
        }

        startDriftDetection();
    } catch (error) {
        console.error('Error setting treadmill parameters:', error);
    }

    if (index > 0) {
        playSegmentAlert('segment');
        showToast(`Segment ${index + 1}: ${segment.speed_kmh} km/t, ${segment.incline_percent}% stigning`, 'info', 5000);
    }

    segmentTimeRemaining = segment.duration_seconds;

    if (workoutTimer) clearInterval(workoutTimer);

    workoutTimer = setInterval(async () => {
        if (!treadmill || !treadmill.isConnected()) {
            clearInterval(workoutTimer);
            workoutTimer = null;
            showToast('Tredemølle frakoblet - økt pauset', 'error');
            return;
        }

        segmentTimeRemaining--;

        // Update segment time remaining
        const segMinutes = Math.floor(segmentTimeRemaining / 60);
        const segSeconds = segmentTimeRemaining % 60;
        document.getElementById('segmentTimeLeft').textContent =
            `${String(segMinutes).padStart(2, '0')}:${String(segSeconds).padStart(2, '0')}`;

        // Update segment progress bar
        const segmentProgress = ((segment.duration_seconds - segmentTimeRemaining) / segment.duration_seconds) * 100;
        document.getElementById('segmentProgressFill').style.width = segmentProgress + '%';

        // Calculate overall progress
        const totalDuration = currentWorkout.segments.reduce((sum, s) => sum + s.duration_seconds, 0);
        const elapsed = currentWorkout.segments.slice(0, index).reduce((sum, s) => sum + s.duration_seconds, 0) +
            (segment.duration_seconds - segmentTimeRemaining);
        const overallProgress = (elapsed / totalDuration) * 100;

        // Update overall progress bar and percentage
        document.getElementById('overallProgressFill').style.width = overallProgress + '%';
        document.getElementById('overallProgressPercent').textContent = Math.round(overallProgress) + '%';

        // Update time displays
        const elapsedMinutes = Math.floor(elapsed / 60);
        const elapsedSeconds = elapsed % 60;
        document.getElementById('workoutElapsed').textContent =
            `${String(elapsedMinutes).padStart(2, '0')}:${String(elapsedSeconds).padStart(2, '0')}`;

        const remaining = totalDuration - elapsed;
        const remainingMinutes = Math.floor(remaining / 60);
        document.getElementById('workoutRemaining').textContent = remainingMinutes + ':' + String(remaining % 60).padStart(2, '0') + ' igjen';

        if (segmentTimeRemaining <= 0) {
            clearInterval(workoutTimer);
            await executeSegment(index + 1);
        }
    }, 1000);
}

async function startSession(workoutId = null, profileId = null) {
    try {
        const effectiveProfileId = profileId || getSelectedProfileId();
        const response = await fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workout_id: workoutId,
                profile_id: effectiveProfileId,
                heart_rate_source: activeHeartRateSource
            })
        });
        if (!response.ok) {
            const errText = await response.text().catch(() => 'unknown');
            throw new Error(`Server returned ${response.status}: ${errText}`);
        }
        const data = await response.json();
        currentSession = data.id;
        sessionStartTime = Date.now();
        sessionData = { distance: 0, time: 0, heartRates: [], calories: 0 };
        dataBuffer = []; // Clear any stale buffer
        consecutiveFailures = 0;
        console.log(`Session ${currentSession} started (workout: ${workoutId || 'manual'})`);
        initStateBroadcast();
    } catch (error) {
        console.error('Failed to start session:', error);
        showToast('Kunne ikke starte økt: ' + error.message, 'error');
    }
}

async function endSession() {
    if (!currentSession) return;

    // Flush any remaining buffered data before closing session
    try {
        await flushDataBuffer();
    } catch (e) {
        console.warn('Failed to flush data buffer before ending session:', e);
    }

    try {
        // Get actual data from server (calculated from all datapunkter)
        const statsResponse = await fetch(`/api/sessions/${currentSession}/stats`);
        const stats = await statsResponse.json();

        // Use server-calculated avg HR if available, otherwise use client-side calculation
        const avgHR = stats.avg_heart_rate || (sessionData.heartRates.length > 0
            ? Math.round(sessionData.heartRates.reduce((a, b) => a + b, 0) / sessionData.heartRates.length)
            : null);

        // Fallback time calculation: use server stats, then local timer, then wall clock
        const elapsedFromWallClock = sessionStartTime ? Math.floor((Date.now() - sessionStartTime) / 1000) : 0;
        const totalTime = stats.total_seconds || sessionData.time || elapsedFromWallClock;

        if (!stats.total_seconds && totalTime > 0) {
            console.warn(`Server had no recorded time, using fallback: ${totalTime}s (local: ${sessionData.time}s, wall: ${elapsedFromWallClock}s)`);
        }

        const totalDistance = stats.max_distance || sessionData.distance;
        const totalCalories = stats.max_calories || sessionData.calories;

        console.log(`Ending session ${currentSession}: ${totalDistance}km, ${totalTime}s, HR:${avgHR}, Cal:${totalCalories}, Buffer remaining:${dataBuffer.length}`);

        await fetch(`/api/sessions/${currentSession}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                total_distance_km: totalDistance,
                total_time_seconds: totalTime,
                avg_heart_rate: avgHR,
                calories_burned: totalCalories
            })
        });

        // Auto-sync to Strava if connected and enabled (only if session's profile has Strava)
        const autoSyncCheckbox = document.getElementById('autoSyncStrava');
        if (autoSyncCheckbox && autoSyncCheckbox.checked) {
            try {
                const stravaStatus = await fetch('/api/strava/status').then(r => r.json());
                const sessionProfileId = getSelectedProfileId();
                const hasConnection = (stravaStatus.connections || []).some(c => c.profile_id === sessionProfileId);
                if (hasConnection) {
                    await uploadToStrava(currentSession);
                }
            } catch (e) {
                console.error('Auto Strava upload failed:', e);
            }
        }

        currentSession = null;
        stopStateBroadcast();
        loadSessions();
    } catch (error) {
        console.error('Failed to end session:', error);
    }
}

function handleTreadmillStatus(status, code, isAppInitiated = false) {
    // 0x04 = Started - treadmill has started running
    if (code === 0x04) {
        // Priority 1: If a workout is loaded but not started, start it
        if (loadedWorkout && !currentSession) {
            console.log('Treadmill started - auto-starting loaded workout');
            // startLoadedWorkout() will call startSession() + startLocalTimer() + executeSegment(0)
            startLoadedWorkout().catch(err => {
                console.error('Failed to auto-start loaded workout:', err);
                showToast('Kunne ikke starte økt automatisk', 'error');
            });
        }
        // Priority 2: If no workout is loaded, start a manual session
        else if (!currentSession) {
            console.log('Treadmill started - auto-starting manual session');
            startSession().then(() => {
                console.log('Manual session started from treadmill button, currentSession:', currentSession);
                // Start timer only for manual sessions (loaded workouts handle it themselves)
                if (!isRunning) {
                    startLocalTimer();
                }
            }).catch(err => {
                console.error('Failed to auto-start session:', err);
                showToast('Kunne ikke starte økt automatisk', 'error');
            });
        }
        // If session already exists but timer stopped (e.g. after reconnect), restart it
        else if (currentSession && !isRunning) {
            startLocalTimer();
        }
    }

    // 0x0A/0x0B = Target confirmations
    // Only treat as manual override if NOT initiated by our app commands
    if (code === 0x0A) {
        if (isAppInitiated) {
            console.log('Treadmill confirmed app-initiated speed change');
        } else if (currentWorkout) {
            lastManualOverrideTime = Date.now();
            console.log('Manual speed override detected on treadmill, pausing drift correction for 15s');
            showToast('Manuell hastighetsendring registrert', 'info', 3000);
        }
    }
    if (code === 0x0B) {
        if (isAppInitiated) {
            console.log('Treadmill confirmed app-initiated incline change');
        } else if (currentWorkout) {
            lastManualOverrideTime = Date.now();
            console.log('Manual incline override detected on treadmill, pausing drift correction for 15s');
            showToast('Manuell stigningsendring registrert', 'info', 3000);
        }
    }

    // 0x02 = Stopped - treadmill has stopped
    // 0x01 = Reset - treadmill was reset
    if (code === 0x02 || code === 0x01) {
        stopDriftDetection();
        stopLocalTimer();
        if (currentSession) {
            console.log('Treadmill stopped - auto-ending session');
            // Flush any remaining buffered data before ending session
            flushDataBuffer().then(() => endSession()).catch(() => endSession());

            // If this was a structured workout, also stop it
            if (currentWorkout) {
                stopWorkout(true); // autoStop = skip confirm
            }
        }
    }
}

async function loadSessions(startDate = null, endDate = null) {
    const sessionsList = document.getElementById('sessionsList');
    if (sessionsList) sessionsList.innerHTML = '<div class="loading-state"><span class="spinner"></span> Laster økter...</div>';

    try {
        let url = '/api/sessions?limit=50';
        if (startDate) url += `&startDate=${startDate}`;
        if (endDate) url += `&endDate=${endDate}`;
        if (activeProfileFilterId) url += `&profileId=${activeProfileFilterId}`;
        const response = await fetch(url);
        const data = await response.json();
        const sessions = Array.isArray(data) ? data : data.sessions || [];
        displaySessions(sessions);
    } catch (error) {
        console.error('Failed to load sessions:', error);
    }
}

function displaySessions(sessions) {
    const list = document.getElementById('sessionsList');
    list.innerHTML = '';

    if (sessions.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>Ingen treningshistorikk ennå</p><p class="empty-state-hint">Start din første treningsøkt fra kontrollpanelet</p></div>';
        return;
    }

    sessions.forEach(session => {
        const date = new Date(session.started_at);
        const dateStr = date.toLocaleDateString('no-NO', {
            year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });

        // Calculate pace if we have both distance and time
        let paceStr = '';
        if (session.total_distance_km && session.total_time_seconds && session.total_distance_km > 0) {
            const pace = (session.total_time_seconds / 60.0) / session.total_distance_km;
            paceStr = `<span>⚡ ${pace.toFixed(2)} min/km</span>`;
        }

        const profileOptions = allProfiles.map(p =>
            `<option value="${p.id}"${session.profile_id === p.id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`
        ).join('');

        const card = document.createElement('div');
        card.className = 'session-card';
        const hrZoneBadge = session.hr_zone_control_enabled ? ' <span title="Sonestyrt økt" style="font-size: 14px;">🎯</span>' : '';
        card.innerHTML = `
            <div class="session-header">
                <h3>${escapeHtml(session.workout_name || 'Fri trening')}${hrZoneBadge}</h3>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <select class="profile-select-inline" onchange="changeSessionProfile(${session.id}, this.value)" aria-label="Endre løper">
                        <option value="">—</option>
                        ${profileOptions}
                    </select>
                    <button class="btn-expand" onclick="toggleSessionDetails(${session.id})">▼</button>
                    <button class="btn btn-danger btn-small" onclick="deleteSession(${session.id})">Slett</button>
                </div>
            </div>
            <p class="session-date">${dateStr}</p>
            <div class="session-meta">
                ${session.total_distance_km ? `<span>🏃 ${session.total_distance_km.toFixed(2)} km</span>` : ''}
                ${session.total_time_seconds ? `<span>⏱️ ${Math.floor(session.total_time_seconds / 60)} min</span>` : ''}
                ${paceStr}
                ${session.avg_heart_rate ? `<span>❤️ ${session.avg_heart_rate} bpm</span>` : ''}
                ${session.calories_burned ? `<span>🔥 ${session.calories_burned} kcal</span>` : ''}
            </div>
            <div class="session-actions" style="display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap;">
                <button class="btn btn-secondary btn-small" onclick="showSessionGraph(${session.id})">📊 Graf</button>
                <button class="btn btn-secondary btn-small" onclick="exportSession(${session.id}, 'json')">JSON</button>
                <button class="btn btn-secondary btn-small" onclick="exportSession(${session.id}, 'csv')">CSV</button>
                <button class="btn btn-secondary btn-small" onclick="exportSession(${session.id}, 'tcx')">TCX</button>
                <button class="btn btn-secondary btn-small" onclick="showSegmentFeedback(${session.id})">Segmenter</button>
                <button class="strava-upload-btn" onclick="uploadToStrava(${session.id})" title="Last opp til Strava"${session.strava_upload_status === 'uploading' || session.strava_upload_status === 'complete' ? ' disabled' : ''}>
                    ${session.strava_upload_status === 'uploading' || session.strava_upload_status === 'complete' ? '✅ Strava' : '🔶 Strava'}
                </button>
            </div>
            <div class="session-details" id="sessionDetails${session.id}" style="display: none;">
                <div class="session-details-loading">Laster detaljer...</div>
            </div>
        `;
        list.appendChild(card);
    });
}

// --- Profile management for sessions ---

async function loadProfilesForUI() {
    try {
        const response = await fetch('/api/profiles');
        allProfiles = await response.json();
        populateProfileFilter();
        populateSessionProfileSelect();
    } catch (error) {
        console.error('Failed to load profiles:', error);
    }
}

function populateProfileFilter() {
    const filter = document.getElementById('profileFilter');
    if (!filter) return;
    filter.innerHTML = '<option value="">Alle</option>';
    allProfiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        filter.appendChild(opt);
    });
}

function populateSessionProfileSelect() {
    const select = document.getElementById('sessionProfileSelect');
    if (!select) return;
    const savedId = localStorage.getItem('selectedProfileId');
    select.innerHTML = '<option value="">Ingen profil</option>';
    allProfiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.name} (${p.max_hr})`;
        if (savedId && parseInt(savedId) === p.id) opt.selected = true;
        select.appendChild(opt);
    });
    // Use onchange to avoid stacking event listeners on re-calls
    select.onchange = () => {
        localStorage.setItem('selectedProfileId', select.value);
    };
}

function applyProfileFilter() {
    const filter = document.getElementById('profileFilter');
    activeProfileFilterId = filter && filter.value ? parseInt(filter.value) : null;
    loadSessions();
}

async function changeSessionProfile(sessionId, profileId) {
    try {
        const response = await fetch(`/api/sessions/${sessionId}/profile`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profile_id: profileId ? parseInt(profileId) : null })
        });
        if (!response.ok) throw new Error('Failed to update profile');
        const data = await response.json();
        showToast(`Profil oppdatert: ${data.profile_name || 'Ingen'}`, 'success');
    } catch (error) {
        console.error('Failed to change session profile:', error);
        showToast('Kunne ikke oppdatere profil', 'error');
    }
}

function getSelectedProfileId() {
    const select = document.getElementById('sessionProfileSelect');
    return select && select.value ? parseInt(select.value) : null;
}

async function toggleSessionDetails(sessionId) {
    const detailsDiv = document.getElementById(`sessionDetails${sessionId}`);
    const btn = event.target;

    if (detailsDiv.style.display === 'none') {
        detailsDiv.style.display = 'block';
        btn.textContent = '▲';
        await loadSessionDetails(sessionId);
    } else {
        detailsDiv.style.display = 'none';
        btn.textContent = '▼';
    }
}

async function loadSessionDetails(sessionId) {
    try {
        const response = await fetch(`/api/sessions/${sessionId}/details`);
        const data = await response.json();

        const detailsDiv = document.getElementById(`sessionDetails${sessionId}`);

        if (!data.dataPoints || data.dataPoints.length === 0) {
            detailsDiv.innerHTML = '<p style="color: var(--text-secondary); padding: 10px;">Ingen detaljerte data tilgjengelig for denne økten.</p>';
            return;
        }

        // Calculate detailed statistics from data points
        const speeds = data.dataPoints.map(d => d.speed_kmh).filter(s => s != null);
        const inclines = data.dataPoints.map(d => d.incline_percent).filter(i => i != null);
        const heartRates = data.dataPoints.map(d => d.heart_rate).filter(hr => hr != null);

        const avgSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
        const maxSpeed = speeds.length > 0 ? Math.max(...speeds) : 0;
        const avgIncline = inclines.length > 0 ? inclines.reduce((a, b) => a + b, 0) / inclines.length : 0;
        const maxIncline = inclines.length > 0 ? Math.max(...inclines) : 0;
        const minHR = heartRates.length > 0 ? Math.min(...heartRates) : null;
        const maxHR = heartRates.length > 0 ? Math.max(...heartRates) : null;

        detailsDiv.innerHTML = `
            <div class="session-details-content">
                <div class="details-grid">
                    <div class="detail-item">
                        <span class="detail-label">Gjennomsnittshastighet</span>
                        <span class="detail-value">${avgSpeed.toFixed(1)} km/t</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Makshastighet</span>
                        <span class="detail-value">${maxSpeed.toFixed(1)} km/t</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Gjennomsnittlig stigning</span>
                        <span class="detail-value">${avgIncline.toFixed(1)}%</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Maks stigning</span>
                        <span class="detail-value">${maxIncline.toFixed(1)}%</span>
                    </div>
                    ${minHR ? `
                    <div class="detail-item">
                        <span class="detail-label">Min puls</span>
                        <span class="detail-value">${minHR} bpm</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Maks puls</span>
                        <span class="detail-value">${maxHR} bpm</span>
                    </div>
                    ` : ''}
                    <div class="detail-item">
                        <span class="detail-label">Datapunkter</span>
                        <span class="detail-value">${data.dataPoints.length}</span>
                    </div>
                </div>
            </div>
        `;

    } catch (error) {
        console.error('Failed to load session details:', error);
        const detailsDiv = document.getElementById(`sessionDetails${sessionId}`);
        detailsDiv.innerHTML = '<p style="color: var(--error); padding: 10px;">Kunne ikke laste detaljer</p>';
    }
}

// Quick Access Modal Functions
function setupQuickAccessModals() {
    if (quickAccessInitialized) return;
    quickAccessInitialized = true;

    // Create speed buttons (1-14 km/t)
    const speedButtonsContainer = document.getElementById('speedButtons');
    for (let i = 1; i <= 14; i++) {
        const btn = document.createElement('button');
        btn.className = 'quick-btn';
        btn.innerHTML = `<span>${i}</span>`;
        btn.onclick = () => quickSetSpeed(i);
        speedButtonsContainer.appendChild(btn);
    }

    // Create incline buttons (0-12%)
    const inclineButtonsContainer = document.getElementById('inclineButtons');
    for (let i = 0; i <= 12; i++) {
        const btn = document.createElement('button');
        btn.className = 'quick-btn';
        btn.innerHTML = `<span>${i}</span>`;
        btn.onclick = () => quickSetIncline(i);
        inclineButtonsContainer.appendChild(btn);
    }

    // Add click handlers to stat values
    // Speed values
    document.getElementById('focusSpeed').addEventListener('click', () => openQuickModal('speedModal'));
    document.getElementById('currentSpeed').addEventListener('click', () => openQuickModal('speedModal'));
    document.getElementById('minimalSpeed').addEventListener('click', () => openQuickModal('speedModal'));
    document.getElementById('speedInput').addEventListener('click', () => openQuickModal('speedModal'));

    // Incline values
    document.getElementById('focusIncline').addEventListener('click', () => openQuickModal('inclineModal'));
    document.getElementById('currentIncline').addEventListener('click', () => openQuickModal('inclineModal'));
    document.getElementById('inclineInput').addEventListener('click', () => openQuickModal('inclineModal'));

    // Close modals on background click
    document.getElementById('speedModal').addEventListener('click', (e) => {
        if (e.target.id === 'speedModal') {
            closeQuickModal('speedModal');
        }
    });
    document.getElementById('inclineModal').addEventListener('click', (e) => {
        if (e.target.id === 'inclineModal') {
            closeQuickModal('inclineModal');
        }
    });

    // Close modals on ESC key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeQuickModal('speedModal');
            closeQuickModal('inclineModal');
        }
    });
}

function openQuickModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

function closeQuickModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

async function quickSetSpeed(speed) {
    if (!treadmill || !treadmill.isConnected()) {
        alert('Ikke tilkoblet tredemølle');
        return;
    }

    try {
        await treadmill.setSpeed(speed);
        document.getElementById('speedInput').value = speed.toFixed(1);
        closeQuickModal('speedModal');
    } catch (error) {
        console.error('Error setting speed:', error);
        alert('Kunne ikke sette hastighet: ' + error.message);
    }
}

async function quickSetIncline(incline) {
    if (!treadmill || !treadmill.isConnected()) {
        alert('Ikke tilkoblet tredemølle');
        return;
    }

    try {
        await treadmill.setIncline(incline);
        document.getElementById('inclineInput').value = incline;
        closeQuickModal('inclineModal');
    } catch (error) {
        console.error('Error setting incline:', error);
        alert('Kunne ikke sette stigning: ' + error.message);
    }
}

// History View Functions
function switchHistoryView(view) {
    currentHistoryView = view;

    // Update button states
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-view="${view}"]`).classList.add('active');

    // Update view visibility
    document.querySelectorAll('.history-view').forEach(v => {
        v.classList.remove('active');
    });

    if (view === 'historyOverview') {
        document.getElementById('historyOverviewView').classList.add('active');
        loadOverallStats();
    } else if (view === 'sessions') {
        document.getElementById('sessionsView').classList.add('active');
        loadSessions();
    } else if (view === 'trends') {
        document.getElementById('trendsView').classList.add('active');
        loadTrends();
    }
}

async function loadOverallStats() {
    try {
        const response = await fetch('/api/stats/overall');
        const data = await response.json();

        // Update total stats
        document.getElementById('totalDistance').textContent = (data.total_distance || 0).toFixed(1);
        document.getElementById('totalTime').textContent = ((data.total_time || 0) / 3600).toFixed(1);
        document.getElementById('totalCalories').textContent = Math.round(data.total_calories || 0);
        document.getElementById('totalSessions').textContent = data.total_sessions || 0;

        // Update average stats
        if (data.avgStats) {
            document.getElementById('avgDistance').textContent = (data.avgStats.avg_distance || 0).toFixed(2) + ' km';
            document.getElementById('avgTime').textContent = Math.round((data.avgStats.avg_time || 0) / 60) + ' min';
            document.getElementById('avgCalories').textContent = Math.round(data.avgStats.avg_calories || 0) + ' kcal';
            document.getElementById('avgHeartRate').textContent = data.avgStats.avg_hr
                ? Math.round(data.avgStats.avg_hr) + ' bpm'
                : '-- bpm';
        }

        // Update personal records
        if (data.records) {
            updatePersonalRecord('fastestPace', data.records.fastestPace, (record) => {
                const pace = (record.total_time_seconds / 60.0) / record.total_distance_km;
                return `${pace.toFixed(2)} min/km`;
            });

            updatePersonalRecord('longestDistance', data.records.longestDistance, (record) => {
                return `${record.total_distance_km.toFixed(2)} km`;
            });

            updatePersonalRecord('longestTime', data.records.longestTime, (record) => {
                const hours = Math.floor(record.total_time_seconds / 3600);
                const minutes = Math.floor((record.total_time_seconds % 3600) / 60);
                return hours > 0 ? `${hours}t ${minutes}m` : `${minutes} min`;
            });

            updatePersonalRecord('mostCalories', data.records.mostCalories, (record) => {
                return `${record.calories_burned} kcal`;
            });
        }

        // Update recent activity
        displayRecentActivity(data.recentActivity || []);

    } catch (error) {
        console.error('Failed to load overall stats:', error);
    }
}

function updatePersonalRecord(recordName, recordData, formatFunc) {
    const valueElement = document.getElementById(recordName);
    const dateElement = document.getElementById(recordName + 'Date');

    if (recordData) {
        valueElement.textContent = formatFunc(recordData);
        const date = new Date(recordData.started_at);
        dateElement.textContent = date.toLocaleDateString('no-NO', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    } else {
        valueElement.textContent = '-';
        dateElement.textContent = '-';
    }
}

function displayRecentActivity(activities) {
    const container = document.getElementById('recentActivityList');
    container.innerHTML = '';

    if (activities.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">Ingen aktivitet siste 7 dager</p>';
        return;
    }

    activities.forEach(activity => {
        const date = new Date(activity.date);
        const card = document.createElement('div');
        card.className = 'activity-day-card';
        card.innerHTML = `
            <div class="activity-date">
                <div class="activity-day">${date.toLocaleDateString('no-NO', { weekday: 'short' })}</div>
                <div class="activity-date-num">${date.getDate()}</div>
            </div>
            <div class="activity-stats">
                <div class="activity-stat">
                    <span class="activity-stat-label">Økter:</span>
                    <span class="activity-stat-value">${activity.session_count}</span>
                </div>
                <div class="activity-stat">
                    <span class="activity-stat-label">Distanse:</span>
                    <span class="activity-stat-value">${(activity.distance || 0).toFixed(2)} km</span>
                </div>
                <div class="activity-stat">
                    <span class="activity-stat-label">Tid:</span>
                    <span class="activity-stat-value">${Math.round((activity.time || 0) / 60)} min</span>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

async function loadTrends() {
    try {
        const [weeklyResponse, monthlyResponse] = await Promise.all([
            fetch('/api/stats/weekly'),
            fetch('/api/stats/monthly')
        ]);

        const weeklyData = await weeklyResponse.json();
        const monthlyData = await monthlyResponse.json();

        displayWeeklyTrends(weeklyData);
        displayMonthlyTrends(monthlyData);

    } catch (error) {
        console.error('Failed to load trends:', error);
    }
}

function displayWeeklyTrends(weeklyData) {
    const container = document.getElementById('weeklyTrends');
    container.innerHTML = '';

    if (weeklyData.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">Ingen data tilgjengelig</p>';
        return;
    }

    weeklyData.forEach((week, index) => {
        const card = document.createElement('div');
        card.className = 'trend-card';

        const weekNum = week.week.split('-')[1];
        const year = week.year;

        // Calculate comparison with previous week
        let comparison = '';
        if (index < weeklyData.length - 1) {
            const prevWeek = weeklyData[index + 1];
            const distanceChange = ((week.total_distance - prevWeek.total_distance) / prevWeek.total_distance) * 100;
            const changeIcon = distanceChange >= 0 ? '📈' : '📉';
            comparison = `<div class="trend-comparison ${distanceChange >= 0 ? 'positive' : 'negative'}">
                ${changeIcon} ${Math.abs(distanceChange).toFixed(0)}% vs forrige uke
            </div>`;
        }

        card.innerHTML = `
            <div class="trend-header">
                <h4>Uke ${weekNum}, ${year}</h4>
                ${comparison}
            </div>
            <div class="trend-stats">
                <div class="trend-stat">
                    <span class="trend-stat-label">Økter</span>
                    <span class="trend-stat-value">${week.session_count}</span>
                </div>
                <div class="trend-stat">
                    <span class="trend-stat-label">Distanse</span>
                    <span class="trend-stat-value">${(week.total_distance || 0).toFixed(1)} km</span>
                </div>
                <div class="trend-stat">
                    <span class="trend-stat-label">Tid</span>
                    <span class="trend-stat-value">${Math.round((week.total_time || 0) / 60)} min</span>
                </div>
                <div class="trend-stat">
                    <span class="trend-stat-label">Kalorier</span>
                    <span class="trend-stat-value">${Math.round(week.total_calories || 0)} kcal</span>
                </div>
                ${week.avg_hr ? `
                <div class="trend-stat">
                    <span class="trend-stat-label">Gj.snitt puls</span>
                    <span class="trend-stat-value">${Math.round(week.avg_hr)} bpm</span>
                </div>
                ` : ''}
            </div>
        `;
        container.appendChild(card);
    });
}

function displayMonthlyTrends(monthlyData) {
    const container = document.getElementById('monthlyTrends');
    container.innerHTML = '';

    if (monthlyData.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">Ingen data tilgjengelig</p>';
        return;
    }

    monthlyData.forEach((month, index) => {
        const card = document.createElement('div');
        card.className = 'trend-card';

        const [year, monthNum] = month.month.split('-');
        const monthName = new Date(year, monthNum - 1).toLocaleDateString('no-NO', { month: 'long', year: 'numeric' });

        // Calculate comparison with previous month
        let comparison = '';
        if (index < monthlyData.length - 1) {
            const prevMonth = monthlyData[index + 1];
            const distanceChange = ((month.total_distance - prevMonth.total_distance) / prevMonth.total_distance) * 100;
            const changeIcon = distanceChange >= 0 ? '📈' : '📉';
            comparison = `<div class="trend-comparison ${distanceChange >= 0 ? 'positive' : 'negative'}">
                ${changeIcon} ${Math.abs(distanceChange).toFixed(0)}% vs forrige måned
            </div>`;
        }

        card.innerHTML = `
            <div class="trend-header">
                <h4>${monthName}</h4>
                ${comparison}
            </div>
            <div class="trend-stats">
                <div class="trend-stat">
                    <span class="trend-stat-label">Økter</span>
                    <span class="trend-stat-value">${month.session_count}</span>
                </div>
                <div class="trend-stat">
                    <span class="trend-stat-label">Distanse</span>
                    <span class="trend-stat-value">${(month.total_distance || 0).toFixed(1)} km</span>
                </div>
                <div class="trend-stat">
                    <span class="trend-stat-label">Tid</span>
                    <span class="trend-stat-value">${Math.round((month.total_time || 0) / 60)} min</span>
                </div>
                <div class="trend-stat">
                    <span class="trend-stat-label">Kalorier</span>
                    <span class="trend-stat-value">${Math.round(month.total_calories || 0)} kcal</span>
                </div>
                ${month.avg_hr ? `
                <div class="trend-stat">
                    <span class="trend-stat-label">Gj.snitt puls</span>
                    <span class="trend-stat-value">${Math.round(month.avg_hr)} bpm</span>
                </div>
                ` : ''}
            </div>
        `;
        container.appendChild(card);
    });
}

// ========================================
// Heart Rate Monitor (HRM) Functions
// ========================================

async function connectHRM() {
    try {
        const btn = document.getElementById('connectHRMBtn');
        btn.disabled = true;
        btn.textContent = 'Kobler til...';

        hrm = new HeartRateMonitor();

        hrm.onHeartRate((heartRate) => {
            hrmHeartRate = heartRate;
            updateHeartRateSource();
            updateHeartRateDisplay();
        });

        hrm.onDisconnect(() => {
            hrmHeartRate = null;
            updateHeartRateSource();
            updateHeartRateDisplay();
            document.getElementById('hrmStatusCard').classList.add('hidden');
            const btn = document.getElementById('connectHRMBtn');
            btn.disabled = false;
            btn.textContent = '❤️ Koble til Pulsbelte';
            alert('Pulsbelte frakoblet');
        });

        await hrm.connect();

        document.getElementById('hrmStatusCard').classList.remove('hidden');
        document.getElementById('hrmDeviceName').textContent = hrm.getDeviceName() || 'Pulsbelte';
        btn.textContent = '❤️ Tilkoblet';
        updateHeartRateSource();
        alert('Tilkoblet til pulsbelte! Pulsdata vil nå bli brukt i treningsøkter.');

    } catch (error) {
        console.error('Failed to connect to HRM:', error);
        alert('Kunne ikke koble til pulsbelte: ' + error.message);
        const btn = document.getElementById('connectHRMBtn');
        btn.disabled = false;
        btn.textContent = '❤️ Koble til Pulsbelte';
    }
}

function disconnectHRM() {
    if (hrm) {
        hrm.disconnect();
        hrm = null;
        hrmHeartRate = null;
        updateHeartRateSource();
        updateHeartRateDisplay();
        document.getElementById('hrmStatusCard').classList.add('hidden');
        const btn = document.getElementById('connectHRMBtn');
        btn.disabled = false;
        btn.textContent = '❤️ Koble til Pulsbelte';
    }
}

function updateHeartRateSource() {
    let newSource = 'none';
    if (hrmHeartRate !== null && hrmHeartRate > 0) {
        newSource = 'hrm';
    } else if (treadmillHeartRate !== null && treadmillHeartRate > 0 && treadmillHeartRate < 255) {
        newSource = 'treadmill';
    }
    activeHeartRateSource = newSource;
    const sourceLabels = { 'hrm': '❤️ Pulsbelte', 'treadmill': '🏃 Tredemølle', 'none': 'Ingen' };
    document.getElementById('heartRateSource').textContent = sourceLabels[newSource];
}

function updateHeartRateDisplay() {
    let displayHR = null;
    if (hrmHeartRate !== null && hrmHeartRate > 0) {
        displayHR = hrmHeartRate;
    } else if (treadmillHeartRate !== null && treadmillHeartRate > 0 && treadmillHeartRate < 255) {
        displayHR = treadmillHeartRate;
    }

    if (hrm && hrm.isConnected()) {
        const hrmHRDisplay = document.getElementById('hrmHeartRate');
        if (hrmHeartRate !== null && hrmHeartRate > 0) {
            hrmHRDisplay.textContent = hrmHeartRate + ' bpm';
            hrmHRDisplay.classList.add('pulse-animation');
        } else {
            hrmHRDisplay.textContent = '-- bpm';
            hrmHRDisplay.classList.remove('pulse-animation');
        }
    }

    const hrContainers = [
        document.getElementById('currentHR')?.closest('.stat-card'),
        document.getElementById('focusHR')?.closest('.stat-card'),
        document.getElementById('minimalHR')?.closest('.minimal-stat-small')
    ];

    if (displayHR !== null) {
        document.getElementById('currentHR').textContent = displayHR;
        document.getElementById('focusHR').textContent = displayHR + ' bpm';
        document.getElementById('minimalHR').textContent = displayHR;
        hrContainers.forEach(container => {
            if (container) container.style.display = '';
        });
        if (currentSession) {
            if (sessionData.heartRates.length > 7200) { // Cap at 2 hours of data
                sessionData.heartRates.shift();
            }
            sessionData.heartRates.push(displayHR);
        }
    } else {
        hrContainers.forEach(container => {
            if (container) container.style.display = 'none';
        });
    }
}

// ========================================
// 1. Training Data Graph (Chart.js)
// ========================================

async function showSessionGraph(sessionId) {
    try {
        const response = await fetch(`/api/sessions/${sessionId}/details`);
        const data = await response.json();

        if (!data.dataPoints || data.dataPoints.length === 0) {
            showToast('Ingen data tilgjengelig for graf', 'error');
            return;
        }

        const dataPoints = data.dataPoints;

        // Build labels (MM:SS from index, 1 per second)
        const labels = dataPoints.map((_, i) => {
            const min = Math.floor(i / 60);
            const sec = i % 60;
            return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        });

        const speeds = dataPoints.map(d => d.speed_kmh);
        const heartRates = dataPoints.map(d => d.heart_rate);
        const inclines = dataPoints.map(d => d.incline_percent);

        const hasHR = heartRates.some(hr => hr != null && hr > 0);
        const hasIncline = inclines.some(inc => inc != null && inc > 0);

        // Show modal
        const modal = document.getElementById('chartModal');
        if (!modal) {
            showToast('Graf-modal ikke funnet', 'error');
            return;
        }
        modal.classList.remove('hidden');
        modal.style.display = 'flex';

        // Destroy existing chart
        if (sessionChart) {
            sessionChart.destroy();
            sessionChart = null;
        }

        const ctx = document.getElementById('sessionChart').getContext('2d');

        const datasets = [];

        // Speed dataset - left Y-axis
        datasets.push({
            label: 'Hastighet (km/t)',
            data: speeds,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            yAxisID: 'ySpeed',
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2
        });

        // Incline as area fill (light gray)
        if (hasIncline) {
            datasets.push({
                label: 'Stigning (%)',
                data: inclines,
                borderColor: 'rgba(156, 163, 175, 0.5)',
                backgroundColor: 'rgba(156, 163, 175, 0.15)',
                yAxisID: 'ySpeed',
                tension: 0.3,
                pointRadius: 0,
                borderWidth: 1,
                fill: true
            });
        }

        // Heart rate dataset - right Y-axis
        if (hasHR) {
            datasets.push({
                label: 'Puls (bpm)',
                data: heartRates,
                borderColor: '#ef4444',
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                yAxisID: 'yHR',
                tension: 0.3,
                pointRadius: 0,
                borderWidth: 2
            });
        }

        const scales = {
            x: {
                title: { display: true, text: 'Tid' },
                ticks: {
                    maxTicksLimit: 15,
                    maxRotation: 0
                }
            },
            ySpeed: {
                type: 'linear',
                position: 'left',
                title: { display: true, text: 'Hastighet (km/t)' },
                beginAtZero: true
            }
        };

        if (hasHR) {
            scales.yHR = {
                type: 'linear',
                position: 'right',
                title: { display: true, text: 'Puls (bpm)' },
                grid: { drawOnChartArea: false },
                beginAtZero: false,
                min: 40
            };
        }

        sessionChart = new Chart(ctx, {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: { position: 'top' },
                    title: {
                        display: true,
                        text: 'Treningsdata'
                    }
                },
                scales: scales
            }
        });

    } catch (error) {
        console.error('Failed to show session graph:', error);
        showToast('Kunne ikke laste graf', 'error');
    }
}

function closeChartModal() {
    const modal = document.getElementById('chartModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
    if (sessionChart) {
        sessionChart.destroy();
        sessionChart = null;
    }
}

// ========================================
// 2. Sound Alerts (Web Audio API)
// ========================================

function playSegmentAlert(type = 'segment') {
    if (!soundAlertsEnabled) return;

    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        if (type === 'segment') {
            // Two short beeps (440Hz, 150ms each, 100ms gap)
            [0, 0.25].forEach(startTime => {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.frequency.value = 440;
                osc.type = 'sine';
                gain.gain.setValueAtTime(0.3, audioCtx.currentTime + startTime);
                gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + startTime + 0.15);
                osc.start(audioCtx.currentTime + startTime);
                osc.stop(audioCtx.currentTime + startTime + 0.15);
            });
            setTimeout(() => audioCtx.close(), 600);

        } else if (type === 'complete') {
            // Rising tone (440 -> 880Hz over 500ms)
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.frequency.setValueAtTime(440, audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.5);
            osc.type = 'sine';
            gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
            osc.start(audioCtx.currentTime);
            osc.stop(audioCtx.currentTime + 0.5);
            setTimeout(() => audioCtx.close(), 700);

        } else if (type === 'warning') {
            // Single low beep (220Hz, 300ms)
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.frequency.value = 220;
            osc.type = 'sine';
            gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
            osc.start(audioCtx.currentTime);
            osc.stop(audioCtx.currentTime + 0.3);
            setTimeout(() => audioCtx.close(), 500);
        }
    } catch (e) {
        console.warn('Could not play sound alert:', e);
    }
}

// ========================================
// 3. Workout Editing
// ========================================

async function editWorkout(workoutId) {
    try {
        // Try to fetch from API first, fall back to allWorkouts
        let workout;
        try {
            const response = await fetch(`/api/workouts/${workoutId}`);
            if (response.ok) {
                workout = await response.json();
            }
        } catch (e) {
            // Ignore fetch error, try local
        }

        if (!workout) {
            workout = allWorkouts.find(w => w.id === workoutId);
        }

        if (!workout) {
            showToast('Kunne ikke finne treningsøkt', 'error');
            return;
        }

        editingWorkoutId = workoutId;

        // Populate the create form
        document.getElementById('workoutName').value = workout.name;
        document.getElementById('workoutDescription').value = workout.description || '';
        document.getElementById('workoutDifficulty').value = workout.difficulty || 'intermediate';

        // Clear existing segments in UI
        document.getElementById('segmentsList').innerHTML = '';

        // Add each segment from workout
        if (workout.segments && workout.segments.length > 0) {
            workout.segments.forEach(segment => {
                addSegment();
                const lastSegment = document.getElementById('segmentsList').lastElementChild;
                lastSegment.querySelector('.segment-name').value = segment.segment_name || '';
                lastSegment.querySelector('.segment-duration').value = Math.round(segment.duration_seconds / 60);
                lastSegment.querySelector('.segment-speed').value = segment.speed_kmh.toFixed(1);
                lastSegment.querySelector('.segment-incline').value = segment.incline_percent.toFixed(1);
            });
        } else {
            addSegment();
        }

        // Switch to Workouts tab if not already there
        const workoutsTab = document.querySelector('.tab-btn[data-tab="workouts"]');
        if (workoutsTab && !workoutsTab.classList.contains('active')) {
            workoutsTab.click();
        }

        // Show the create form
        document.getElementById('createWorkoutForm').classList.remove('hidden');
        document.getElementById('workoutsListView').classList.add('hidden');

        // Update form title
        const formTitle = document.querySelector('#createWorkoutForm .form-header h3');
        if (formTitle) formTitle.textContent = 'Rediger treningsøkt';

        updateWorkoutSummary();

        // Scroll to form
        document.getElementById('createWorkoutForm').scrollIntoView({ behavior: 'smooth' });

    } catch (error) {
        console.error('Failed to load workout for editing:', error);
        showToast('Kunne ikke laste økt for redigering', 'error');
    }
}

function cancelEdit() {
    editingWorkoutId = null;
    const formTitle = document.querySelector('#createWorkoutForm .form-header h3');
    if (formTitle) formTitle.textContent = 'Lag ny treningsøkt';
    cancelCreateWorkout();
}

// ========================================
// 4. Date Filter
// ========================================

function setDateFilter(preset) {
    const now = new Date();
    let startDate = null;
    let endDate = null;

    if (preset === 'week') {
        const weekAgo = new Date(now);
        weekAgo.setDate(weekAgo.getDate() - 7);
        startDate = weekAgo.toISOString();
        endDate = now.toISOString();
    } else if (preset === 'month') {
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        startDate = monthStart.toISOString();
        endDate = now.toISOString();
    } else if (preset === 'quarter') {
        const quarterAgo = new Date(now);
        quarterAgo.setMonth(quarterAgo.getMonth() - 3);
        startDate = quarterAgo.toISOString();
        endDate = now.toISOString();
    }
    // 'all' — no filter, startDate and endDate remain null

    // Update active button state
    document.querySelectorAll('.date-filter-btn').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.querySelector(`.date-filter-btn[data-preset="${preset}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    loadSessions(startDate, endDate);
}

function applyCustomDateFilter() {
    const startInput = document.getElementById('dateFilterStart');
    const endInput = document.getElementById('dateFilterEnd');

    const startDate = startInput && startInput.value ? new Date(startInput.value).toISOString() : null;
    const endDate = endInput && endInput.value ? new Date(endInput.value + 'T23:59:59').toISOString() : null;

    // Clear preset button active state
    document.querySelectorAll('.date-filter-btn').forEach(btn => btn.classList.remove('active'));

    loadSessions(startDate, endDate);
}

// ========================================
// 5. Export Functions
// ========================================

async function exportSession(sessionId, format) {
    try {
        const response = await fetch(`/api/sessions/${sessionId}/details`);
        const data = await response.json();

        if (!data.dataPoints || data.dataPoints.length === 0) {
            showToast('Ingen data tilgjengelig for eksport', 'error');
            return;
        }

        let blob, filename;

        if (format === 'json') {
            blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            filename = `treningsokt_${sessionId}.json`;

        } else if (format === 'csv') {
            const headers = ['tidspunkt', 'hastighet_kmh', 'stigning_prosent', 'distanse_km', 'puls', 'kalorier'];
            const rows = data.dataPoints.map(dp => [
                dp.recorded_at || '',
                dp.speed_kmh != null ? dp.speed_kmh : '',
                dp.incline_percent != null ? dp.incline_percent : '',
                dp.distance_km != null ? dp.distance_km : '',
                dp.heart_rate != null ? dp.heart_rate : '',
                dp.calories != null ? dp.calories : ''
            ]);
            const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
            blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
            filename = `treningsokt_${sessionId}.csv`;

        } else if (format === 'tcx') {
            // Build TCX XML
            const startTime = data.session && data.session.started_at
                ? new Date(data.session.started_at).toISOString()
                : new Date().toISOString();

            let trackpoints = '';
            data.dataPoints.forEach((dp, i) => {
                const time = new Date(new Date(startTime).getTime() + i * 1000).toISOString();
                trackpoints += `
          <Trackpoint>
            <Time>${time}</Time>
            ${dp.heart_rate ? `<HeartRateBpm><Value>${dp.heart_rate}</Value></HeartRateBpm>` : ''}
            ${dp.distance_km != null ? `<DistanceMeters>${(dp.distance_km * 1000).toFixed(1)}</DistanceMeters>` : ''}
            <Extensions>
              <ns3:TPX>
                ${dp.speed_kmh != null ? `<ns3:Speed>${(dp.speed_kmh / 3.6).toFixed(2)}</ns3:Speed>` : ''}
              </ns3:TPX>
            </Extensions>
          </Trackpoint>`;
            });

            const tcxContent = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="Running">
      <Id>${startTime}</Id>
      <Lap StartTime="${startTime}">
        <TotalTimeSeconds>${data.dataPoints.length}</TotalTimeSeconds>
        <Track>${trackpoints}
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

            blob = new Blob([tcxContent], { type: 'application/xml' });
            filename = `treningsokt_${sessionId}.tcx`;
        } else {
            showToast('Ukjent eksportformat', 'error');
            return;
        }

        // Trigger download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast(`Eksportert som ${format.toUpperCase()}`, 'success');

    } catch (error) {
        console.error('Export failed:', error);
        showToast('Eksport feilet: ' + error.message, 'error');
    }
}

async function uploadToStrava(sessionId) {
    try {
        const response = await fetch(`/api/strava/upload/${sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
            const result = await response.json();
            showToast('Lastet opp til Strava!', 'success');
            return result;
        } else {
            const errorData = await response.json().catch(() => ({}));
            showToast('Strava-opplasting feilet: ' + (errorData.error || 'Ukjent feil'), 'error');
        }
    } catch (error) {
        console.error('Strava upload failed:', error);
        showToast('Strava-opplasting feilet: ' + error.message, 'error');
    }
}

// ========================================
// 6. Auto BLE Reconnect
// ========================================

async function attemptReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        showToast('Kunne ikke gjenopprette tilkobling. Koble til manuelt.', 'error');
        reconnectAttempts = 0;
        return;
    }

    // Check if navigator.bluetooth.getDevices is available
    if (!navigator.bluetooth || !navigator.bluetooth.getDevices) {
        showToast('Automatisk gjentilkobling ikke støttet i denne nettleseren', 'error');
        return;
    }

    reconnectAttempts++;
    const delay = Math.min(2000 * Math.pow(2, reconnectAttempts - 1), 30000);

    document.getElementById('connectionStatus').textContent = `Gjentilkobler... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`;
    document.getElementById('connectionStatus').className = 'status-reconnecting';

    try {
        const devices = await navigator.bluetooth.getDevices();
        if (devices.length === 0) {
            showToast('Ingen tidligere sammenkoblede enheter funnet', 'error');
            reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Stop retrying
            document.getElementById('connectionStatus').textContent = 'Frakoblet';
            document.getElementById('connectionStatus').className = 'status-disconnected';
            return;
        }

        const device = devices[0];

        // Try to connect to the device
        const server = await device.gatt.connect();
        if (server && server.connected) {
            // Successfully reconnected - re-initialize FTMS subscriptions
            try {
                await treadmill.resubscribe(server);
                reconnectAttempts = 0;
                document.getElementById('connectionStatus').textContent = 'Tilkoblet';
                document.getElementById('connectionStatus').className = 'status-connected';
                document.getElementById('connectBtn').textContent = 'Koble fra';
                enableControls();

                // Resume session if active
                if (currentSession) {
                    startLocalTimer();
                    if (currentWorkout) {
                        startDriftDetection();
                    }
                    initStateBroadcast();
                }

                showToast('Gjenopprettet tilkobling!', 'success');
                return;
            } catch (subErr) {
                console.error('Reconnected but failed to resubscribe:', subErr);
                // Fall through to retry
            }
        }
    } catch (error) {
        console.warn(`Reconnect attempt ${reconnectAttempts} failed:`, error);
    }

    // Schedule next attempt with exponential backoff
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectTimer = setTimeout(() => attemptReconnect(), delay);
    } else {
        document.getElementById('connectionStatus').textContent = 'Frakoblet';
        document.getElementById('connectionStatus').className = 'status-disconnected';
        showToast('Kunne ikke gjenopprette tilkobling. Koble til manuelt.', 'error');
        reconnectAttempts = 0;
    }
}

// ========================================
// 7. Strava UI
// ========================================

async function disconnectStrava(profileId) {
    try {
        let url = '/api/strava/disconnect';
        if (profileId) url += `?profileId=${profileId}`;
        const response = await fetch(url, { method: 'DELETE' });
        if (response.ok) {
            showToast('Koblet fra Strava', 'info');
            checkStravaConnection();
        }
    } catch (error) {
        console.error('Failed to disconnect Strava:', error);
        showToast('Kunne ikke koble fra Strava', 'error');
    }
}

async function checkStravaConnection() {
    try {
        const response = await fetch('/api/strava/status');
        if (!response.ok) return;

        const data = await response.json();
        const listEl = document.getElementById('stravaProfileList');
        if (!listEl) return;

        // Build per-profile Strava connection list
        const profiles = allProfiles.length > 0 ? allProfiles : [];
        if (profiles.length === 0) {
            listEl.innerHTML = '<p class="strava-hint">Opprett profiler først for å koble til Strava</p>';
            return;
        }

        const connections = data.connections || [];
        listEl.innerHTML = profiles.map(profile => {
            const conn = connections.find(c => c.profile_id === profile.id);
            if (conn) {
                return `<div class="strava-profile-item strava-connected">
                    <span class="strava-profile-name">${escapeHtml(profile.name)}</span>
                    <span class="strava-athlete-name">${escapeHtml(conn.athlete_name)}</span>
                    <button class="btn btn-danger btn-small" onclick="disconnectStrava(${profile.id})">Koble fra</button>
                </div>`;
            } else {
                return `<div class="strava-profile-item">
                    <span class="strava-profile-name">${escapeHtml(profile.name)}</span>
                    <span class="strava-not-connected">Ikke koblet</span>
                    <button class="btn strava-btn btn-small" onclick="window.location.href='/auth/strava?profileId=${profile.id}'">Koble til</button>
                </div>`;
            }
        }).join('');
    } catch (error) {
        console.log('Strava status check skipped (endpoint not available)');
    }
}

// ========================================
// 8. Per-Segment Feedback
// ========================================

async function showSegmentFeedback(sessionId) {
    try {
        const response = await fetch(`/api/sessions/${sessionId}/details`);
        const data = await response.json();

        if (!data.dataPoints || data.dataPoints.length === 0) {
            showToast('Ingen segmentdata tilgjengelig', 'error');
            return;
        }

        const dataPoints = data.dataPoints;

        // Group data points by segment_index
        const segments = {};
        dataPoints.forEach(dp => {
            const segIdx = dp.segment_index != null ? dp.segment_index : 0;
            if (!segments[segIdx]) {
                segments[segIdx] = { speeds: [], heartRates: [], inclines: [], count: 0 };
            }
            segments[segIdx].count++;
            if (dp.speed_kmh != null) segments[segIdx].speeds.push(dp.speed_kmh);
            if (dp.heart_rate != null && dp.heart_rate > 0) segments[segIdx].heartRates.push(dp.heart_rate);
            if (dp.incline_percent != null) segments[segIdx].inclines.push(dp.incline_percent);
        });

        // Build HTML table
        let tableHTML = `
            <div class="segment-feedback-modal" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:1000;">
                <div style="background:var(--card-bg, #1a1a2e);border-radius:12px;padding:24px;max-width:90%;max-height:80vh;overflow:auto;color:var(--text-primary, #fff);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                        <h3>Segmentoversikt</h3>
                        <button class="btn btn-secondary btn-small" onclick="this.closest('.segment-feedback-modal').remove()">Lukk</button>
                    </div>
                    <table style="width:100%;border-collapse:collapse;font-size:14px;">
                        <thead>
                            <tr style="border-bottom:1px solid rgba(255,255,255,0.2);">
                                <th style="padding:8px;text-align:left;">Segment</th>
                                <th style="padding:8px;text-align:right;">Gj.sn. Hast.</th>
                                <th style="padding:8px;text-align:right;">Gj.sn. Puls</th>
                                <th style="padding:8px;text-align:right;">Maks Puls</th>
                                <th style="padding:8px;text-align:right;">Varighet</th>
                            </tr>
                        </thead>
                        <tbody>`;

        Object.keys(segments).sort((a, b) => Number(a) - Number(b)).forEach(segIdx => {
            const seg = segments[segIdx];
            const avgSpeed = seg.speeds.length > 0 ? (seg.speeds.reduce((a, b) => a + b, 0) / seg.speeds.length).toFixed(1) : '-';
            const avgHR = seg.heartRates.length > 0 ? Math.round(seg.heartRates.reduce((a, b) => a + b, 0) / seg.heartRates.length) : '-';
            const maxHR = seg.heartRates.length > 0 ? Math.max(...seg.heartRates) : '-';
            const durationMin = Math.round(seg.count / 60);

            tableHTML += `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
                    <td style="padding:8px;">Segment ${Number(segIdx) + 1}</td>
                    <td style="padding:8px;text-align:right;">${avgSpeed} km/t</td>
                    <td style="padding:8px;text-align:right;">${avgHR} bpm</td>
                    <td style="padding:8px;text-align:right;">${maxHR} bpm</td>
                    <td style="padding:8px;text-align:right;">${durationMin} min</td>
                </tr>`;
        });

        tableHTML += `
                        </tbody>
                    </table>
                </div>
            </div>`;

        // Insert into DOM
        const container = document.createElement('div');
        container.innerHTML = tableHTML;
        document.body.appendChild(container.firstElementChild);

    } catch (error) {
        console.error('Failed to show segment feedback:', error);
        showToast('Kunne ikke laste segmentdata', 'error');
    }
}
