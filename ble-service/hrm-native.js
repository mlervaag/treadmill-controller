// Heart Rate Monitor (HRM) — native BLE implementation using noble
// Ported from public/hrm.js for headless operation on Linux/Raspberry Pi
// Standard Heart Rate Service UUID: 0x180D
// Reference: https://www.bluetooth.com/specifications/specs/heart-rate-service-1-0/

const { EventEmitter } = require('events');

const HEART_RATE_SERVICE_UUID = '180d';
const HEART_RATE_MEASUREMENT_UUID = '2a37';
const BODY_SENSOR_LOCATION_UUID = '2a38';

class HRMNative extends EventEmitter {
  constructor() {
    super();
    this.peripheral = null;
    this.characteristic = null;
    this.currentHeartRate = null;
    this.deviceName = null;
  }

  async connect(peripheral) {
    this.peripheral = peripheral;
    this.deviceName = peripheral.advertisement.localName || peripheral.id;

    peripheral.once('disconnect', () => {
      console.log('[HRM] Peripheral disconnected');
      this.characteristic = null;
      this.currentHeartRate = null;
      this.emit('disconnect');
    });

    console.log('[HRM] Connecting to peripheral:', this.deviceName);
    await new Promise((resolve, reject) => {
      peripheral.connect((err) => err ? reject(err) : resolve());
    });

    console.log('[HRM] Discovering services and characteristics...');
    const { characteristics } = await new Promise((resolve, reject) => {
      peripheral.discoverSomeServicesAndCharacteristics(
        [HEART_RATE_SERVICE_UUID],
        [HEART_RATE_MEASUREMENT_UUID, BODY_SENSOR_LOCATION_UUID],
        (err, services, characteristics) => {
          if (err) return reject(err);
          resolve({ services, characteristics });
        }
      );
    });

    let measurementChar = null;
    let locationChar = null;
    for (const char of characteristics) {
      const uuid = char.uuid.toLowerCase();
      if (uuid === HEART_RATE_MEASUREMENT_UUID) measurementChar = char;
      else if (uuid === BODY_SENSOR_LOCATION_UUID) locationChar = char;
    }

    if (!measurementChar) throw new Error('Heart Rate Measurement characteristic not found');
    this.characteristic = measurementChar;

    // Try to read body sensor location (optional)
    if (locationChar) {
      try {
        const locBuf = await new Promise((resolve, reject) => {
          locationChar.read((err, data) => err ? reject(err) : resolve(data));
        });
        const location = this._getBodySensorLocation(locBuf.readUInt8(0));
        console.log('[HRM] Body sensor location:', location);
      } catch (err) {
        console.log('[HRM] Body sensor location not available');
      }
    }

    // Subscribe to heart rate notifications
    await new Promise((resolve, reject) => {
      this.characteristic.subscribe((err) => err ? reject(err) : resolve());
    });
    this.characteristic.on('data', (data) => {
      this._handleHeartRateChange(data);
    });

    console.log('[HRM] Connected and subscribed to notifications');
    return true;
  }

  _handleHeartRateChange(buf) {
    // Parse Heart Rate Measurement per Bluetooth Heart Rate Service spec
    const flags = buf.readUInt8(0);
    const rate16Bits = flags & 0x01;       // Bit 0: Heart Rate Value Format
    const contactDetected = flags & 0x06;  // Bit 1-2: Sensor Contact Status
    const energyExpended = flags & 0x08;   // Bit 3: Energy Expended Status

    let heartRate;
    let offset = 1;

    // Read heart rate value (8-bit or 16-bit)
    if (rate16Bits) {
      heartRate = buf.readUInt16LE(offset);
      offset += 2;
    } else {
      heartRate = buf.readUInt8(offset);
      offset += 1;
    }

    // Check sensor contact (optional)
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
    const locations = {
      0: 'Other',
      1: 'Chest',
      2: 'Wrist',
      3: 'Finger',
      4: 'Hand',
      5: 'Ear Lobe',
      6: 'Foot'
    };
    return locations[value] || 'Unknown';
  }

  getCurrentHeartRate() {
    return this.currentHeartRate;
  }

  getDeviceName() {
    return this.deviceName;
  }

  isConnected() {
    return this.peripheral && this.peripheral.state === 'connected';
  }

  disconnect() {
    if (this.peripheral && this.peripheral.state === 'connected') {
      this.peripheral.disconnect();
      console.log('[HRM] Disconnected from Heart Rate Monitor');
    }
    this.currentHeartRate = null;
  }
}

module.exports = HRMNative;
