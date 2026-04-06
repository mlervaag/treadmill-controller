class CoachingEngine {
  constructor({ maxHR, segments, ttsService, onMessage }) {
    this.maxHR = maxHR;
    this.segments = segments || [];
    this.ttsService = ttsService;
    this.onMessage = onMessage; // callback(text, filename)

    // State tracking
    this.lastSegmentIndex = -1;
    this.overZoneStart = null;
    this.underZoneStart = null;
    this.lastZoneWarningTime = null;
    this.zoneWarningActive = false;
    this.lastMessageTime = 0;
    this.lastKmMilestone = 0;
    this.halfwayAnnounced = false;
    this.lastMinuteAnnounced = false;
    this.pendingMessages = []; // { priority, text } — lower number = higher priority
    this.active = false;
    this.processing = false; // async guard
  }

  static getZone(hr, maxHR) {
    if (!hr || hr <= 0 || !maxHR) return null;
    const pct = (hr / maxHR) * 100;
    if (pct < 60) return 1;
    if (pct < 70) return 2;
    if (pct < 80) return 3;
    if (pct < 90) return 4;
    return 5;
  }

  start() {
    this.active = true;
    this.lastSegmentIndex = -1;
    this.overZoneStart = null;
    this.underZoneStart = null;
    this.lastZoneWarningTime = null;
    this.zoneWarningActive = false;
    this.lastMessageTime = 0;
    this.lastKmMilestone = 0;
    this.halfwayAnnounced = false;
    this.lastMinuteAnnounced = false;
    this.pendingMessages = [];
    this.processing = false;
  }

  stop() {
    this.active = false;
  }

  /**
   * Called with each treadmill_state update (~every 2 seconds).
   * Evaluates triggers and dispatches highest-priority message.
   */
  async update(state) {
    if (!this.active || this.processing) return;

    const now = Date.now();
    const cooldown = 15000;

    const hr = state.heartRate;
    const zone = CoachingEngine.getZone(hr, this.maxHR);
    const segmentIndex = state.workout ? state.workout.currentSegmentIndex : null;
    const segment = segmentIndex !== null && segmentIndex !== undefined ? this.segments[segmentIndex] : null;
    const targetZone = segment ? (segment.target_max_zone || null) : null;

    // --- Trigger 1: Segment transition (priority 2) ---
    if (segmentIndex !== null && segmentIndex !== this.lastSegmentIndex) {
      console.log(`[Coach] Segment change: ${this.lastSegmentIndex} → ${segmentIndex}, segments loaded: ${this.segments.length}`);
      if (this.lastSegmentIndex >= 0) {
        // Reset zone tracking on segment change
        this.overZoneStart = null;
        this.underZoneStart = null;
        this.zoneWarningActive = false;
        this.lastZoneWarningTime = null;

        const msg = this._buildSegmentMessage(segment, segmentIndex);
        if (msg) this.pendingMessages.push({ priority: 2, text: msg });
      }
      this.lastSegmentIndex = segmentIndex;
    }

    // --- Trigger 2: Zone violation (priority 1) ---
    // Skip if HR zone controller is actively managing the zone
    if (state.hrZoneControl && state.hrZoneControl.active && !state.hrZoneControl.paused) {
      this.overZoneStart = null;
      this.underZoneStart = null;
      this.zoneWarningActive = false;
    } else if (targetZone && zone) {
      if (zone > targetZone) {
        // Over target zone
        this.underZoneStart = null; // reset under-timer
        if (!this.overZoneStart) {
          this.overZoneStart = now;
        } else if (now - this.overZoneStart >= 60000) {
          const canWarn = !this.lastZoneWarningTime || (now - this.lastZoneWarningTime >= 120000);
          if (canWarn) {
            const minutes = Math.ceil((now - this.overZoneStart) / 60000);
            const minStr = minutes === 1 ? 'minutt' : 'minutter';
            const msg = `Pulsen din har vært i sone ${zone} i ${minutes} ${minStr}. Målsonen er ${targetZone}, vurder å senke farten.`;
            this.pendingMessages.push({ priority: 1, text: msg });
            this.lastZoneWarningTime = now;
            this.zoneWarningActive = true;
          }
        }
      } else if (zone < targetZone - 1) {
        // Well under target zone (2+ zones below)
        this.overZoneStart = null; // reset over-timer
        if (!this.underZoneStart) {
          this.underZoneStart = now;
        } else if (now - this.underZoneStart >= 60000) {
          const canWarn = !this.lastZoneWarningTime || (now - this.lastZoneWarningTime >= 120000);
          if (canWarn) {
            const msg = `Du er i sone ${zone}. Målsonen er ${targetZone}, du kan øke intensiteten litt.`;
            this.pendingMessages.push({ priority: 1, text: msg });
            this.lastZoneWarningTime = now;
            this.zoneWarningActive = true;
          }
        }
      } else {
        // In or near target zone
        if (this.zoneWarningActive) {
          this.pendingMessages.push({ priority: 1, text: 'Bra, du er tilbake i målsonen.' });
          this.zoneWarningActive = false;
        }
        this.overZoneStart = null;
        this.underZoneStart = null;
        this.lastZoneWarningTime = null;
      }
    }

    // --- Trigger 3: Milestones (priority 3) ---
    if (state.workout) {
      const totalDuration = state.workout.totalDuration || 0;
      const elapsed = state.workout.elapsedInWorkout || 0;
      const remaining = totalDuration - elapsed;

      // Halfway
      if (!this.halfwayAnnounced && totalDuration > 0 && elapsed >= totalDuration / 2) {
        const minLeft = Math.round(remaining / 60);
        this.pendingMessages.push({ priority: 3, text: `Halvveis! ${minLeft} minutter igjen.` });
        this.halfwayAnnounced = true;
      }

      // Last minute
      if (!this.lastMinuteAnnounced && remaining > 0 && remaining <= 60) {
        this.pendingMessages.push({ priority: 3, text: 'Ett minutt igjen.' });
        this.lastMinuteAnnounced = true;
      }
    }

    // Distance milestones (every km)
    if (state.distance) {
      const km = Math.floor(state.distance);
      if (km > this.lastKmMilestone && km >= 1) {
        this.pendingMessages.push({ priority: 3, text: `Du har løpt ${km} kilometer.` });
        this.lastKmMilestone = km;
      }
    }

    // --- Dispatch highest-priority message if cooldown allows ---
    if (this.pendingMessages.length > 0) {
      console.log(`[Coach] ${this.pendingMessages.length} pending msg(s), cooldown: ${now - this.lastMessageTime}ms / ${cooldown}ms`);
    }
    if (this.pendingMessages.length > 0 && (now - this.lastMessageTime) >= cooldown) {
      this.processing = true;
      try {
        this.pendingMessages.sort((a, b) => a.priority - b.priority);
        const best = this.pendingMessages.shift();
        this.pendingMessages = []; // Discard lower-priority messages

        this.lastMessageTime = now;
        const filename = await this.ttsService.speak(best.text);
        this.onMessage(best.text, filename);
      } finally {
        this.processing = false;
      }
    }
  }

  _buildSegmentMessage(segment, index) {
    if (!segment) return null;

    const name = segment.segment_name || segment.name || `Segment ${index + 1}`;
    const speed = segment.speed_kmh || segment.speed || 0;
    const incline = segment.incline_percent || segment.incline || 0;
    const duration = segment.duration_seconds || segment.duration || 0;
    const targetZone = segment.target_max_zone;
    const isLast = index === this.segments.length - 1;
    const durMin = Math.ceil(duration / 60);
    const durStr = durMin === 1 ? '1 minutt' : `${durMin} minutter`;

    if (isLast) {
      return `Siste segment: ${name}. ${durStr} igjen.`;
    }

    let msg = `Nytt segment: ${name}. ${speed} kilometer i timen`;
    if (incline > 0) msg += `, ${incline} prosent stigning`;
    msg += `, ${durStr}.`;
    if (targetZone) msg += ` Målsone er ${targetZone}.`;
    return msg;
  }
}

module.exports = CoachingEngine;
