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
    this.adjustIntervalDown = 10;  // faster response when HR too high
    this.adjustIntervalUp = 20;   // gentler when HR too low
    this.lastAdjustTick = 0;
    this.accumulatedChange = 0;
    this.accumulationCapDown = 2.0;  // allow larger total decrease before pause
    this.accumulationCapUp = 0.8;    // conservative increase
    this.lastDirection = null;
    this.directionChangeCooldownUntil = 0;
    this.adjustmentCount = 0;
    this.lastAction = null;
    this.previousHR = null;
    this.outlierCount = 0;
    this.hrmDropoutStart = null;
    this.hrmStatus = 'connected';
    this.precautionApplied = false;

    this.graduatedResumeTicksLeft = 0;
    this.graduatedResumeInterval = 30;

    this.hysteresis = 2;

    this.overloadStart = null;

    // Boundary escalation: if HR stays above zoneHigh (raw zone ceiling) but below
    // the hysteresis-padded overThreshold, the controller would do nothing. Track
    // time spent in that gray zone and force a step down after boundaryTimeoutMs.
    // Uses hysteresis so brief dips below zoneHigh don't reset the timer.
    this.boundaryStart = null;
    this.boundaryTimeoutMs = 60000;
    this.boundaryResetMargin = 3;   // pp below zoneHigh that HR must drop to before timer resets
    this.boundaryBelowTicks = 0;    // ticks HR has been clearly below zoneHigh

    // Sustained-high tracking: when HR has been above zoneHigh for a long time,
    // bypass the accumulation cap so the controller can keep dropping speed/incline
    // (e.g. all the way to walking pace if needed). The user explicitly wants this.
    this.sustainedHighStart = null;
    this.sustainedHighThresholdMs = 90000;

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

      if (this.targetZone >= 4 && !this.precautionApplied && dropoutMs >= 30000) {
        this.precautionApplied = true;
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
      this.precautionApplied = false;
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

    // Determine if HR is above or below target zone for interval selection
    const hrPctPrecheck = getHRPercent(
      this.ringBuffer.reduce((a, b) => a + b, 0) / this.ringBuffer.length, this.maxHR
    );
    const isOverZone = hrPctPrecheck > this.zoneHigh;
    let currentInterval = isOverZone ? this.adjustIntervalDown : this.adjustIntervalUp;
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

    // Hysteresis-tolerant boundary tracking. boundaryStart only resets after HR has
    // been clearly below zoneHigh (by boundaryResetMargin) for several ticks — brief
    // dips don't reset the timer.
    if (hrPct > this.zoneHigh) {
      if (!this.boundaryStart) this.boundaryStart = Date.now();
      this.boundaryBelowTicks = 0;
    } else if (hrPct < this.zoneHigh - this.boundaryResetMargin) {
      this.boundaryBelowTicks++;
      if (this.boundaryBelowTicks >= 5) {
        this.boundaryStart = null;
        this.sustainedHighStart = null;
      }
    }

    // Sustained-high tracking parallels boundaryStart but uses overThreshold (well
    // above zone). When HR has been clearly above zone for a long time, allow the
    // controller to bypass the accumulation cap.
    if (hrPct > overThreshold) {
      if (!this.sustainedHighStart) this.sustainedHighStart = Date.now();
    }

    if (hrPct > overThreshold) {
      const zonesOver = Math.max(1, Math.floor((hrPct - this.zoneHigh) / 10));
      const stepSize = Math.min(0.8, 0.3 + (zonesOver - 1) * 0.25);
      this._adjust(-stepSize, 'over_zone');

    } else if (hrPct > this.zoneHigh && this.boundaryStart &&
               (Date.now() - this.boundaryStart) >= this.boundaryTimeoutMs) {
      // Sustained at boundary (between zoneHigh and zoneHigh+hysteresis) —
      // push speed down one notch to escape the gray zone.
      this._adjust(-0.3, 'boundary_timeout');
      this.boundaryStart = Date.now(); // restart timer so it can fire again if still stuck

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
    const cooldownTicks = direction === 'down' ? 15 : 30;

    // Sustained-high override: when HR has been clearly above zone for a long time,
    // skip the direction-change and accumulation-cap brakes for downward steps.
    // This lets the controller keep descending past the cap when the runner needs
    // to cool down — including all the way to walking pace.
    const sustainedHigh = direction === 'down'
      && this.sustainedHighStart
      && (Date.now() - this.sustainedHighStart) >= this.sustainedHighThresholdMs;

    if (!sustainedHigh && this.lastDirection && this.lastDirection !== direction) {
      this.accumulatedChange = 0;
      this.directionChangeCooldownUntil = this.tickCount + cooldownTicks;
      this.lastDirection = direction;
      this.onStatusChange({ action: 'direction_change_cooldown', reason });
      return;
    }
    this.lastDirection = direction;

    const cap = direction === 'down' ? this.accumulationCapDown : this.accumulationCapUp;
    this.accumulatedChange += Math.abs(step);
    if (!sustainedHigh && this.accumulatedChange > cap) {
      this.accumulatedChange = 0;
      this.directionChangeCooldownUntil = this.tickCount + cooldownTicks;
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
