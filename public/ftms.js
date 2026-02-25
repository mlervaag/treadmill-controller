// FTMS (Fitness Machine Service) Bluetooth LE implementation
// UUID Reference: https://www.bluetooth.com/specifications/specs/fitness-machine-service-1-0/

const FTMS_SERVICE_UUID = '00001826-0000-1000-8000-00805f9b34fb';
const TREADMILL_DATA_UUID = '00002acd-0000-1000-8000-00805f9b34fb';
const FITNESS_MACHINE_CONTROL_POINT_UUID = '00002ad9-0000-1000-8000-00805f9b34fb';
const FITNESS_MACHINE_STATUS_UUID = '00002ada-0000-1000-8000-00805f9b34fb';
const FITNESS_MACHINE_FEATURE_UUID = '00002acc-0000-1000-8000-00805f9b34fb';

class TreadmillController {
  constructor() {
    this.device = null;
    this.server = null;
    this.service = null;
    this.controlPoint = null;
    this.treadmillData = null;
    this.statusCharacteristic = null;
    this.onDataCallback = null;
    this.onStatusCallback = null;

    // Command timing
    this.lastWriteTime = 0;
    this.minCommandInterval = 400; // ms between BLE writes

    // Status confirmation promises
    this.pendingSpeedConfirm = null;
    this.pendingInclineConfirm = null;

    // Tracked actuals from treadmill data notifications
    this.lastReportedSpeed = null;
    this.lastReportedIncline = null;
  }

  async connect(acceptAllDevices = false) {
    try {
      console.log('Requesting Bluetooth Device...');

      let requestOptions;
      if (acceptAllDevices) {
        // Show all Bluetooth devices (useful for debugging)
        requestOptions = {
          acceptAllDevices: true,
          optionalServices: [
            FTMS_SERVICE_UUID,
            '0000180f-0000-1000-8000-00805f9b34fb', // Battery Service
            '0000180a-0000-1000-8000-00805f9b34fb'  // Device Information
          ]
        };
      } else {
        // Try multiple filter approaches to find the treadmill
        requestOptions = {
          filters: [
            { services: [FTMS_SERVICE_UUID] },
            { namePrefix: 'FS-' }, // For devices like FS-A58A49
            { namePrefix: 'FTMS' },
            { namePrefix: 'Ronning' }
          ],
          optionalServices: [
            FTMS_SERVICE_UUID,
            '0000180f-0000-1000-8000-00805f9b34fb', // Battery Service
            '0000180a-0000-1000-8000-00805f9b34fb'  // Device Information
          ]
        };
      }

      this.device = await navigator.bluetooth.requestDevice(requestOptions);

      console.log('Connected to device:', this.device.name);
      console.log('Connecting to GATT Server...');
      this.server = await this.device.gatt.connect();

      console.log('Getting Fitness Machine Service...');
      this.service = await this.server.getPrimaryService(FTMS_SERVICE_UUID);

      // Get control point characteristic
      console.log('Getting Control Point...');
      this.controlPoint = await this.service.getCharacteristic(FITNESS_MACHINE_CONTROL_POINT_UUID);

      // Get treadmill data characteristic
      console.log('Getting Treadmill Data...');
      this.treadmillData = await this.service.getCharacteristic(TREADMILL_DATA_UUID);
      await this.treadmillData.startNotifications();
      this.treadmillData.addEventListener('characteristicvaluechanged', (event) => {
        this.handleTreadmillData(event.target.value);
      });

      // Get status characteristic
      try {
        this.statusCharacteristic = await this.service.getCharacteristic(FITNESS_MACHINE_STATUS_UUID);
        await this.statusCharacteristic.startNotifications();
        this.statusCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
          this.handleStatusChange(event.target.value);
        });
      } catch (err) {
        console.log('Status characteristic not available:', err);
      }

