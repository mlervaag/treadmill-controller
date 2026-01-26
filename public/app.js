// Global state
let treadmill = null;
let currentSession = null;
let currentWorkout = null;
let workoutTimer = null;
let currentSegmentIndex = 0;
let segmentTimeRemaining = 0;
let sessionStartTime = null;
let currentViewMode = 'focus';
let localTimeTimer = null;
let localElapsedTime = 0;
let isRunning = false;
let currentHistoryView = 'overview';
// Removed: currentWorkoutView - simplified to single list view
let allWorkouts = [];
let sessionData = {
    distance: 0,
    time: 0,
    heartRates: [],
    calories: 0
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    setupEventListeners();
    setupQuickAccessModals();
    loadWorkouts();
    loadSessions();
    loadOverallStats();

    // Check if Web Bluetooth is supported
    checkBluetoothSupport();
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
                    <li>Kjør <code>setup-localhost-tunnel.ps1</code> på denne PCen</li>
                    <li>Åpne <code>http://localhost:3001</code> i stedet</li>
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
        btn.textContent = 'Kobler til...';

        treadmill = new TreadmillController();

        // Set up data callback
        treadmill.onData((data) => {
            updateStats(data);
            if (currentSession) {
                recordSessionData(data);
            }
        });

        // Set up status callback
        treadmill.onStatus((status, code) => {
            console.log('Treadmill status:', status);
        });

        await treadmill.connect(acceptAllDevices);

        btn.textContent = 'Koble fra';
        status.textContent = 'Tilkoblet';
        status.className = 'status-connected';
        enableControls();

    } catch (error) {
        console.error('Connection error:', error);
        alert('Kunne ikke koble til tredemølle: ' + error.message);
        btn.textContent = 'Koble til Tredemølle';
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

    // Heart rate: Only show if valid (not 0 or 255)
    if (data.heart_rate !== undefined) {
        const isValidHR = data.heart_rate > 0 && data.heart_rate < 255;

        // Find all HR elements
        const hrElements = [
            document.getElementById('currentHR'),
            document.getElementById('focusHR'),
            document.getElementById('minimalHR')
        ];

        // Find parent stat containers
        const hrContainers = [
            document.getElementById('currentHR')?.closest('.stat-item'),
            document.getElementById('focusHR')?.closest('.stat-card'),
            document.getElementById('minimalHR')?.closest('.stat-item')
        ];

        if (isValidHR) {
            // Show valid heart rate
            document.getElementById('currentHR').textContent = data.heart_rate;
            document.getElementById('focusHR').textContent = data.heart_rate + ' bpm';
            document.getElementById('minimalHR').textContent = data.heart_rate;

            // Show HR containers
            hrContainers.forEach(container => {
                if (container) container.style.display = '';
            });

            sessionData.heartRates.push(data.heart_rate);
        } else {
            // Hide HR display when invalid
            hrContainers.forEach(container => {
                if (container) container.style.display = 'none';
            });
        }
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

    fetch(`/api/sessions/${currentSession}/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            speed_kmh: data.speed_kmh,
            incline_percent: data.incline_percent,
            distance_km: data.total_distance_m ? data.total_distance_m / 1000 : null,
            heart_rate: validHR,
            calories: validCalories
        })
    }).catch(err => console.error('Failed to record session data:', err));
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
        stopLocalTimer(); // Stop local timer
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

async function stopWorkout() {
    if (!confirm('Er du sikker på at du vil avslutte økten?')) {
        return;
    }

    currentWorkout = null;
    currentSegmentIndex = 0;

    if (workoutTimer) {
        clearInterval(workoutTimer);
        workoutTimer = null;
    }

    await stopTreadmill();
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
        document.getElementById('currentHR')?.closest('.stat-item'),
        document.getElementById('focusHR')?.closest('.stat-card'),
        document.getElementById('minimalHR')?.closest('.stat-item')
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

        displayWorkouts();
    } catch (error) {
        console.error('Failed to load workouts:', error);
    }
}

function displayWorkouts() {
    const list = document.getElementById('workoutsList');
    list.innerHTML = '';

    if (allWorkouts.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">Ingen treningsøkter ennå. Lag din første økt!</p>';
        return;
    }

    allWorkouts.forEach(workout => {
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
    const totalMinutes = workout.segment_count > 0 ? '~' + Math.round(workout.segment_count * 3) + ' min' : 'Ukjent';

    // Difficulty badge
    const difficultyMap = {
        'beginner': 'Nybegynner',
        'intermediate': 'Middels',
        'advanced': 'Avansert'
    };
    const difficultyText = difficultyMap[workout.difficulty] || 'Nybegynner';

    card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
            <h3>${workout.name}</h3>
            <span class="difficulty-badge ${workout.difficulty || 'beginner'}">${difficultyText}</span>
        </div>
        <p>${workout.description || 'Ingen beskrivelse'}</p>
        <div class="workout-meta">
            <span>📋 ${workout.segment_count} segmenter</span>
            <span>⏱️ ${totalMinutes}</span>
        </div>
        <div class="workout-details" id="workoutDetails${workout.id}">
            <button class="btn-details" onclick="toggleWorkoutDetails(${workout.id})">Vis detaljer</button>
            <div class="workout-segments-preview" id="segmentsPreview${workout.id}"></div>
        </div>
        <div class="workout-actions">
            <button class="btn btn-primary" onclick="selectWorkout(${workout.id})">Start</button>
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
                    <span class="segment-preview-name">${segment.segment_name || `Segment ${index + 1}`}</span>
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
        const response = await fetch('/api/workouts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description, difficulty, segments })
        });

        if (response.ok) {
            cancelCreateWorkout();
            await loadWorkouts();
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

async function startWorkout() {
    const workoutId = document.getElementById('workoutSelect').value;
    if (!workoutId) {
        alert('Velg en treningsøkt først');
        return;
    }

    if (!treadmill || !treadmill.isConnected()) {
        alert('Koble til tredemølle først');
        return;
    }

    try {
        const response = await fetch(`/api/workouts/${workoutId}`);
        currentWorkout = await response.json();

        currentSegmentIndex = 0;

        // Show workout progress panel
        document.getElementById('workoutProgress').classList.remove('hidden');
        document.getElementById('workoutName').textContent = currentWorkout.name;
        document.getElementById('totalSegments').textContent = currentWorkout.segments.length;

        // Build timeline
        buildWorkoutTimeline();

        await startSession(workoutId);
        await executeSegment(0);
    } catch (error) {
        alert('Kunne ikke starte økt: ' + error.message);
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
        await stopTreadmill();
        document.getElementById('workoutProgress').classList.add('hidden');
        alert('🎉 Treningsøkt fullført! Godt jobbet!');
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

    // Set treadmill speed and incline
    await treadmill.setSpeed(segment.speed_kmh);
    await treadmill.setIncline(segment.incline_percent);

    if (index === 0) {
        await treadmill.start();
    }

    segmentTimeRemaining = segment.duration_seconds;

    if (workoutTimer) clearInterval(workoutTimer);

    workoutTimer = setInterval(async () => {
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

async function startSession(workoutId = null) {
    try {
        const response = await fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workout_id: workoutId })
        });
        const data = await response.json();
        currentSession = data.id;
        sessionStartTime = Date.now();
        sessionData = { distance: 0, time: 0, heartRates: [], calories: 0 };
    } catch (error) {
        console.error('Failed to start session:', error);
    }
}

async function endSession() {
    if (!currentSession) return;

    try {
        // Get actual data from server (calculated from all datapunkter)
        const statsResponse = await fetch(`/api/sessions/${currentSession}/stats`);
        const stats = await statsResponse.json();

        // Use server-calculated avg HR if available, otherwise use client-side calculation
        const avgHR = stats.avg_heart_rate || (sessionData.heartRates.length > 0
            ? Math.round(sessionData.heartRates.reduce((a, b) => a + b, 0) / sessionData.heartRates.length)
            : null);

        await fetch(`/api/sessions/${currentSession}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                total_distance_km: stats.max_distance || sessionData.distance,
                total_time_seconds: stats.total_seconds || sessionData.time,
                avg_heart_rate: avgHR,
                calories_burned: stats.max_calories || sessionData.calories
            })
        });

        currentSession = null;
        loadSessions();
    } catch (error) {
        console.error('Failed to end session:', error);
    }
}

async function loadSessions() {
    try {
        const response = await fetch('/api/sessions');
        const sessions = await response.json();
        displaySessions(sessions);
    } catch (error) {
        console.error('Failed to load sessions:', error);
    }
}

function displaySessions(sessions) {
    const list = document.getElementById('sessionsList');
    list.innerHTML = '';

    if (sessions.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: var(--text-secondary);">Ingen treningshistorikk ennå.</p>';
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

        const card = document.createElement('div');
        card.className = 'session-card';
        card.innerHTML = `
            <div class="session-header">
                <h3>${session.workout_name || 'Fri trening'}</h3>
                <div style="display: flex; gap: 8px;">
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
            <div class="session-details" id="sessionDetails${session.id}" style="display: none;">
                <div class="session-details-loading">Laster detaljer...</div>
            </div>
        `;
        list.appendChild(card);
    });
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

    if (view === 'overview') {
        document.getElementById('overviewView').classList.add('active');
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
