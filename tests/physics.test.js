// node --test tests/physics.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../simulator/physics.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('Larmor frequency matches 42.58 MHz/T', () => {
  near(P.larmorMHz(1.5), 63.87, 0.01, '1.5 T');
  near(P.larmorMHz(3.0), 127.73, 0.01, '3 T');
});

test('slice thickness from bandwidth and gradient', () => {
  // 1 kHz bandwidth, 10 mT/m → 2.35 mm
  near(P.sliceThicknessMm(1, 10), 2.349, 0.005, 'thickness');
  // doubling the gradient halves the slice
  near(P.sliceThicknessMm(1, 20), P.sliceThicknessMm(1, 10) / 2, 1e-9, 'inverse with G');
  // offset: 4.258 kHz at 10 mT/m → 10 mm
  near(P.sliceOffsetMm(4.2577478, 10), 10, 1e-6, 'offset');
  assert.equal(P.sliceThicknessMm(1, 0), Infinity);
});

test('relaxation starts at the flipped state and returns to equilibrium', () => {
  const r0 = P.relax(0, 'wm', 90);
  near(r0.mz, 0, 1e-12, 'Mz after 90°');
  near(r0.mxy, 1, 1e-12, 'Mxy after 90°');
  const rT1 = P.relax(P.TISSUES.wm.t1, 'wm', 90);
  near(rT1.mz, 1 - Math.exp(-1), 1e-9, 'Mz at t = T1 is 63%');
  const rT2 = P.relax(P.TISSUES.wm.t2, 'wm', 90);
  near(rT2.mxy, Math.exp(-1), 1e-9, 'Mxy at t = T2 is 37%');
  near(P.relax(0, 'csf', 180).mz, -1, 1e-12, 'inversion');
});

test('T1-weighted contrast: fat > WM > GM > CSF', () => {
  const { TR, TE } = P.PRESETS.T1;
  const s = k => P.signalSE(k, TR, TE);
  assert.ok(s('fat') > s('wm') && s('wm') > s('gm') && s('gm') > s('csf'));
});

test('T2-weighted contrast: CSF is brightest, GM brighter than WM', () => {
  const { TR, TE } = P.PRESETS.T2;
  const s = k => P.signalSE(k, TR, TE);
  assert.ok(s('csf') > s('gm') && s('gm') > s('wm'));
});

test('FFT round trip recovers the image', () => {
  const N = 32;
  const lab = P.headPhantom(N);
  const img = P.phantomImage(lab, 500, 15);
  const re = Float64Array.from(img), im = new Float64Array(N * N);
  P.fft2d(re, im, N, false);
  P.fft2d(re, im, N, true);
  for (let i = 0; i < N * N; i++) near(re[i], img[i], 1e-9, 'pixel ' + i);
});

test('full k-space reconstruction equals the phantom; centre-only is blurrier', () => {
  const N = 64;
  const img = P.phantomImage(P.headPhantom(N), 500, 15);
  const kRe = Float64Array.from(img), kIm = new Float64Array(N * N);
  P.fft2d(kRe, kIm, N, false);
  const full = P.reconstruct(kRe, kIm, N, () => true);
  let err = 0; for (let i = 0; i < N * N; i++) err = Math.max(err, Math.abs(full[i] - img[i]));
  assert.ok(err < 1e-9, 'full recon error ' + err);
  const centre = P.reconstruct(kRe, kIm, N, r => Math.abs(r - N / 2) < 6);
  let diff = 0; for (let i = 0; i < N * N; i++) diff += Math.abs(centre[i] - img[i]);
  assert.ok(diff > 1, 'centre-only differs from full');
});

test('FFT rejects non power-of-two length', () => {
  assert.throws(() => P.fft1d(new Float64Array(6), new Float64Array(6)));
});
