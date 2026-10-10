/*
 * MRISafe Twin — MRI physics helpers for the "Inside the Scanner" module
 * ------------------------------------------------------------------
 * Pure JavaScript, no DOM. Browser: window.MRIPhysics. Node: require().
 *
 * These are TEACHING models:
 *  - Larmor frequency and slice-selection relations are exact textbook formulas.
 *  - Relaxation uses the Bloch equations without diffusion, flow or B0 errors.
 *  - Image contrast uses the simplified spin-echo signal equation.
 *  - The "image" is a synthetic head phantom passed through a real 2D FFT,
 *    not a reconstruction of acquired data.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MRIPhysics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Gyromagnetic ratio of hydrogen-1, divided by 2π (MHz per tesla)
  const GAMMA_BAR_MHZ_PER_T = 42.577478;

  /** Larmor frequency in MHz for field B0 in tesla. */
  function larmorMHz(B0) { return GAMMA_BAR_MHZ_PER_T * B0; }

  /**
   * Slice thickness in mm from RF bandwidth (kHz) and gradient strength (mT/m).
   * Δz = BW / (γ̄ · G)
   */
  function sliceThicknessMm(bwKHz, gradMTperM) {
    const hzPerM = GAMMA_BAR_MHZ_PER_T * 1e6 * (gradMTperM / 1000);
    if (hzPerM <= 0) return Infinity;
    return (bwKHz * 1000 / hzPerM) * 1000;
  }

  /** Slice centre offset in mm for an RF frequency offset (kHz) under gradient G (mT/m). */
  function sliceOffsetMm(offsetKHz, gradMTperM) {
    const hzPerM = GAMMA_BAR_MHZ_PER_T * 1e6 * (gradMTperM / 1000);
    if (hzPerM <= 0) return 0;
    return (offsetKHz * 1000 / hzPerM) * 1000;
  }

  /** Frequency shift (kHz) at position z (m) from isocentre under gradient G (mT/m). */
  function frequencyShiftKHz(zM, gradMTperM) {
    return GAMMA_BAR_MHZ_PER_T * 1e6 * (gradMTperM / 1000) * zM / 1000;
  }

  /*
   * Tissue parameters — APPROXIMATE values at 1.5 T for teaching.
   * Published T1/T2 values vary with field strength, method and source.
   * pd = relative proton density.
   */
  const TISSUES = {
    wm:   { name: 'White matter',          pd: 0.69, t1: 790,  t2: 92 },
    gm:   { name: 'Grey matter',           pd: 0.78, t1: 1100, t2: 100 },
    csf:  { name: 'Cerebrospinal fluid',   pd: 1.00, t1: 4000, t2: 2000 },
    fat:  { name: 'Fat',                   pd: 0.90, t1: 260,  t2: 85 },
    bone: { name: 'Cortical bone',         pd: 0.05, t1: 500,  t2: 1 },
  };

  /** Simplified spin-echo signal: S = PD · (1 − e^(−TR/T1)) · e^(−TE/T2). */
  function signalSE(tissue, TR, TE) {
    const t = typeof tissue === 'string' ? TISSUES[tissue] : tissue;
    return t.pd * (1 - Math.exp(-TR / t.t1)) * Math.exp(-TE / t.t2);
  }

  const PRESETS = {
    T1: { name: 'T1-weighted', TR: 500, TE: 15, note: 'Short TR, short TE: tissues with short T1 (fat, white matter) are bright; fluid is dark.' },
    T2: { name: 'T2-weighted', TR: 4000, TE: 100, note: 'Long TR, long TE: tissues with long T2 (fluid) are bright.' },
    PD: { name: 'Proton-density', TR: 3000, TE: 15, note: 'Long TR, short TE: contrast mainly reflects how many protons are present.' },
  };

  /**
   * Magnetisation after a flip of `flipDeg` from equilibrium M0 = 1, then free relaxation for tMs.
   * Returns { mz, mxy }.
   */
  function relax(tMs, tissue, flipDeg) {
    const t = typeof tissue === 'string' ? TISSUES[tissue] : tissue;
    const a = flipDeg * Math.PI / 180;
    const mz0 = Math.cos(a), mxy0 = Math.abs(Math.sin(a));
    return {
      mz: 1 - (1 - mz0) * Math.exp(-tMs / t.t1),
      mxy: mxy0 * Math.exp(-tMs / t.t2),
    };
  }

  /* ---------------- synthetic head phantom ---------------- */
  // Each label value maps to a tissue key; 0 = air.
  const LABELS = ['air', 'fat', 'bone', 'csf', 'gm', 'wm'];

  function inEllipse(x, y, cx, cy, a, b) { const dx = (x - cx) / a, dy = (y - cy) / b; return dx * dx + dy * dy <= 1; }

  /** Returns Uint8Array(N*N) of label indices (see LABELS). */
  function headPhantom(N) {
    const lab = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = (i + 0.5) / N * 2 - 1, y = (j + 0.5) / N * 2 - 1;
        let v = 0;
        if (inEllipse(x, y, 0, 0, 0.74, 0.92)) v = 1;            // scalp fat
        if (inEllipse(x, y, 0, 0, 0.69, 0.87)) v = 2;            // skull
        if (inEllipse(x, y, 0, 0, 0.64, 0.82)) v = 3;            // CSF rim
        if (inEllipse(x, y, 0, 0, 0.61, 0.79)) v = 4;            // grey matter
        if (inEllipse(x, y, 0, 0.02, 0.50, 0.67)) v = 5;         // white matter
        // gyri: grey matter fingers into white matter
        for (let k = 0; k < 14; k++) {
          const ang = (k / 14) * Math.PI * 2;
          if (inEllipse(x, y, Math.cos(ang) * 0.47, 0.02 + Math.sin(ang) * 0.63, 0.06, 0.06)) v = 4;
        }
        // ventricles
        if (inEllipse(x, y, -0.13, -0.05, 0.07, 0.24) || inEllipse(x, y, 0.13, -0.05, 0.07, 0.24)) v = 3;
        if (inEllipse(x, y, 0, 0.32, 0.05, 0.05)) v = 3;
        lab[j * N + i] = v;
      }
    }
    return lab;
  }

  /** Image intensities (Float64Array) for a label map under TR/TE. */
  function phantomImage(labels, TR, TE) {
    const out = new Float64Array(labels.length);
    const s = { 0: 0 };
    for (let k = 1; k < LABELS.length; k++) s[k] = signalSE(LABELS[k], TR, TE);
    for (let p = 0; p < labels.length; p++) out[p] = s[labels[p]];
    return out;
  }

  /* ---------------- FFT ---------------- */
  /** In-place radix-2 complex FFT. n must be a power of two. inverse=true includes 1/n scaling. */
  function fft1d(re, im, inverse) {
    const n = re.length;
    if (n & (n - 1)) throw new Error('FFT length must be a power of two');
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  /** 2D FFT on N×N row-major arrays, in place. */
  function fft2d(re, im, N, inverse) {
    const r = new Float64Array(N), c = new Float64Array(N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) { r[x] = re[y * N + x]; c[x] = im[y * N + x]; }
      fft1d(r, c, inverse);
      for (let x = 0; x < N; x++) { re[y * N + x] = r[x]; im[y * N + x] = c[x]; }
    }
    for (let x = 0; x < N; x++) {
      for (let y = 0; y < N; y++) { r[y] = re[y * N + x]; c[y] = im[y * N + x]; }
      fft1d(r, c, inverse);
      for (let y = 0; y < N; y++) { re[y * N + x] = r[y]; im[y * N + x] = c[y]; }
    }
  }

  /** Swap quadrants so the k-space centre is in the middle of the array. */
  function fftshift(a, N) {
    const out = new a.constructor(a.length), h = N >> 1;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out[((y + h) % N) * N + ((x + h) % N)] = a[y * N + x];
    return out;
  }

  /**
   * Reconstruct from a subset of k-space rows (phase-encode lines).
   * kRe/kIm are UNSHIFTED k-space; mask(rowShifted) → boolean where rowShifted 0..N-1 has DC at N/2.
   * Returns magnitude image.
   */
  function reconstruct(kRe, kIm, N, mask) {
    const re = new Float64Array(N * N), im = new Float64Array(N * N), h = N >> 1;
    for (let y = 0; y < N; y++) {
      const shifted = (y + h) % N;
      if (!mask(shifted)) continue;
      for (let x = 0; x < N; x++) { re[y * N + x] = kRe[y * N + x]; im[y * N + x] = kIm[y * N + x]; }
    }
    fft2d(re, im, N, true);
    const mag = new Float64Array(N * N);
    for (let p = 0; p < N * N; p++) mag[p] = Math.hypot(re[p], im[p]);
    return mag;
  }

  return {
    GAMMA_BAR_MHZ_PER_T, larmorMHz, sliceThicknessMm, sliceOffsetMm, frequencyShiftKHz,
    TISSUES, PRESETS, signalSE, relax, LABELS, headPhantom, phantomImage,
    fft1d, fft2d, fftshift, reconstruct,
  };
});