      console.log('Connected to treadmill!');
      return true;
    } catch (error) {
      console.error('Connection failed:', error);
      throw error;
    }
  }

  async _ensureCommandGap() {
    const now = Date.now();
    const elapsed = now - this.lastWriteTime;
    if (elapsed < this.minCommandInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minCommandInterval - elapsed));
    }
  }

  handleTreadmillData(value) {
    const data = this.parseTreadmillData(value);

    if (data.speed_kmh !== undefined) {
      this.lastReportedSpeed = data.speed_kmh;
    }
    if (data.incline_percent !== undefined) {
      this.lastReportedIncline = data.incline_percent;
    }

    if (this.onDataCallback) {
      this.onDataCallback(data);
    }
  }

  parseTreadmillData(value) {
    const flags = value.getUint16(0, true);
    let offset = 2;
    const data = {};

    // Flag bits indicate which fields are present
    // Bit 0: More Data (0 = no more data, 1 = more data)
    // Bit 1: Average Speed present
    // Bit 2-3: Instantaneous Speed present (0.01 km/h resolution)

    if (flags & 0x01) {
      // More data - not used here
      offset += 1;
    }

    // Instantaneous Speed (always present for treadmill)
    if (offset < value.byteLength) {
      data.speed_kmh = value.getUint16(offset, true) / 100; // 0.01 km/h resolution
      offset += 2;
    }

    // Average Speed
    if ((flags & 0x02) && offset < value.byteLength) {
      data.avg_speed_kmh = value.getUint16(offset, true) / 100;
      offset += 2;
    }

    // Total Distance (if present) - 3 bytes
    if ((flags & 0x04) && offset + 2 < value.byteLength) {
      // DataView doesn't have getUint24, so we need to read it manually
      const byte1 = value.getUint8(offset);
      const byte2 = value.getUint8(offset + 1);
      const byte3 = value.getUint8(offset + 2);
      data.total_distance_m = byte1 | (byte2 << 8) | (byte3 << 16);
      offset += 3;
    }

    // Inclination (if present)
    if ((flags & 0x08) && offset < value.byteLength) {
      data.incline_percent = value.getInt16(offset, true) / 10; // 0.1% resolution
      offset += 2;
    }

    // Ramp Angle Setting (if present)
    if ((flags & 0x10) && offset < value.byteLength) {
      data.ramp_angle = value.getInt16(offset, true) / 10;
      offset += 2;
    }

    // Positive Elevation Gain (if present)
    if ((flags & 0x20) && offset < value.byteLength) {
      data.elevation_gain_m = value.getUint16(offset, true);
      offset += 2;
    }

    // Instantaneous Pace (if present)
    if ((flags & 0x40) && offset < value.byteLength) {
      data.pace_min_per_km = value.getUint8(offset);
      offset += 1;
    }

    // Instantaneous Power (if present) - Flag bit 14
    if ((flags & 0x4000) && offset < value.byteLength) {
      data.power_watts = value.getInt16(offset, true);
      offset += 2;
    }

    // Average Power (if present) - Flag bit 15
    if ((flags & 0x8000) && offset < value.byteLength) {
      data.avg_power_watts = value.getInt16(offset, true);
      offset += 2;
    }

    // Average Pace (if present)
    if ((flags & 0x80) && offset < value.byteLength) {
      data.avg_pace_min_per_km = value.getUint8(offset);
      offset += 1;
    }

    // Total Energy (if present in extended flags)
    // FTMS spec: Energy is in calories, not kilocalories
    if ((flags & 0x100) && offset < value.byteLength) {
      const energyCalories = value.getUint16(offset, true);
      data.total_energy_kcal = energyCalories / 1000; // Convert cal to kcal
      offset += 2;
      // Energy per hour
      if (offset < value.byteLength) {
        data.energy_per_hour = value.getUint16(offset, true);
        offset += 2;
      }
      // Energy per minute
      if (offset < value.byteLength) {
        data.energy_per_min = value.getUint8(offset);
        offset += 1;
      }
    }

    // Heart Rate (if present)
    if ((flags & 0x400) && offset < value.byteLength) {
      data.heart_rate = value.getUint8(offset);
      offset += 1;
    }

    // Metabolic Equivalent (if present)
    if ((flags & 0x200) && offset < value.byteLength) {
      data.metabolic_equivalent = value.getUint8(offset) / 10;
      offset += 1;
    }

    // Elapsed Time (if present)
    if ((flags & 0x800) && offset < value.byteLength) {
      data.elapsed_time_s = value.getUint16(offset, true);
      offset += 2;
    }

    // Remaining Time (if present)
    if ((flags & 0x1000) && offset < value.byteLength) {
      data.remaining_time_s = value.getUint16(offset, true);
      offset += 2;
    }

    return data;
  }

  handleStatusChange(value) {
    const statusCode = value.getUint8(0);
    const status = this.getStatusString(statusCode);
    console.log('Treadmill status:', status);

    // Resolve pending confirmations
    if (statusCode === 0x0A && this.pendingSpeedConfirm) {
      clearTimeout(this.pendingSpeedConfirm.timeoutId);
      this.pendingSpeedConfirm.resolve(true);
      this.pendingSpeedConfirm = null;
    }
    if (statusCode === 0x0B && this.pendingInclineConfirm) {
      clearTimeout(this.pendingInclineConfirm.timeoutId);
      this.pendingInclineConfirm.resolve(true);
      this.pendingInclineConfirm = null;
    }

    if (this.onStatusCallback) {
      this.onStatusCallback(status, statusCode);
    }
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

  async setSpeed(speedKmh) {
    if (!this.controlPoint) throw new Error('Not connected');

    await this._ensureCommandGap();

    const buffer = new ArrayBuffer(3);
    const view = new DataView(buffer);
    view.setUint8(0, 0x02);
    view.setUint16(1, Math.round(speedKmh * 100), true);

    await this.controlPoint.writeValue(buffer);
    this.lastWriteTime = Date.now();
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
        console.warn(`Speed confirmation timeout for ${speedKmh} km/h`);
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

    const buffer = new ArrayBuffer(3);
    const view = new DataView(buffer);
    view.setUint8(0, 0x03);
    view.setInt16(1, Math.round(inclinePercent * 10), true);

    await this.controlPoint.writeValue(buffer);
    this.lastWriteTime = Date.now();
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
        console.warn(`Incline confirmation timeout for ${inclinePercent}%`);
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

    const buffer = new ArrayBuffer(1);
    const view = new DataView(buffer);
    view.setUint8(0, 0x07);

    await this.controlPoint.writeValue(buffer);
    this.lastWriteTime = Date.now();
    console.log('Started treadmill');
  }

  async stop() {
    if (!this.controlPoint) throw new Error('Not connected');

    await this._ensureCommandGap();

    const buffer = new ArrayBuffer(2);
    const view = new DataView(buffer);
    view.setUint8(0, 0x08);
    view.setUint8(1, 0x01);

    await this.controlPoint.writeValue(buffer);
    this.lastWriteTime = Date.now();
    console.log('Stopped treadmill');
  }

  async pause() {
    if (!this.controlPoint) throw new Error('Not connected');

    await this._ensureCommandGap();

    const buffer = new ArrayBuffer(2);
    const view = new DataView(buffer);
    view.setUint8(0, 0x08);
    view.setUint8(1, 0x02);

    await this.controlPoint.writeValue(buffer);
    this.lastWriteTime = Date.now();
    console.log('Paused treadmill');
  }

  async reset() {
    if (!this.controlPoint) throw new Error('Not connected');

    await this._ensureCommandGap();

    const buffer = new ArrayBuffer(1);
    const view = new DataView(buffer);
    view.setUint8(0, 0x01);

    await this.controlPoint.writeValue(buffer);
    this.lastWriteTime = Date.now();
    console.log('Reset treadmill');
  }

  getLastReportedSpeed() {
    return this.lastReportedSpeed;
  }

  getLastReportedIncline() {
    return this.lastReportedIncline;
  }

  onData(callback) {
    this.onDataCallback = callback;
  }

  onStatus(callback) {
    this.onStatusCallback = callback;
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

    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
      console.log('Disconnected from treadmill');
    }
  }

  isConnected() {
    return this.device && this.device.gatt.connected;
  }

  async discoverServices() {
    if (!this.server) throw new Error('Not connected');

    const deviceInfo = {
      name: this.device.name,
      id: this.device.id,
      services: []
    };

    try {
      console.log('Discovering all services...');
      const services = await this.server.getPrimaryServices();

      for (const service of services) {
        const serviceInfo = {
          uuid: service.uuid,
          isPrimary: service.isPrimary,
          characteristics: []
        };

        try {
          const characteristics = await service.getCharacteristics();

          for (const characteristic of characteristics) {
            const charInfo = {
              uuid: characteristic.uuid,
              properties: {
                read: characteristic.properties.read,
                write: characteristic.properties.write,
                writeWithoutResponse: characteristic.properties.writeWithoutResponse,
                notify: characteristic.properties.notify,
                indicate: characteristic.properties.indicate
              }
            };

            // Try to read value if readable
            if (characteristic.properties.read) {
              try {
                const value = await characteristic.readValue();
                charInfo.value = this.bufferToHex(value);
              } catch (err) {
                charInfo.value = 'Could not read';
              }
            }

            serviceInfo.characteristics.push(charInfo);
          }
        } catch (err) {
          console.error('Error getting characteristics:', err);
        }

        deviceInfo.services.push(serviceInfo);
      }

      return deviceInfo;
    } catch (error) {
      console.error('Error discovering services:', error);
      throw error;
    }
  }

  bufferToHex(buffer) {
    const bytes = new Uint8Array(buffer.buffer);
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join(' ');
  }

  getServiceName(uuid) {
    const services = {
      '00001826-0000-1000-8000-00805f9b34fb': 'Fitness Machine Service',
      '0000180f-0000-1000-8000-00805f9b34fb': 'Battery Service',
      '0000180a-0000-1000-8000-00805f9b34fb': 'Device Information',
      '00001800-0000-1000-8000-00805f9b34fb': 'Generic Access',
      '00001801-0000-1000-8000-00805f9b34fb': 'Generic Attribute'
    };
    return services[uuid] || uuid;
  }

  getCharacteristicName(uuid) {
    const characteristics = {
      '00002acd-0000-1000-8000-00805f9b34fb': 'Treadmill Data',
      '00002ad9-0000-1000-8000-00805f9b34fb': 'Fitness Machine Control Point',
      '00002ada-0000-1000-8000-00805f9b34fb': 'Fitness Machine Status',
      '00002acc-0000-1000-8000-00805f9b34fb': 'Fitness Machine Feature',
      '00002a19-0000-1000-8000-00805f9b34fb': 'Battery Level',
      '00002a29-0000-1000-8000-00805f9b34fb': 'Manufacturer Name',
      '00002a24-0000-1000-8000-00805f9b34fb': 'Model Number',
      '00002a25-0000-1000-8000-00805f9b34fb': 'Serial Number',
      '00002a27-0000-1000-8000-00805f9b34fb': 'Hardware Revision',
      '00002a26-0000-1000-8000-00805f9b34fb': 'Firmware Revision'
    };
    return characteristics[uuid] || uuid;
  }
}

// Make it available globally
window.TreadmillController = TreadmillController;
