/*
 * MRISafe Twin — handheld controller mapping (pure, no DOM)
 * Browser: window.MRIController. Node: require().
 *
 * Tilt works like a joystick: inside the dead zone nothing moves; beyond it the
 * speed rises smoothly up to a maximum. This avoids yaw drift entirely (no absolute
 * heading is needed) and is easy to hold still.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MRIController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = { deadDeg: 7, fullDeg: 32, maxOrbitDegPerSec: 75, maxPointerPxPerSec: 950, invertPitch: false };

  /** Map one tilt angle (deg) to a signed fraction in [-1, 1] with a dead zone and smooth ramp. */
  function shape(angle, cfg = DEFAULTS) {
    const a = Math.abs(angle);
    if (!Number.isFinite(a) || a <= cfg.deadDeg) return 0;
    const k = Math.min(1, (a - cfg.deadDeg) / (cfg.fullDeg - cfg.deadDeg));
    return Math.sign(angle) * k * k * (3 - 2 * k); // smoothstep
  }

  /** Orbit increments (radians) for this time step. roll → azimuth, pitch → elevation. */
  function orbitStep(rollDeg, pitchDeg, dtSec, cfg = DEFAULTS) {
    const dt = Math.max(0, Math.min(dtSec, 0.2));
    const rate = cfg.maxOrbitDegPerSec * Math.PI / 180;
    return {
      dAz: -shape(rollDeg, cfg) * rate * dt || 0,
      dEl: (cfg.invertPitch ? -1 : 1) * shape(pitchDeg, cfg) * rate * dt,
    };
  }

  /** Pointer movement (pixels) for this time step. */
  function pointerStep(rollDeg, pitchDeg, dtSec, cfg = DEFAULTS) {
    const dt = Math.max(0, Math.min(dtSec, 0.2));
    return {
      dx: shape(rollDeg, cfg) * cfg.maxPointerPxPerSec * dt,
      dy: (cfg.invertPitch ? -1 : 1) * shape(pitchDeg, cfg) * cfg.maxPointerPxPerSec * dt,
    };
  }

  /** Wand meter: change in field magnitude (µT) → 0..1 level and a plain-language reading. */
  function wandLevel(dmagUT) {
    const d = Math.abs(dmagUT || 0);
    const level = Math.min(1, d / 60);
    const text = d < 3 ? 'Background' : d < 15 ? 'Weak change' : d < 40 ? 'Strong change' : 'Very strong change';
    return { level, text };
  }

  /* Pad meaning in each part of the app. */
  const PAD_MAP = {
    train: {
      T1: 'Screening sign-off', T2: 'Equipment verified', T3: 'Zone IV access', T4: 'Final clearance', T5: 'Proceed to scan', T6: 'Reset attempt',
    },
    learn: {
      T1: 'Previous chapter', T2: 'Next chapter', T3: 'Peel a layer', T4: 'Restore a layer', T5: 'Explode / assemble', T6: 'Reset view',
    },
  };
  const GESTURE_MAP = {
    train: { tap: 'Select what the cursor is on', double_tap: 'Reset the camera', flick_left: 'Toggle orbit / point', flick_right: 'Toggle orbit / point' },
    learn: { tap: 'Play the chapter action', double_tap: 'Reset the camera', flick_left: 'Previous chapter', flick_right: 'Next chapter' },
  };

  return { DEFAULTS, shape, orbitStep, pointerStep, wandLevel, PAD_MAP, GESTURE_MAP };
});
