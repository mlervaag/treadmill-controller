// FTMS (Fitness Machine Service) — native BLE implementation using noble
// Ported from public/ftms.js for headless operation on Linux/Raspberry Pi
// UUID Reference: https://www.bluetooth.com/specifications/specs/fitness-machine-service-1-0/

const { EventEmitter } = require('events');

const FTMS_SERVICE_UUID = '1826';
const TREADMILL_DATA_UUID = '2acd';
const FITNESS_MACHINE_CONTROL_POINT_UUID = '2ad9';
const FITNESS_MACHINE_STATUS_UUID = '2ada';
const FITNESS_MACHINE_FEATURE_UUID = '2acc';

class FTMSNative extends EventEmitter {
  constructor() {
    super();
    this.peripheral = null;
    this.controlPoint = null;
    this.treadmillDataChar = null;
    this.statusCharacteristic = null;

    // Command timing
    this.lastWriteTime = 0;
    this.minCommandInterval = 400; // ms between BLE writes

    // Status confirmation promises
    this.pendingSpeedConfirm = null;
    this.pendingInclineConfirm = null;

    // Tracked actuals from treadmill data notifications
    this.lastReportedSpeed = null;
    this.lastReportedIncline = null;

    // Flags to distinguish app-initiated commands from manual treadmill changes
    this._expectingSpeedConfirm = false;
    this._expectingInclineConfirm = false;
  }

  async connect(peripheral) {
    this.peripheral = peripheral;

    peripheral.once('disconnect', () => {
      console.log('[FTMS] Peripheral disconnected');
      this.controlPoint = null;
      this.treadmillDataChar = null;
      this.statusCharacteristic = null;
      this.emit('disconnect');
    });

    console.log('[FTMS] Connecting to peripheral:', peripheral.advertisement.localName || peripheral.id);
    await new Promise((resolve, reject) => {
      peripheral.connect((err) => err ? reject(err) : resolve());
    });

    console.log('[FTMS] Discovering services and characteristics...');
    const { characteristics } = await new Promise((resolve, reject) => {
      peripheral.discoverSomeServicesAndCharacteristics(
        [FTMS_SERVICE_UUID],
        [TREADMILL_DATA_UUID, FITNESS_MACHINE_CONTROL_POINT_UUID, FITNESS_MACHINE_STATUS_UUID],
        (err, services, characteristics) => {
          if (err) return reject(err);
          resolve({ services, characteristics });
        }
      );
    });

    for (const char of characteristics) {
      const uuid = char.uuid.toLowerCase();
      if (uuid === TREADMILL_DATA_UUID) this.treadmillDataChar = char;
      else if (uuid === FITNESS_MACHINE_CONTROL_POINT_UUID) this.controlPoint = char;
      else if (uuid === FITNESS_MACHINE_STATUS_UUID) this.statusCharacteristic = char;
    }

    if (!this.controlPoint) throw new Error('Control Point characteristic not found');
    if (!this.treadmillDataChar) throw new Error('Treadmill Data characteristic not found');

    // Subscribe to treadmill data notifications
    await new Promise((resolve, reject) => {
      this.treadmillDataChar.subscribe((err) => err ? reject(err) : resolve());
    });
    this.treadmillDataChar.on('data', (data) => {
      this._handleTreadmillData(data);
    });

    // Subscribe to status notifications
    if (this.statusCharacteristic) {
      try {
        await new Promise((resolve, reject) => {
          this.statusCharacteristic.subscribe((err) => err ? reject(err) : resolve());
        });
        this.statusCharacteristic.on('data', (data) => {
          this._handleStatusChange(data);
        });
      } catch (err) {
        console.log('[FTMS] Status characteristic not available:', err.message);
      }
    }

    console.log('[FTMS] Connected and subscribed to notifications');
    return true;
  }

  _handleTreadmillData(buf) {
    const data = this.parseTreadmillData(buf);

    if (data.speed_kmh !== undefined) {
      this.lastReportedSpeed = data.speed_kmh;
    }
    if (data.incline_percent !== undefined) {
      this.lastReportedIncline = data.incline_percent;
    }

    this.emit('data', data);
  }

