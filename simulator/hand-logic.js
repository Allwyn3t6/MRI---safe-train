/* MRISafe Twin hand gestures: pure logic, no camera and no MediaPipe needed (so it is testable).
 *
 * Input: 21 MediaPipe hand landmarks per frame (normalised 0..1 image coordinates, camera not mirrored).
 * Output: events for the shell to forward to the active module.
 *
 *   pos     index fingertip position on screen (0..1, mirrored, smoothed)
 *   tap     quick pinch (thumb to index) released without moving: select / chapter action
 *   drag    pinch held and moved: screen-normalised deltas, used to orbit the view
 *   reset   open palm held still for about a second: reset the camera
 *   lost    no hand in view
 *   zoomOn / zoom{dz} / zoomOff   both palms open and held apart or together: dz is the
 *           change in log(distance), so positive means zoom in. Only from TwoPalmZoom.
 *
 * Two hands: the hand the user labels RIGHT aims, taps and orbits (HandGestures); while both
 * palms are open the zoom takes over and the aim hand's taps, drags and palm resets are paused.
 */
(function (root) {
  const WRIST = 0, MIDDLE_MCP = 9, THUMB_TIP = 4, INDEX_TIP = 8;
  const TIP = { index: 8, middle: 12, ring: 16, pinky: 20 };
  const PIP = { index: 6, middle: 10, ring: 14, pinky: 18 };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
  const handScale = lm => dist(lm[WRIST], lm[MIDDLE_MCP]) || 1e-6;

  // A finger is extended when its tip is clearly further from the wrist than its middle joint.
  function fingerExtended(lm, name) {
    return dist(lm[WRIST], lm[TIP[name]]) > dist(lm[WRIST], lm[PIP[name]]) * 1.15;
  }
  // Thumb-to-index distance relative to hand size: small when pinching.
  function pinchRatio(lm) { return dist(lm[THUMB_TIP], lm[INDEX_TIP]) / handScale(lm); }
  function isOpenPalm(lm) { return ['index', 'middle', 'ring', 'pinky'].every(n => fingerExtended(lm, n)); }

  // Camera to screen: mirror horizontally (the preview looks like a mirror), and stretch the
  // central 80% of the camera frame to the whole screen so small hand movements reach the edges.
  function toScreen(xRaw, yRaw) {
    return { x: clamp((1 - xRaw - 0.1) / 0.8, 0, 1), y: clamp((yRaw - 0.1) / 0.8, 0, 1) };
  }

  class HandGestures {
    constructor(opts = {}) {
      this.o = Object.assign({
        pinchOn: 0.32, pinchOff: 0.42,   // hysteresis: pinch starts below 0.32, ends above 0.42
        tapMaxMs: 450,                   // a quicker pinch with no drag is a tap
        dragMin: 0.025,                  // screen fraction the pinch must travel before it is a drag
        palmHoldMs: 1000, palmCooldownMs: 2500,
        smooth: 0.45,                    // pointer smoothing (0 = frozen, 1 = raw)
      }, opts);
      this.reset();
    }
    reset() {
      this.pos = null; this.pinched = false; this.pinchT0 = 0; this.anchor = null;
      this.last = null; this.dragging = false; this.palmSince = null;
      if (this.palmFired === undefined) this.palmFired = -Infinity;
    }
    update(lm, now, opts = {}) {
      if (!lm || lm.length < 21) {
        this.reset();
        return [{ type: 'lost' }];
      }
      const events = [];
      const p = toScreen(lm[INDEX_TIP].x, lm[INDEX_TIP].y);
      const s = this.o.smooth;
      this.pos = this.pos ? { x: this.pos.x + (p.x - this.pos.x) * s, y: this.pos.y + (p.y - this.pos.y) * s } : p;
      events.push({ type: 'pos', x: this.pos.x, y: this.pos.y });
      if (opts.quiet) { // zooming with both palms: keep the pointer, pause taps, drags and resets
        this.pinched = false; this.dragging = false; this.palmSince = null;
        return events;
      }

      const r = pinchRatio(lm);
      if (!this.pinched && r < this.o.pinchOn) {
        this.pinched = true; this.pinchT0 = now; this.dragging = false;
        this.anchor = { ...this.pos }; this.last = { ...this.pos };
      } else if (this.pinched && r > this.o.pinchOff) {
        if (!this.dragging && now - this.pinchT0 <= this.o.tapMaxMs) events.push({ type: 'tap' });
        this.pinched = false; this.dragging = false;
      }
      if (this.pinched) {
        const moved = Math.hypot(this.pos.x - this.anchor.x, this.pos.y - this.anchor.y);
        if (!this.dragging && moved > this.o.dragMin) this.dragging = true;
        if (this.dragging) {
          events.push({ type: 'drag', dx: this.pos.x - this.last.x, dy: this.pos.y - this.last.y });
        }
        this.last = { ...this.pos };
      }

      if (isOpenPalm(lm) && !this.pinched) {
        if (this.palmSince === null) this.palmSince = now;
        if (now - this.palmSince >= this.o.palmHoldMs && now - this.palmFired >= this.o.palmCooldownMs) {
          this.palmFired = now; this.palmSince = null;
          events.push({ type: 'reset' });
        }
      } else {
        this.palmSince = null;
      }
      return events;
    }
  }

  // Palm centre: midway between the wrist and the base of the middle finger.
  function palmCentre(lm) {
    return { x: (lm[WRIST].x + lm[MIDDLE_MCP].x) / 2, y: (lm[WRIST].y + lm[MIDDLE_MCP].y) / 2 };
  }
  // Distance between two palm centres, in a frame that is 4:3 (640x480 camera), so x and y count alike.
  const CAM_ASPECT = 4 / 3;
  function palmGap(a, b) {
    const p = palmCentre(a), q = palmCentre(b);
    return Math.hypot((p.x - q.x) * CAM_ASPECT, p.y - q.y);
  }

  // Zoom from two open palms. Starts after both palms have been open and apart-or-together for
  // engageMs (so a passing hand does nothing), stops once either palm has been gone for releaseMs.
  class TwoPalmZoom {
    constructor(opts = {}) {
      this.o = Object.assign({ engageMs: 250, releaseMs: 200, deadzone: 0.006, smooth: 0.5 }, opts);
      this.reset();
    }
    reset() { this.gap = null; this.last = null; this.engaged = false; this.startedAt = null; this.offSince = null; }
    update(a, b, now) {
      const both = !!(a && b && isOpenPalm(a) && isOpenPalm(b));
      const events = [];
      if (!both) {
        if (this.engaged) {
          if (this.offSince === null) this.offSince = now;
          if (now - this.offSince >= this.o.releaseMs) { this.reset(); events.push({ type: 'zoomOff' }); }
        } else { this.gap = null; this.startedAt = null; }
        return events;
      }
      this.offSince = null;
      const g = Math.max(palmGap(a, b), 1e-4);
      this.gap = this.gap === null ? g : this.gap + (g - this.gap) * this.o.smooth;
      if (!this.engaged) {
        if (this.startedAt === null) this.startedAt = now;
        if (now - this.startedAt >= this.o.engageMs) {
          this.engaged = true; this.last = this.gap; events.push({ type: 'zoomOn' });
        }
        return events;
      }
      const dz = Math.log(this.gap / this.last);
      if (Math.abs(dz) >= this.o.deadzone) { events.push({ type: 'zoom', dz }); this.last = this.gap; }
      return events;
    }
  }

  // Which detected hand aims. labelIsUserRight(label) says whether a MediaPipe label is the
  // user's right hand (it depends on whether the camera frame was flipped). With no usable
  // labels, the first hand aims and the second is the zoom palm.
  function pickHands(hands, userRightLabel) {
    const list = hands.filter(h => h && h.lm && h.lm.length >= 21);
    if (!list.length) return { aim: null, other: null };
    if (list.length === 1) return { aim: list[0], other: null };
    let aim = list.find(h => h.label === userRightLabel) || null;
    if (!aim) return { aim: list[0], other: list[1] };
    return { aim, other: list.find(h => h !== aim) || null };
  }

  const api = { HandGestures, TwoPalmZoom, pickHands, palmGap, palmCentre, toScreen, pinchRatio, isOpenPalm, fingerExtended };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MRIHandLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
