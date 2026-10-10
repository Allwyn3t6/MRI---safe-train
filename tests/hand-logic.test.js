// node --test tests/hand-logic.test.js   (synthetic hands; no camera or model needed)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const H = require(path.join(__dirname, '..', 'simulator', 'hand-logic.js'));

// Build 21 landmarks. Wrist low in the frame, middle knuckle above it: hand scale 0.2.
// Fingers are extended (tips high) or curled (tips folded down to the palm).
function hand({ tip = { x: 0.5, y: 0.3 }, pinch = false, palm = false } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.6, z: 0 }));
  lm[0] = { x: 0.5, y: 0.8, z: 0 };   // wrist
  lm[9] = { x: 0.5, y: 0.66, z: 0 };  // middle knuckle (scale = 0.14)
  const fingers = { index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };
  ['index', 'middle', 'ring', 'pinky'].forEach((name, i) => {
    const [mcp, pip, dip, tipIdx] = fingers[name];
    const x = name === 'index' ? tip.x : 0.5 + (i + 1) * 0.04;
    const extended = palm || name === 'index';      // pointing or open: tip far from wrist
    lm[mcp] = { x, y: 0.66, z: 0 };
    lm[pip] = { x, y: 0.62, z: 0 };                 // joint close to the wrist
    lm[tipIdx] = extended ? { x, y: 0.2, z: 0 } : { x, y: 0.7, z: 0 }; // curled: folded to the palm
  });
  lm[8] = { x: tip.x, y: tip.y, z: 0 };             // the pointing fingertip is where the user points
  // Thumb: far from the index tip normally, touching it when pinching.
  lm[4] = pinch ? { x: tip.x + 0.02, y: tip.y, z: 0 } : { x: tip.x + 0.15, y: tip.y + 0.25, z: 0 };
  return lm;
}
const ev = (list, type) => list.filter(e => e.type === type);

test('pointing with the index finger reports position and no tap', () => {
  const g = new H.HandGestures({ smooth: 1 });
  const out = g.update(hand({ tip: { x: 0.5, y: 0.5 } }), 0);
  assert.equal(ev(out, 'pos').length, 1);
  assert.equal(ev(out, 'tap').length, 0);
});

test('quick pinch without movement is a tap', () => {
  const g = new H.HandGestures({ smooth: 1 });
  g.update(hand({ tip: { x: 0.5, y: 0.5 } }), 0);
  g.update(hand({ tip: { x: 0.5, y: 0.5 }, pinch: true }), 100);
  const out = g.update(hand({ tip: { x: 0.5, y: 0.5 } }), 250);
  assert.equal(ev(out, 'tap').length, 1);
});

test('slow pinch is not a tap', () => {
  const g = new H.HandGestures({ smooth: 1 });
  g.update(hand({ tip: { x: 0.5, y: 0.5 }, pinch: true }), 0);
  const out = g.update(hand({ tip: { x: 0.5, y: 0.5 } }), 900);
  assert.equal(ev(out, 'tap').length, 0);
});

test('pinch and move is a drag, not a tap', () => {
  const g = new H.HandGestures({ smooth: 1 });
  g.update(hand({ tip: { x: 0.5, y: 0.5 }, pinch: true }), 0);
  const moved = g.update(hand({ tip: { x: 0.4, y: 0.5 }, pinch: true }), 200);
  const drag = ev(moved, 'drag');
  assert.equal(drag.length, 1);
  assert.ok(drag[0].dx !== 0);
  const end = g.update(hand({ tip: { x: 0.4, y: 0.5 } }), 400);
  assert.equal(ev(end, 'tap').length, 0, 'a drag must not also count as a tap');
});

test('open palm held still resets the view once, then waits for the cooldown', () => {
  const g = new H.HandGestures({ smooth: 1, palmHoldMs: 1000, palmCooldownMs: 2500 });
  const palm = hand({ palm: true, tip: { x: 0.5, y: 0.5 } });
  assert.equal(ev(g.update(palm, 0), 'reset').length, 0);
  assert.equal(ev(g.update(palm, 1100), 'reset').length, 1);
  assert.equal(ev(g.update(palm, 2200), 'reset').length, 0, 'cooldown');
  g.update(hand({ tip: { x: 0.5, y: 0.5 } }), 2300); // hand changes shape
  assert.equal(ev(g.update(palm, 4000), 'reset').length, 0, 'hold timer restarts');
  assert.equal(ev(g.update(palm, 5200), 'reset').length, 1, 'after cooldown and a new hold');
});