  /**
   * Parse Treadmill Data characteristic value.
   * CRITICAL: Field ordering matches public/ftms.js exactly —
   * Heart Rate (0x400) comes BEFORE Metabolic Equivalent (0x200).
   */
  parseTreadmillData(buf) {
    const flags = buf.readUInt16LE(0);
    let offset = 2;
    const data = {};

    // Bit 0: More Data
    if (flags & 0x01) {
      offset += 1;
    }

    // Instantaneous Speed (always present for treadmill)
    if (offset < buf.length) {
      data.speed_kmh = buf.readUInt16LE(offset) / 100; // 0.01 km/h resolution
      offset += 2;
    }

    // Average Speed
    if ((flags & 0x02) && offset < buf.length) {
      data.avg_speed_kmh = buf.readUInt16LE(offset) / 100;
      offset += 2;
    }

    // Total Distance (3 bytes)
    if ((flags & 0x04) && offset + 2 < buf.length) {
      const byte1 = buf.readUInt8(offset);
      const byte2 = buf.readUInt8(offset + 1);
      const byte3 = buf.readUInt8(offset + 2);
      data.total_distance_m = byte1 | (byte2 << 8) | (byte3 << 16);
      offset += 3;
    }

    // Inclination
    if ((flags & 0x08) && offset < buf.length) {
      data.incline_percent = buf.readInt16LE(offset) / 10; // 0.1% resolution
      offset += 2;
    }

    // Ramp Angle Setting
    if ((flags & 0x10) && offset < buf.length) {
      data.ramp_angle = buf.readInt16LE(offset) / 10;
      offset += 2;
    }

    // Positive Elevation Gain
    if ((flags & 0x20) && offset < buf.length) {
      data.elevation_gain_m = buf.readUInt16LE(offset);
      offset += 2;
    }

    // Instantaneous Pace
    if ((flags & 0x40) && offset < buf.length) {
      data.pace_min_per_km = buf.readUInt8(offset);
      offset += 1;
    }

    // Instantaneous Power — Flag bit 14
    if ((flags & 0x4000) && offset < buf.length) {
      data.power_watts = buf.readInt16LE(offset);
      offset += 2;
    }

    // Average Power — Flag bit 15
    if ((flags & 0x8000) && offset < buf.length) {
      data.avg_power_watts = buf.readInt16LE(offset);
      offset += 2;
    }

    // Average Pace
    if ((flags & 0x80) && offset < buf.length) {
      data.avg_pace_min_per_km = buf.readUInt8(offset);
      offset += 1;
    }

    // Total Energy
    if ((flags & 0x100) && offset < buf.length) {
      const energyCalories = buf.readUInt16LE(offset);
      data.total_energy_kcal = energyCalories / 1000;
      offset += 2;
      // Energy per hour
      if (offset < buf.length) {
        data.energy_per_hour = buf.readUInt16LE(offset);
        offset += 2;
      }
      // Energy per minute
      if (offset < buf.length) {
        data.energy_per_min = buf.readUInt8(offset);
        offset += 1;
      }
    }

    // Heart Rate (0x400) — BEFORE Metabolic Equivalent (0x200)
    if ((flags & 0x400) && offset < buf.length) {
      data.heart_rate = buf.readUInt8(offset);
      offset += 1;
    }

    // Metabolic Equivalent (0x200) — AFTER Heart Rate (0x400)
    if ((flags & 0x200) && offset < buf.length) {
      data.metabolic_equivalent = buf.readUInt8(offset) / 10;
      offset += 1;
    }

    // Elapsed Time
    if ((flags & 0x800) && offset < buf.length) {
      data.elapsed_time_s = buf.readUInt16LE(offset);
      offset += 2;
    }

    // Remaining Time
    if ((flags & 0x1000) && offset < buf.length) {
      data.remaining_time_s = buf.readUInt16LE(offset);
      offset += 2;
    }

    return data;
  }

  _handleStatusChange(buf) {
    const statusCode = buf.readUInt8(0);
    const status = this.getStatusString(statusCode);
    console.log('[FTMS] Treadmill status:', status);

    let isAppInitiated = false;

    // Resolve pending confirmations
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

    // Check non-confirm app-initiated flags
    if (statusCode === 0x0A && this._expectingSpeedConfirm) {
      isAppInitiated = true;
      this._expectingSpeedConfirm = false;
    }
    if (statusCode === 0x0B && this._expectingInclineConfirm) {
      isAppInitiated = true;
      this._expectingInclineConfirm = false;
    }

    this.emit('status', status, statusCode, isAppInitiated);
  }

  getStatusString(code) {
    const statuses = {
      0x00: 'Reserved',
      0x01: 'Reset',
      0x02: 'Stopped',
      0x03: 'Stop Requested',
      0x04: 'Started',
      0x05: 'Start Requested',
      0x06: 'Paused',
      0x07: 'Pause Requested',
      0x08: 'Resumed',
      0x09: 'Resume Requested',
      0x0A: 'Target Speed Changed',
      0x0B: 'Target Incline Changed',
      0x0C: 'Target Resistance Changed',
      0x0D: 'Target Power Changed',
      0x0E: 'Target Heart Rate Changed'
    };
    return statuses[code] || `Unknown (${code})`;
  }

