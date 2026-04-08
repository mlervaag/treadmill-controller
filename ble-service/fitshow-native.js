// FITSHOW proprietary BLE protocol (FFF0 service)
// Provides: error codes, safety key detection, step counter, lifetime stats,
// calibration mode, training modes, and richer device info than standard FTMS.
//
// Protocol: [0x02] [payload...] [XOR checksum] [0x03]
// References:
//   - https://github.com/tyge68/fitshow-treadmill (BTService.js)
//   - https://github.com/cagnulein/qdomyos-zwift (fitshowtreadmill.cpp)

const { EventEmitter } = require('events');

const FFF0_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
const FFF1_NOTIFY_UUID = '0000fff1-0000-1000-8000-00805f9b34fb';
const FFF2_WRITE_UUID = '0000fff2-0000-1000-8000-00805f9b34fb';

// System commands (first payload byte)
const SYS_INFO = 0x50;
const SYS_STATUS = 0x51;
const SYS_DATA = 0x52;
const SYS_CONTROL = 0x53;
const SYS_KEY = 0x54;

// Info sub-commands
const INFO_MODEL = 0x00;
const INFO_DATE = 0x01;
const INFO_SPEED = 0x02;
const INFO_INCLINE = 0x03;
const INFO_TOTAL = 0x04;
const INFO_EXTENDED = 0x05;

// Control sub-commands
const CTRL_USER = 0x00;
const CTRL_START = 0x01;
const CTRL_TARGET = 0x02;
const CTRL_STOP = 0x03;
const CTRL_PAUSE = 0x06;

// Status values
const STATUS_NAMES = {
  0: 'idle',
  1: 'ended',
  2: 'starting',
  3: 'running',
  4: 'stopped',
  5: 'error',
  6: 'safety_key_removed',
  7: 'calibration',
  10: 'paused'
};

// Error codes
const ERROR_NAMES = {
  1: 'E01 - Signal cable fault',
  2: 'E02 - Control board fault',
  3: 'E03 - Speed sensor fault',
  100: 'Safety key removed'
};

class FitshowNative extends EventEmitter {
  constructor() {
    super();
    this.notifyChar = null;
    this.writeChar = null;
    this.connected = false;

    // Device info
    this.deviceInfo = {
      model: null,
      factoryDate: null,
      speedMin: null,
      speedMax: null,
      speedUnit: null,
      inclineMin: null,
      inclineMax: null,
      pauseSupported: false,
      hrcSupported: false,
      countdown: 0,
      totalDistanceKm: null
    };

    // Live data
    this.status = 'idle';
    this.speed = 0;
    this.incline = 0;
    this.elapsedTime = 0;
    this.distance = 0;
    this.calories = 0;
    this.steps = 0;
    this.heartRate = 0;
    this.errorCode = null;

    // Polling
    this.pollTimer = null;
  }

  // === Packet framing ===

  buildPacket(payload) {
    const pkt = Buffer.alloc(payload.length + 3);
    pkt[0] = 0x02; // header
    let xor = 0;
    for (let i = 0; i < payload.length; i++) {
      pkt[i + 1] = payload[i];
      xor ^= payload[i];
    }
    pkt[payload.length + 1] = xor; // checksum
    pkt[payload.length + 2] = 0x03; // footer
    return pkt;
  }

  validatePacket(data) {
    if (data.length < 4 || data[0] !== 0x02 || data[data.length - 1] !== 0x03) return false;
    let xor = 0;
    for (let i = 1; i < data.length - 2; i++) {
      xor ^= data[i];
    }
    return xor === data[data.length - 2];
  }

  getPayload(data) {
    // Strip header, checksum, footer
    return data.slice(1, data.length - 2);
  }

  // === Connection ===

  // Connect using GATT server (from a shared node-ble connection)
  async connectWithGatt(gattServer) {
    const fff0Service = await gattServer.getPrimaryService(FFF0_SERVICE_UUID);
    this.notifyChar = await fff0Service.getCharacteristic(FFF1_NOTIFY_UUID);
    this.writeChar = await fff0Service.getCharacteristic(FFF2_WRITE_UUID);
    console.log('[FitShow] Found FFF2 write characteristic');

    await this.notifyChar.startNotifications();
    this.notifyChar.on('valuechanged', (raw) => {
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      this.handleNotification(buffer);
    });
    console.log('[FitShow] Subscribed to FFF1 notifications');

    this.connected = true;

    // Query device info
    await this.queryAllInfo();

    // Start polling
    this.startPolling();

    return true;
  }

  // === Commands ===

  async write(payload) {
    if (!this.writeChar) throw new Error('Not connected');
    const pkt = this.buildPacket(payload);
    await this.writeChar.writeValueWithoutResponse(pkt);
  }

  async queryStatus() {
    await this.write([SYS_STATUS]);
  }

