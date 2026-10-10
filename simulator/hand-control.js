/* MRISafe Twin hand control: webcam + MediaPipe Hand Landmarker, run entirely in this browser.
 * Frames never leave the computer. Start only on a user click (the browser asks for camera access).
 *
 *   MRIHands.start({ onEvent, onStatus, preview })   → Promise (rejects with a readable message)
 *   MRIHands.stop()
 *   MRIHands.setSwapHands(bool)   flip which detected hand is treated as the user's right hand
 *
 * Two hands: the right hand aims, taps and orbits; both open palms zoom (see hand-logic.js).
 *
 * Model: simulator/models/hand_landmarker.task (see vendor/mediapipe/README.md). Library: vendored
 * under vendor/mediapipe, with the pinned jsDelivr copy as a fallback.
 */
(function () {
  const VERSION = '0.10.14';
  const LIB_LOCAL = './vendor/mediapipe/vision_bundle.mjs';
  const LIB_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/vision_bundle.mjs`;
  const WASM_LOCAL = './vendor/mediapipe/wasm';
  const WASM_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`;
  const MODEL_LOCAL = './models/hand_landmarker.task';
  const MODEL_CDN = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
  const LOST_AFTER_MS = 400;
  // MediaPipe labels hands as if the image were a mirror. We pass the camera frame unflipped, so the
  // user's right hand is labelled "Left". The "Swap hands" button in the shell flips this if needed.
  const USER_RIGHT_LABEL_UNFLIPPED = 'Left';

  const S = { running: false, stream: null, video: null, canvas: null, ctx: null, lm: null, lib: null,
    landmarker: null, gestures: null, zoom: null, onEvent: null, onStatus: null, raf: 0, lastT: -1, seenAt: 0,
    hadHand: false, swapHands: false, status: 'off' };
  const userRightLabel = () => (S.swapHands ? 'Right' : USER_RIGHT_LABEL_UNFLIPPED);

  function status(state, detail) { S.status = state; if (S.onStatus) S.onStatus(state, detail || ''); }

  async function importLibrary() {
    let lastErr = null;
    for (const url of [LIB_LOCAL, LIB_CDN]) {
      try { return { lib: await import(url), wasm: url === LIB_LOCAL ? WASM_LOCAL : WASM_CDN }; }
      catch (e) { lastErr = e; }
    }
    throw new Error('The hand-tracking library could not be loaded (' + (lastErr && lastErr.message) + ').');
  }

  async function loadLandmarker() {
    if (S.landmarker) return;
    status('loading', 'Loading the hand model');
    const { lib, wasm } = await importLibrary();
    const vision = await lib.FilesetResolver.forVisionTasks(wasm);
    let lastErr = null;
    for (const model of [MODEL_LOCAL, MODEL_CDN]) {
      for (const delegate of ['GPU', 'CPU']) {
        try {
          S.landmarker = await lib.HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: model, delegate },
            runningMode: 'VIDEO', numHands: 2,
            minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
          });
          return;
        } catch (e) { lastErr = e; }
      }
    }
    throw new Error('The hand model is missing. Save hand_landmarker.task into simulator/models/ (see vendor/mediapipe/README.md), or connect to the internet once.' + (lastErr ? ' ' + lastErr.message : ''));
  }

  async function start(opts) {
    if (S.running) return;
    S.onEvent = opts.onEvent; S.onStatus = opts.onStatus;
    if (!window.isSecureContext) throw new Error('The camera needs this page to be opened from localhost or https.');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot use the camera. Use Chrome or Edge.');
    if (!window.MRIHandLogic) throw new Error('Hand logic did not load.');
    status('camera', 'Waiting for camera access');
    S.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    S.video = document.createElement('video');
    S.video.playsInline = true; S.video.muted = true; S.video.srcObject = S.stream;
    await S.video.play();
    S.canvas = opts.preview || null;
    S.ctx = S.canvas ? S.canvas.getContext('2d') : null;
    S.gestures = new MRIHandLogic.HandGestures();
    S.zoom = new MRIHandLogic.TwoPalmZoom();
    S.running = true;
    try { await loadLandmarker(); }
    catch (e) { stop(); throw e; }
    S.lastT = -1; S.seenAt = 0; S.lostSent = true;
    status('tracking', 'Show one hand to the camera, or both palms to zoom');
    S.raf = requestAnimationFrame(frame);
  }

  function stop() {
    S.running = false;
    cancelAnimationFrame(S.raf);
    if (S.stream) S.stream.getTracks().forEach(t => t.stop());
    S.stream = null; S.video = null; S.hadHand = false;
    if (S.zoom) S.zoom.reset();
    if (S.ctx && S.canvas) S.ctx.clearRect(0, 0, S.canvas.width, S.canvas.height);
    status('off', '');
  }

  function drawPreview(hands) {
    if (!S.ctx) return;
    const c = S.canvas, x = S.ctx, w = c.width, h = c.height;
    x.save();
    x.translate(w, 0); x.scale(-1, 1); // mirror, like the screen the user sees
    x.drawImage(S.video, 0, 0, w, h);
    x.restore();
    x.fillStyle = '#45d6ec';
    for (const hand of hands) for (const p of hand.lm) { x.beginPath(); x.arc((1 - p.x) * w, p.y * h, 2.4, 0, Math.PI * 2); x.fill(); }
  }

  function frame() {
    if (!S.running) return;
    S.raf = requestAnimationFrame(frame);
    const v = S.video;
    if (!v || v.readyState < 2 || !S.landmarker) return;
    if (v.currentTime === S.lastT) return; // one detection per new camera frame
    S.lastT = v.currentTime;
    const now = performance.now();
    let res = null;
    try { res = S.landmarker.detectForVideo(v, now); } catch (e) { return; }
    const detected = (res && res.landmarks ? res.landmarks : []).map((lm, i) => {
      const cat = res.handedness && res.handedness[i] && res.handedness[i][0];
      return { lm, label: cat ? cat.categoryName : '' };
    });
    const { aim, other } = MRIHandLogic.pickHands(detected, userRightLabel());
    const aimLm = aim ? aim.lm : null;
    drawPreview(detected);

    const zoomEvents = S.zoom.update(aimLm, other ? other.lm : null, now);
    let events = zoomEvents.slice();
    if (aimLm) { S.seenAt = now; S.lostSent = false; events = events.concat(S.gestures.update(aimLm, now, { quiet: S.zoom.engaged })); }
    else if (!S.lostSent && now - S.seenAt > LOST_AFTER_MS) { // brief blinks in detection are ignored
      S.lostSent = true; events = events.concat(S.gestures.update(null, now));
    }
    for (const e of events) {
      if (e.type === 'zoomOn') status('zoom', 'Zoom on: move your palms apart to zoom in, together to zoom out');
      if (e.type === 'zoomOff') status(aimLm ? 'hand' : 'tracking', aimLm ? 'Hand found' : 'Show one hand to the camera, or both palms to zoom');
      if (S.onEvent) S.onEvent(e);
    }
    if (aimLm && !S.hadHand) { S.hadHand = true; status('hand', 'Hand found'); }
    if (!aimLm && S.hadHand && now - S.seenAt > LOST_AFTER_MS) { S.hadHand = false; status('tracking', 'Show one hand to the camera, or both palms to zoom'); }
  }

  window.MRIHands = {
    start, stop,
    setSwapHands(on) { S.swapHands = !!on; },
    get status() { return S.status; },
    get running() { return S.running; },
  };
})();
