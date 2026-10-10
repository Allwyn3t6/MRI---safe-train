// node --test tests/controller.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../simulator/controller.js');

test('dead zone: small tilts do nothing', () => {
  assert.equal(C.shape(0), 0);
  assert.equal(C.shape(6.9), 0);
  assert.equal(C.shape(-7), 0);
  assert.equal(C.shape(NaN), 0);
});

test('ramp is smooth, signed and saturates', () => {
  assert.ok(C.shape(10) > 0 && C.shape(10) < C.shape(20));
  assert.equal(C.shape(-20), -C.shape(20));
  assert.equal(C.shape(32), 1);
  assert.equal(C.shape(80), 1);
});

test('orbit step scales with time and caps large gaps', () => {
  const a = C.orbitStep(40, 0, 0.1), b = C.orbitStep(40, 0, 0.2), c = C.orbitStep(40, 0, 5);
  assert.ok(Math.abs(b.dAz - 2 * a.dAz) < 1e-12);
  assert.ok(Math.abs(c.dAz - b.dAz) < 1e-12, 'dt is capped at 0.2 s');
  const full = C.DEFAULTS.maxOrbitDegPerSec * Math.PI / 180 * 0.1;
  assert.ok(Math.abs(Math.abs(a.dAz) - full) < 1e-12);
  assert.equal(C.orbitStep(3, 3, 0.1).dAz, 0);
});

test('pointer step moves right for positive roll, down for positive pitch', () => {
  const p = C.pointerStep(30, 30, 0.05);
  assert.ok(p.dx > 0 && p.dy > 0);
  const inv = C.pointerStep(30, 30, 0.05, { ...C.DEFAULTS, invertPitch: true });
  assert.ok(inv.dy < 0);
});

test('wand meter levels', () => {
  assert.equal(C.wandLevel(1).text, 'Background');
  assert.equal(C.wandLevel(-20).text, 'Strong change');
  assert.equal(C.wandLevel(200).level, 1);
});

test('every pad and gesture has a meaning in both modes', () => {
  for (const mode of ['train', 'learn']) {
    for (const p of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) assert.ok(C.PAD_MAP[mode][p]);
    for (const g of ['tap', 'double_tap', 'flick_left', 'flick_right']) assert.ok(C.GESTURE_MAP[mode][g]);
  }
});