  async queryModel() {
    const now = new Date();
    await this.write([
      SYS_INFO, INFO_MODEL,
      now.getFullYear() - 2000, now.getMonth() + 1, now.getDate(),
      now.getHours(), now.getMinutes(), now.getSeconds()
    ]);
  }

  async queryFactoryDate() {
    await this.write([SYS_INFO, INFO_DATE]);
  }

  async querySpeedLimits() {
    await this.write([SYS_INFO, INFO_SPEED]);
  }

  async queryInclineLimits() {
    await this.write([SYS_INFO, INFO_INCLINE]);
  }

  async queryTotalDistance() {
    await this.write([SYS_INFO, INFO_TOTAL]);
  }

  async queryExtendedInfo() {
    await this.write([SYS_INFO, INFO_EXTENDED]);
  }

  async querySportData() {
    await this.write([SYS_DATA, 0x00]);
  }

  async sendUserData(weight = 75, height = 180, age = 30) {
    await this.write([SYS_CONTROL, CTRL_USER, 0x00, 0x00, 110, age, weight, height]);
  }

  async startTreadmill(mode = 0) {
    await this.write([SYS_CONTROL, CTRL_START, 0x00, 0x00, 0x00, 0x00, mode, 0x00, 0x00, 0x00]);
  }

  async setSpeedAndIncline(speedKmh, inclinePercent) {
    const speedByte = Math.round(speedKmh * 10);
    const inclineByte = Math.round(inclinePercent);
    await this.write([SYS_CONTROL, CTRL_TARGET, speedByte, inclineByte]);
  }

  async stopTreadmill() {
    await this.write([SYS_CONTROL, CTRL_STOP]);
  }

  async pauseTreadmill() {
    await this.write([SYS_CONTROL, CTRL_PAUSE]);
  }

  async sendKey(keyCode) {
    await this.write([SYS_KEY, keyCode]);
  }

  // === Query all device info on connect ===

  async queryAllInfo() {
    console.log('[FitShow] Querying device info...');
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    await this.queryModel(); await delay(300);
    await this.querySpeedLimits(); await delay(300);
    await this.queryInclineLimits(); await delay(300);
    await this.queryTotalDistance(); await delay(300);
    await this.queryFactoryDate(); await delay(300);
    await this.queryExtendedInfo(); await delay(300);

    // Wait for responses
    await delay(1000);
    console.log('[FitShow] Device info:', JSON.stringify(this.deviceInfo, null, 2));
  }

