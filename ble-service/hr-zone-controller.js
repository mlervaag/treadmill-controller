// ble-service/hr-zone-controller.js
const { getZone, getZoneBoundaries, getHRPercent } = require('./hr-utils');

class HRZoneController {
  constructor({
    targetZone, maxHR, controlMode, initialSpeed, initialIncline,
    minSpeed = 3.0, maxSpeed = 14.0, minIncline = 0, maxIncline = 12,
    onSpeedChange, onInclineChange, onStatusChange, existingBuffer
  }) {
    this.targetZone = targetZone;
    this.maxHR = maxHR;
    this.controlMode = controlMode || 'speed';
    this.currentSpeed = initialSpeed;
    this.currentIncline = initialIncline;
    this.minSpeed = minSpeed;
    this.maxSpeed = maxSpeed;
    this.minIncline = minIncline;
    this.maxIncline = maxIncline;
    this.onSpeedChange = onSpeedChange;
    this.onInclineChange = onInclineChange;
    this.onStatusChange = onStatusChange || (() => {});

    this.ringBuffer = existingBuffer || [];
    this.ringBufferSize = 15;

    this.active = true;
    this.paused = false;
    this.pauseEndTime = 0;
    this.tickCount = 0;
    this.adjustInterval = 20;
    this.lastAdjustTick = 0;
    this.accumulatedChange = 0;
    this.accumulationCap = 0.8;
    this.lastDirection = null;
    this.directionChangeCooldownUntil = 0;
    this.adjustmentCount = 0;
    this.lastAction = null;
    this.previousHR = null;
    this.outlierCount = 0;
    this.hrmDropoutStart = null;
    this.hrmStatus = 'connected';

    this.graduatedResumeTicksLeft = 0;
    this.graduatedResumeInterval = 30;

    this.hysteresis = 2;

    this.overloadStart = null;

    const bounds = getZoneBoundaries(targetZone);
    this.zoneLow = bounds ? bounds.low : 0;
    this.zoneHigh = bounds ? bounds.high : 100;
  }

  tick(currentHR) {
    this.tickCount++;

    if (this.paused) {
      if (Date.now() >= this.pauseEndTime) {
        this.paused = false;
        this.graduatedResumeTicksLeft = 3;
        this.onStatusChange({ action: 'resume', reason: 'pause_expired' });
      }
      return;
    }

    if (!currentHR || currentHR <= 0) {
      if (!this.hrmDropoutStart) {
        this.hrmDropoutStart = Date.now();
        this.hrmStatus = 'dropout';
        this.onStatusChange({ action: 'hrm_dropout', reason: 'no_signal' });
      }
      const dropoutMs = Date.now() - this.hrmDropoutStart;
      const timeoutMs = this.targetZone >= 4 ? 60000 : 120000;

      if (this.targetZone >= 4 && dropoutMs >= 30000 && dropoutMs < 31000) {
        this._adjustSpeed(-0.3, 'hrm_precaution');
      }

      if (dropoutMs >= timeoutMs) {
        this.hrmStatus = 'timeout';
        this.active = false;
        this.onStatusChange({ action: 'hrm_timeout', reason: `no_signal_${Math.round(timeoutMs/1000)}s` });
      }
      return;
    }

    if (this.hrmDropoutStart) {
      this.hrmDropoutStart = null;
      this.hrmStatus = 'connected';
      this.onStatusChange({ action: 'hrm_recovered', reason: 'signal_restored' });
    }

    const minHRFloor = Math.max(50, this.maxHR * 0.4);
    if (currentHR < minHRFloor) return;

    if (this.previousHR && Math.abs(currentHR - this.previousHR) > 15) {
      this.outlierCount++;
      if (this.outlierCount < 3) return;
      this.outlierCount = 0;
    } else {
      this.outlierCount = 0;
    }
    this.previousHR = currentHR;

    this.ringBuffer.push(currentHR);
    if (this.ringBuffer.length > this.ringBufferSize) {
      this.ringBuffer.shift();
    }

    if (this.ringBuffer.length < 8) return;

    let currentInterval = this.adjustInterval;
    if (this.graduatedResumeTicksLeft > 0) {
      currentInterval = this.graduatedResumeInterval;
    }

    if (this.directionChangeCooldownUntil > this.tickCount) return;

    if (this.tickCount - this.lastAdjustTick < currentInterval) return;

    if (!this.active) return;

    const avgHR = this.ringBuffer.reduce((a, b) => a + b, 0) / this.ringBuffer.length;
    const hrPct = getHRPercent(avgHR, this.maxHR);

    if (hrPct > 95) {
      this._adjustSpeed(-0.5, 'safety_high_hr');
      this.lastAdjustTick = this.tickCount;
      return;
    }

    const currentZone = getZone(avgHR, this.maxHR);
    if (currentZone && currentZone >= this.targetZone + 2) {
      if (!this.overloadStart) this.overloadStart = Date.now();
      if (Date.now() - this.overloadStart >= 180000) {
        this._adjustSpeed(-0.5, 'sustained_overload');
        this.lastAdjustTick = this.tickCount;
        return;
      }
    } else {
      this.overloadStart = null;
    }

    const overThreshold = this.zoneHigh + this.hysteresis;

    if (hrPct > overThreshold) {
      const zonesOver = Math.max(1, Math.floor((hrPct - this.zoneHigh) / 10));
      const stepSize = Math.min(0.5, 0.2 + (zonesOver - 1) * 0.15);
      this._adjust(-stepSize, 'over_zone');

    } else if (hrPct < this.zoneLow - 2) {
      this._adjust(0.2, 'under_zone_far');

    } else if (hrPct < this.zoneLow) {
      this._adjust(0.1, 'under_zone_near');
      this.lastAdjustTick = this.tickCount;
      if (this.graduatedResumeTicksLeft <= 0) {
        this.lastAdjustTick += 10;
      }
      if (this.graduatedResumeTicksLeft > 0) this.graduatedResumeTicksLeft--;
      return;

    } else {
      this.accumulatedChange = 0;
      this.lastDirection = null;
      this.lastAction = 'in_zone';
    }

    this.lastAdjustTick = this.tickCount;
    if (this.graduatedResumeTicksLeft > 0) this.graduatedResumeTicksLeft--;
  }