  async _ensureCommandGap() {
    const now = Date.now();
    const elapsed = now - this.lastWriteTime;
    if (elapsed < this.minCommandInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minCommandInterval - elapsed));
    }
  }

  async _writeControlPoint(buf) {
    if (!this.controlPoint) throw new Error('Not connected');
    await this._ensureCommandGap();

    await new Promise((resolve, reject) => {
      this.controlPoint.write(buf, false, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    this.lastWriteTime = Date.now();
  }

  async setSpeed(speedKmh) {
    // Mark next 0x0A as app-initiated
    this._expectingSpeedConfirm = true;
    setTimeout(() => { this._expectingSpeedConfirm = false; }, 3000);

    const buf = Buffer.alloc(3);
    buf.writeUInt8(0x02, 0);
    buf.writeUInt16LE(Math.round(speedKmh * 100), 1);

    await this._writeControlPoint(buf);
    console.log(`[FTMS] Set speed to ${speedKmh} km/h`);
  }

  async setSpeedAndConfirm(speedKmh, timeoutMs = 3000) {
    if (this.pendingSpeedConfirm) {
      clearTimeout(this.pendingSpeedConfirm.timeoutId);
      this.pendingSpeedConfirm.resolve(false);
    }

    const confirmPromise = new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingSpeedConfirm = null;
        console.warn(`[FTMS] Speed confirmation timeout for ${speedKmh} km/h`);
        resolve(false);
      }, timeoutMs);
      this.pendingSpeedConfirm = { resolve, timeoutId };
    });

    await this.setSpeed(speedKmh);
    return confirmPromise;
  }

  async setIncline(inclinePercent) {
    // Mark next 0x0B as app-initiated
    this._expectingInclineConfirm = true;
    setTimeout(() => { this._expectingInclineConfirm = false; }, 3000);

    const buf = Buffer.alloc(3);
    buf.writeUInt8(0x03, 0);
    buf.writeInt16LE(Math.round(inclinePercent * 10), 1);

    await this._writeControlPoint(buf);
    console.log(`[FTMS] Set incline to ${inclinePercent}%`);
  }

  async setInclineAndConfirm(inclinePercent, timeoutMs = 3000) {
    if (this.pendingInclineConfirm) {
      clearTimeout(this.pendingInclineConfirm.timeoutId);
      this.pendingInclineConfirm.resolve(false);
    }

    const confirmPromise = new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingInclineConfirm = null;
        console.warn(`[FTMS] Incline confirmation timeout for ${inclinePercent}%`);
        resolve(false);
      }, timeoutMs);
      this.pendingInclineConfirm = { resolve, timeoutId };
    });

    await this.setIncline(inclinePercent);
    return confirmPromise;
  }

  async start() {
    const buf = Buffer.alloc(1);
    buf.writeUInt8(0x07, 0);
    await this._writeControlPoint(buf);
    console.log('[FTMS] Started treadmill');
  }

  async stop() {
    const buf = Buffer.alloc(2);
    buf.writeUInt8(0x08, 0);
    buf.writeUInt8(0x01, 1);
    await this._writeControlPoint(buf);
    console.log('[FTMS] Stopped treadmill');
  }

  async pause() {
    const buf = Buffer.alloc(2);
    buf.writeUInt8(0x08, 0);
    buf.writeUInt8(0x02, 1);
    await this._writeControlPoint(buf);
    console.log('[FTMS] Paused treadmill');
  }

  async reset() {
    const buf = Buffer.alloc(1);
    buf.writeUInt8(0x01, 0);
    await this._writeControlPoint(buf);
    console.log('[FTMS] Reset treadmill');
  }

  getLastReportedSpeed() {
    return this.lastReportedSpeed;
  }

  getLastReportedIncline() {
    return this.lastReportedIncline;
  }

  isConnected() {
    return this.peripheral && this.peripheral.state === 'connected';
  }

  disconnect() {
    if (this.pendingSpeedConfirm) {
      clearTimeout(this.pendingSpeedConfirm.timeoutId);
      this.pendingSpeedConfirm.resolve(false);
      this.pendingSpeedConfirm = null;
    }
    if (this.pendingInclineConfirm) {
      clearTimeout(this.pendingInclineConfirm.timeoutId);
      this.pendingInclineConfirm.resolve(false);
      this.pendingInclineConfirm = null;
    }

    if (this.peripheral && this.peripheral.state === 'connected') {
      this.peripheral.disconnect();
      console.log('[FTMS] Disconnected from treadmill');
    }
  }
}

module.exports = FTMSNative;