  // === Polling ===

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (this.connected) {
        this.queryStatus().catch(() => {});
      }
    }, 500); // 500ms — conservative vs 200ms in original
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // === Notification handler ===

  handleNotification(data) {
    if (!this.validatePacket(data)) {
      console.log('[FitShow] Invalid packet:', data.toString('hex'));
      return;
    }

    const payload = this.getPayload(data);
    if (payload.length < 1) return;

    const cmd = payload[0];

    switch (cmd) {
      case SYS_INFO:
        this.handleInfoResponse(payload);
        break;
      case SYS_STATUS:
        this.handleStatusResponse(payload);
        break;
      case SYS_DATA:
        this.handleDataResponse(payload);
        break;
      case SYS_CONTROL:
        this.handleControlResponse(payload);
        break;
      default:
        console.log('[FitShow] Unknown cmd 0x' + cmd.toString(16) + ':', data.toString('hex'));
    }
  }

  handleInfoResponse(payload) {
    if (payload.length < 2) return;
    const sub = payload[1];

    switch (sub) {
      case INFO_MODEL:
        if (payload.length >= 5) {
          const b1 = payload[2].toString(16).padStart(2, '0');
          const b2 = payload.readUInt16LE(3).toString(16).padStart(4, '0');
          this.deviceInfo.model = `${b1}-${b2}`.toUpperCase();
          console.log('[FitShow] Model:', this.deviceInfo.model);
        }
        break;

      case INFO_DATE:
        if (payload.length >= 5) {
          const year = 2000 + payload[2];
          const month = payload[3];
          const day = payload[4];
          this.deviceInfo.factoryDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          console.log('[FitShow] Factory date:', this.deviceInfo.factoryDate);
        }
        break;

      case INFO_SPEED:
        if (payload.length >= 5) {
          this.deviceInfo.speedMax = payload[2] / 10;
          this.deviceInfo.speedMin = payload[3] / 10;
          this.deviceInfo.speedUnit = payload[4];
          console.log('[FitShow] Speed range:', this.deviceInfo.speedMin, '-', this.deviceInfo.speedMax, 'km/h');
        }
        break;

      case INFO_INCLINE:
        if (payload.length >= 5) {
          this.deviceInfo.inclineMax = payload[2];
          this.deviceInfo.inclineMin = payload[3];
          this.deviceInfo.pauseSupported = !!(payload[4] & 0x02);
          console.log('[FitShow] Incline range:', this.deviceInfo.inclineMin, '-', this.deviceInfo.inclineMax, '%, pause:', this.deviceInfo.pauseSupported);
        }
        break;

      case INFO_TOTAL:
        if (payload.length >= 6) {
          this.deviceInfo.totalDistanceKm = payload.readUInt32LE(2) / 10;
          console.log('[FitShow] Lifetime distance:', this.deviceInfo.totalDistanceKm, 'km');
        }
        break;

      case INFO_EXTENDED:
        if (payload.length >= 8) {
          this.deviceInfo.speedMax = payload[2] / 10;
          this.deviceInfo.speedMin = payload[3] / 10;
          this.deviceInfo.inclineMax = payload[4];
          this.deviceInfo.inclineMin = payload[5];
          this.deviceInfo.hrcSupported = !!payload[6];
          this.deviceInfo.countdown = payload[7];
          console.log('[FitShow] Extended info — HRC:', this.deviceInfo.hrcSupported, ', Countdown:', this.deviceInfo.countdown);
        }
        break;

      default:
        console.log('[FitShow] Unknown info sub-cmd:', sub, payload.toString('hex'));
    }

    this.emit('deviceInfo', this.deviceInfo);
  }

  handleStatusResponse(payload) {
    if (payload.length < 2) return;
    const statusCode = payload[1];
    const prevStatus = this.status;
    this.status = STATUS_NAMES[statusCode] || `unknown_${statusCode}`;

    // Short status (idle/stopped)
    if (payload.length <= 5) {
      if (statusCode === 0 || statusCode === 4) {
        this.speed = 0;
        this.emit('status', this.status, { speed: 0, incline: this.incline });
      }
      if (statusCode === 1) { // ended
        this.emit('status', 'ended', {});
      }
      return;
    }

    // Starting (countdown)
    if (statusCode === 2 && payload.length >= 3) {
      const countdown = payload[2];
      this.emit('status', 'starting', { countdown });
      return;
    }

    // Error
    if (statusCode === 5 && payload.length >= 3) {
      this.errorCode = payload[2];
      const errorName = ERROR_NAMES[this.errorCode] || `Unknown error ${this.errorCode}`;
      console.error('[FitShow] ERROR:', errorName);
      this.emit('error', this.errorCode, errorName);
      this.emit('status', 'error', { errorCode: this.errorCode, errorName });
      return;
    }

    // Safety key removed
    if (statusCode === 6) {
      console.warn('[FitShow] SAFETY KEY REMOVED');
      this.emit('error', 100, 'Safety key removed');
      this.emit('status', 'safety_key_removed', {});
      return;
    }

    // Calibration mode
    if (statusCode === 7) {
      console.log('[FitShow] Calibration/study mode');
      this.emit('status', 'calibration', {});
      return;
    }

    // Running data (full telemetry, payload length >= 13)
    if (payload.length >= 13) {
      this.speed = payload[2] / 10;
      this.incline = payload[3]; // signed int8
      if (this.incline > 127) this.incline -= 256;
      this.elapsedTime = payload.readUInt16LE(4);
      this.distance = payload.readUInt16LE(6) / 10;
      this.calories = payload.readUInt16LE(8);
      this.steps = payload.readUInt16LE(10);
      this.heartRate = payload[12];

      this.emit('data', {
        status: this.status,
        speed: this.speed,
        incline: this.incline,
        elapsedTime: this.elapsedTime,
        distance: this.distance,
        calories: this.calories,
        steps: this.steps,
        heartRate: this.heartRate
      });

      this.emit('status', this.status, {
        speed: this.speed,
        incline: this.incline
      });
    }
  }

  handleDataResponse(payload) {
    // Sport data summary
    if (payload.length >= 10) {
      const elapsed = payload.readUInt16LE(2);
      const dist = payload.readUInt16LE(4);
      const kcal = payload.readUInt16LE(6);
      const steps = payload.readUInt16LE(8);
      console.log(`[FitShow] Sport summary — ${elapsed}s, ${dist/10}km, ${kcal}kcal, ${steps} steps`);
      this.emit('sportData', { elapsed, distance: dist / 10, calories: kcal, steps });
    }
  }

  handleControlResponse(payload) {
    if (payload.length < 2) return;
    const sub = payload[1];

    if (sub === CTRL_TARGET && payload.length >= 4) {
      const actualSpeed = payload[2] / 10;
      const actualIncline = payload[3];
      this.emit('targetConfirmed', { speed: actualSpeed, incline: actualIncline });
    }
  }

  // === State ===

  isConnected() {
    return this.connected === true;
  }

  disconnect() {
    this.stopPolling();
    this.connected = false;
    this.emit('disconnect');
  }

  getState() {
    return {
      status: this.status,
      speed: this.speed,
      incline: this.incline,
      elapsedTime: this.elapsedTime,
      distance: this.distance,
      calories: this.calories,
      steps: this.steps,
      heartRate: this.heartRate,
      errorCode: this.errorCode,
      deviceInfo: this.deviceInfo
    };
  }
}

module.exports = FitshowNative;