  _adjust(step, reason) {
    const direction = step > 0 ? 'up' : 'down';

    if (this.lastDirection && this.lastDirection !== direction) {
      this.accumulatedChange = 0;
      this.directionChangeCooldownUntil = this.tickCount + 30;
      this.lastDirection = direction;
      this.onStatusChange({ action: 'direction_change_cooldown', reason });
      return;
    }
    this.lastDirection = direction;

    this.accumulatedChange += Math.abs(step);
    if (this.accumulatedChange > this.accumulationCap) {
      this.accumulatedChange = 0;
      this.directionChangeCooldownUntil = this.tickCount + 30;
      this.onStatusChange({ action: 'accumulation_pause', reason });
      return;
    }

    if (this.controlMode === 'speed') {
      this._adjustSpeed(step, reason);
    } else {
      this._adjustIncline(step > 0 ? 0.5 : -0.5, reason);
    }
  }

  _adjustSpeed(step, reason) {
    const oldSpeed = this.currentSpeed;
    this.currentSpeed = Math.round((this.currentSpeed + step) * 10) / 10;
    this.currentSpeed = Math.max(this.minSpeed, Math.min(this.maxSpeed, this.currentSpeed));
    if (this.currentSpeed === oldSpeed) return;

    this.adjustmentCount++;
    this.lastAction = step < 0 ? 'decrease_speed' : 'increase_speed';
    this.onSpeedChange(this.currentSpeed);
    this.onStatusChange({
      action: this.lastAction, fromValue: oldSpeed, toValue: this.currentSpeed, reason
    });
  }

  _adjustIncline(step, reason) {
    const oldIncline = this.currentIncline;
    this.currentIncline = Math.round((this.currentIncline + step) * 10) / 10;
    this.currentIncline = Math.max(this.minIncline, Math.min(this.maxIncline, this.currentIncline));
    if (this.currentIncline === oldIncline) return;

    this.adjustmentCount++;
    this.lastAction = step < 0 ? 'decrease_incline' : 'increase_incline';
    this.onInclineChange(this.currentIncline);
    this.onStatusChange({
      action: this.lastAction, fromValue: oldIncline, toValue: this.currentIncline, reason
    });
  }

  pause(durationMs) {
    this.paused = true;
    this.pauseEndTime = Date.now() + durationMs;
  }

  resume() {
    this.paused = false;
    this.graduatedResumeTicksLeft = 3;
  }

  updateBaseline(speed, incline) {
    this.currentSpeed = speed;
    this.currentIncline = incline;
    this.accumulatedChange = 0;
    this.lastDirection = null;
  }

  getState() {
    const avgHR = this.ringBuffer.length > 0
      ? Math.round(this.ringBuffer.reduce((a, b) => a + b, 0) / this.ringBuffer.length)
      : null;
    return {
      active: this.active,
      paused: this.paused,
      pauseRemaining: this.paused ? Math.max(0, Math.round((this.pauseEndTime - Date.now()) / 1000)) : 0,
      currentSpeed: this.currentSpeed,
      currentIncline: this.currentIncline,
      avgHR,
      currentZone: avgHR ? getZone(avgHR, this.maxHR) : null,
      targetZone: this.targetZone,
      controlMode: this.controlMode,
      adjustmentCount: this.adjustmentCount,
      lastAction: this.lastAction,
      hrmStatus: this.hrmStatus,
      currentControlledValue: this.controlMode === 'speed' ? this.currentSpeed : this.currentIncline,
    };
  }

  getRingBuffer() {
    return [...this.ringBuffer];
  }

  stop() {
    this.active = false;
  }
}

module.exports = HRZoneController;