test('losing the hand reports lost and clears gesture state', () => {
  const g = new H.HandGestures({ smooth: 1 });
  g.update(hand({ tip: { x: 0.5, y: 0.5 }, pinch: true }), 0);
  const out = g.update(null, 50);
  assert.deepEqual(out.map(e => e.type), ['lost']);
  assert.equal(g.pinched, false);
});

test('camera to screen mapping mirrors and stretches the central 80%', () => {
  assert.equal(H.toScreen(0.1, 0.1).x, 1);   // left of camera → right of screen (mirror)
  assert.equal(H.toScreen(0.9, 0.5).x, 0);
  assert.ok(Math.abs(H.toScreen(0.5, 0.5).x - 0.5) < 1e-9);
  assert.equal(H.toScreen(-1, 2).y, 1);      // clamped
});

// ---- two hands: zoom from palm distance, hand assignment, quiet mode ----
const shift = (lm, dx) => lm.map(p => ({ ...p, x: p.x + dx }));
const palm = (cx) => shift(hand({ palm: true }), cx - 0.5); // open palm centred at x = cx

test('moving two open palms apart zooms in, together zooms out', () => {
  const z = new H.TwoPalmZoom({ engageMs: 0, smooth: 1, deadzone: 0 });
  z.update(palm(0.3), palm(0.7), 0);             // engage
  const apart = z.update(palm(0.2), palm(0.8), 100);
  const dzIn = ev(apart, 'zoom')[0].dz;
  assert.ok(dzIn > 0, 'apart should be positive (zoom in)');
  const together = z.update(palm(0.35), palm(0.65), 200);
  assert.ok(ev(together, 'zoom')[0].dz < 0, 'together should be negative (zoom out)');
});

test('zoom starts only after both palms have been open for engageMs', () => {
  const z = new H.TwoPalmZoom({ engageMs: 250 });
  assert.equal(ev(z.update(palm(0.3), palm(0.7), 0), 'zoomOn').length, 0);
  assert.equal(ev(z.update(palm(0.3), palm(0.7), 200), 'zoomOn').length, 0);
  assert.equal(ev(z.update(palm(0.3), palm(0.7), 260), 'zoomOn').length, 1);
});

test('one palm alone never zooms', () => {
  const z = new H.TwoPalmZoom({ engageMs: 0 });
  for (let t = 0; t < 1000; t += 100) assert.equal(z.update(palm(0.4), null, t).length, 0);
});

test('zoom ends once after a palm has been gone for releaseMs', () => {
  const z = new H.TwoPalmZoom({ engageMs: 0, releaseMs: 200 });
  z.update(palm(0.3), palm(0.7), 0);
  assert.equal(z.update(null, palm(0.7), 100).length, 0, 'short gap is ignored');
  const off = z.update(null, palm(0.7), 350);
  assert.equal(ev(off, 'zoomOff').length, 1);
  assert.equal(ev(z.update(null, palm(0.7), 400), 'zoomOff').length, 0, 'only one zoomOff');
});

test('quiet mode keeps the pointer but pauses taps, drags and palm reset', () => {
  const g = new H.HandGestures({ smooth: 1 });
  g.update(hand({ tip: { x: 0.5, y: 0.5 }, pinch: true }), 0);
  const quiet = g.update(hand({ tip: { x: 0.2, y: 0.5 }, pinch: true }), 100, { quiet: true });
  assert.equal(ev(quiet, 'drag').length, 0);
  assert.equal(ev(quiet, 'pos').length, 1);
  const palmHeld = [0, 600, 1200, 1800].map(t => g.update(hand({ palm: true, tip: { x: 0.5, y: 0.5 } }), 2000 + t, { quiet: true }));
  assert.equal(palmHeld.flat().filter(e => e.type === 'reset').length, 0);
});

test('pickHands uses the user-right label to choose the aiming hand', () => {
  const a = { lm: hand(), label: 'Left' }, b = { lm: hand(), label: 'Right' };
  const r = H.pickHands([a, b], 'Left');
  assert.equal(r.aim, a); assert.equal(r.other, b);
  const r2 = H.pickHands([a, b], 'Right');
  assert.equal(r2.aim, b); assert.equal(r2.other, a);
});

test('pickHands with one hand, or with no usable labels, still aims', () => {
  const a = { lm: hand(), label: 'Right' };
  assert.equal(H.pickHands([a], 'Left').aim, a);
  assert.equal(H.pickHands([a], 'Left').other, null);
  const x = { lm: hand(), label: '' }, y = { lm: hand(), label: '' };
  const r = H.pickHands([x, y], 'Left');
  assert.equal(r.aim, x); assert.equal(r.other, y);
  assert.equal(H.pickHands([], 'Left').aim, null);
});
