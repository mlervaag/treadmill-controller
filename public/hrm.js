// Heart Rate Monitor (HRM) - Bluetooth LE implementation
// Standard Heart Rate Service UUID: 0x180D
// Reference: https://www.bluetooth.com/specifications/specs/heart-rate-service-1-0/

const HEART_RATE_SERVICE_UUID = 0x180D;
const HEART_RATE_MEASUREMENT_UUID = 0x2A37;
const BODY_SENSOR_LOCATION_UUID = 0x2A38;

class HeartRateMonitor {
    constructor() {
        this.device = null;
        this.server = null;
        this.characteristic = null;
        this.onHeartRateCallback = null;
        this.onDisconnectCallback = null;
        this.currentHeartRate = null;
        this.batteryLevel = null;
    }

    async connect() {
        try {
            console.log('Requesting Heart Rate Monitor...');

            // Request device with Heart Rate Service
            this.device = await navigator.bluetooth.requestDevice({
                filters: [
                    { services: [HEART_RATE_SERVICE_UUID] }
                ],
                optionalServices: [
                    HEART_RATE_SERVICE_UUID,
                    'battery_service' // Optional: 0x180F
                ]
            });

            console.log('Connecting to:', this.device.name);

            // Connect to GATT server
            this.server = await this.device.gatt.connect();

            // Get Heart Rate Service
            const service = await this.server.getPrimaryService(HEART_RATE_SERVICE_UUID);

            // Get Heart Rate Measurement characteristic
            this.characteristic = await service.getCharacteristic(HEART_RATE_MEASUREMENT_UUID);

            // Start notifications
            await this.characteristic.startNotifications();

            // Listen for heart rate changes
            this.characteristic.addEventListener('characteristicvaluechanged',
                (event) => this.handleHeartRateChange(event.target.value)
            );

            // Handle disconnect
            this.device.addEventListener('gattserverdisconnected', () => {
                console.log('Heart Rate Monitor disconnected');
                this.device = null;
                this.server = null;
                this.characteristic = null;
                this.currentHeartRate = null;

                if (this.onHeartRateCallback) {
                    this.onHeartRateCallback(null);
                }
                if (this.onDisconnectCallback) {
                    this.onDisconnectCallback();
                }
            });

            // Try to get body sensor location (optional)
            try {
                const locationChar = await service.getCharacteristic(BODY_SENSOR_LOCATION_UUID);
                const locationValue = await locationChar.readValue();
                const location = this.getBodySensorLocation(locationValue.getUint8(0));
                console.log('Body sensor location:', location);
            } catch (err) {
                console.log('Body sensor location not available');
            }

            console.log('Heart Rate Monitor connected successfully!');
            return true;
        } catch (error) {
            console.error('Failed to connect to Heart Rate Monitor:', error);
            throw error;
        }
    }

    handleHeartRateChange(value) {
        // Parse Heart Rate Measurement according to Bluetooth Heart Rate Service spec
        // https://www.bluetooth.com/specifications/specs/heart-rate-service-1-0/

        const flags = value.getUint8(0);
        const rate16Bits = flags & 0x01; // Bit 0: Heart Rate Value Format
        const contactDetected = flags & 0x06; // Bit 1-2: Sensor Contact Status
        const energyExpended = flags & 0x08; // Bit 3: Energy Expended Status
        const rrInterval = flags & 0x10; // Bit 4: RR-Interval

        let heartRate;
        let offset = 1;

        // Read heart rate value (8-bit or 16-bit)
        if (rate16Bits) {
            heartRate = value.getUint16(offset, true); // Little endian
            offset += 2;
        } else {
            heartRate = value.getUint8(offset);
            offset += 1;
        }

        // Check sensor contact (optional)
        const contactSupported = (contactDetected & 0x04) !== 0;
        const contactGood = (contactDetected & 0x02) !== 0;

        if (contactSupported && !contactGood) {
            console.log('Poor sensor contact detected');
            heartRate = null; // Ignore reading if contact is poor
        }

        // Energy Expended (optional, we don't use this)
        if (energyExpended) {
            // Skip 2 bytes
            offset += 2;
        }

        // RR-Interval (optional, for HRV analysis - we don't use this)
        if (rrInterval) {
            // Multiple RR intervals can be present
            // We skip them for now
        }

        this.currentHeartRate = heartRate;

        if (this.onHeartRateCallback) {
            this.onHeartRateCallback(heartRate);
        }
    }

    getBodySensorLocation(value) {
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

    onHeartRate(callback) {
        this.onHeartRateCallback = callback;
    }

    onDisconnect(callback) {
        this.onDisconnectCallback = callback;
    }

    disconnect() {
        if (this.device && this.device.gatt.connected) {
            this.device.gatt.disconnect();
            console.log('Disconnected from Heart Rate Monitor');
        }
        this.currentHeartRate = null;
    }

    isConnected() {
        return this.device && this.device.gatt.connected;
    }

    getDeviceName() {
        return this.device ? this.device.name : null;
    }

    getCurrentHeartRate() {
        return this.currentHeartRate;
    }
}

// Make it available globally
window.HeartRateMonitor = HeartRateMonitor;
