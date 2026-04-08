const { EventEmitter } = require('events');

const HEART_RATE_SERVICE_UUID = '0000180d-0000-1000-8000-00805f9b34fb';
const HEART_RATE_MEASUREMENT_UUID = '00002a37-0000-1000-8000-00805f9b34fb';
const BODY_SENSOR_LOCATION_UUID = '00002a38-0000-1000-8000-00805f9b34fb';

class HRMNative extends EventEmitter {
  constructor() {
    super();
    this.device = null;
    this.characteristic = null;
    this.currentHeartRate = null;
    this.deviceName = null;
    this._connected = false;
    this._connectionCheckTimer = null;
  }

  async connect(device, deviceName) {
    this.device = device;
    this.deviceName = deviceName || 'HRM';
    this._connected = false;

    console.log('[HRM] Connecting to peripheral:', this.deviceName);
    await Promise.race([
      device.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout (30s)')), 30000))
    ]);
    this._connected = true;

    console.log('[HRM] Discovering services and characteristics...');
    const gattServer = await Promise.race([
      device.gatt(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('GATT discovery timeout (20s)')), 20000))
    ]);

    let hrsService;
    try {
      hrsService = await gattServer.getPrimaryService(HEART_RATE_SERVICE_UUID);
    } catch (e) {
      throw new Error('Heart Rate Service (180D) not found');
    }

    let measurementChar;
    try {
      measurementChar = await hrsService.getCharacteristic(HEART_RATE_MEASUREMENT_UUID);
    } catch (e) {
      throw new Error('Heart Rate Measurement characteristic not found');
    }
    this.characteristic = measurementChar;

    // Try to read body sensor location (optional)
    try {
      const locationChar = await hrsService.getCharacteristic(BODY_SENSOR_LOCATION_UUID);
      const locBuf = await locationChar.readValue();
      const location = this._getBodySensorLocation(locBuf.readUInt8(0));
      console.log('[HRM] Body sensor location:', location);
    } catch (err) {
      console.log('[HRM] Body sensor location not available');
    }

    // Subscribe to heart rate notifications
    await this.characteristic.startNotifications();
    this.characteristic.on('valuechanged', (raw) => {
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      this._handleHeartRateChange(buffer);
    });

    console.log('[HRM] Connected and subscribed to notifications');

    this._connectionCheckTimer = setInterval(async () => {
      try {
        if (this.device) {
          const connected = await this.device.isConnected().catch(() => false);
          if (!connected && this._connected) {
            this._connected = false;
            clearInterval(this._connectionCheckTimer);
            this._connectionCheckTimer = null;
            console.log('[HRM] Peripheral disconnected');
            this.characteristic = null;
            this.currentHeartRate = null;
            this.emit('disconnect');
          }
        }
      } catch (e) { /* ignore */ }
    }, 5000);

    return true;
  }

  _handleHeartRateChange(buf) {
    const flags = buf.readUInt8(0);
    const rate16Bits = flags & 0x01;
    const contactDetected = flags & 0x06;

    let heartRate;
    let offset = 1;

    if (rate16Bits) {
      heartRate = buf.readUInt16LE(offset);
      offset += 2;
    } else {
      heartRate = buf.readUInt8(offset);
      offset += 1;
    }

    const contactSupported = (contactDetected & 0x04) !== 0;
    const contactGood = (contactDetected & 0x02) !== 0;

    if (contactSupported && !contactGood) {
      console.log('[HRM] Poor sensor contact detected');
      heartRate = null;
    }

    this.currentHeartRate = heartRate;
    this.emit('heartRate', heartRate);
  }

  _getBodySensorLocation(value) {
    const locations = { 0: 'Other', 1: 'Chest', 2: 'Wrist', 3: 'Finger', 4: 'Hand', 5: 'Ear Lobe', 6: 'Foot' };
    return locations[value] || 'Unknown';
  }

  getCurrentHeartRate() { return this.currentHeartRate; }
  getDeviceName() { return this.deviceName; }
  isConnected() { return this._connected === true; }

  disconnect() {
    if (this._connectionCheckTimer) {
      clearInterval(this._connectionCheckTimer);
      this._connectionCheckTimer = null;
    }

    this._connected = false;
    this.currentHeartRate = null;
    if (this.device) {
      this.device.disconnect().catch(() => {});
      console.log('[HRM] Disconnected from Heart Rate Monitor');
    }
  }
}

module.exports = HRMNative;
