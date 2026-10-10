// Inputs.h — pure C++ logic for the potentiometer selector and the FSR press detector.
//
// No Arduino dependencies, so it is unit-tested on the host: firmware/tests/test_inputs.cpp
#pragma once
#include <stdint.h>

// Maps a potentiometer reading onto one of `slots` equal bands.
// A hysteresis margin stops the selection flickering when the knob sits on a boundary.
class PotSelector {
 public:
  void begin(int slots, int adcMax, int hysteresis, bool reversed = false) {
    slots_ = slots;
    adcMax_ = adcMax;
    hyst_ = (float)hysteresis;
    reversed_ = reversed;
    init_ = false;
    slot_ = 0;
  }

  // raw: 0..adcMax. Returns the selected slot, 0..slots-1.
  int update(int raw) {
    if (reversed_) raw = adcMax_ - raw;
    if (raw < 0) raw = 0;
    if (raw > adcMax_) raw = adcMax_;
    if (!init_) {
      filtered_ = (float)raw;
      init_ = true;
      slot_ = slotFor(filtered_);
      return slot_;
    }
    filtered_ += 0.25f * ((float)raw - filtered_);   // light smoothing
    const float band = bandWidth();
    while (slot_ < slots_ - 1 && filtered_ >= (float)(slot_ + 1) * band + hyst_) ++slot_;
    while (slot_ > 0 && filtered_ < (float)slot_ * band - hyst_) --slot_;
    return slot_;
  }

  int slot() const { return slot_; }
  float filtered() const { return filtered_; }

 private:
  float bandWidth() const { return (float)(adcMax_ + 1) / (float)slots_; }
  int slotFor(float v) const {
    int s = (int)(v / bandWidth());
    if (s < 0) s = 0;
    if (s > slots_ - 1) s = slots_ - 1;
    return s;
  }

  int slots_ = 6, adcMax_ = 4095;
  float hyst_ = 40, filtered_ = 0;
  bool reversed_ = false, init_ = false;
  int slot_ = 0;
};

// Detects one press per squeeze of the force-sensitive resistor.
//   press:   reading rises at least pressDelta above the resting baseline and holds for debounceMs
//   release: reading falls back to within releaseDelta of the baseline and holds for debounceMs
//   refractory: after a release, no new press is accepted for refractoryMs
// Two thresholds (press > release) give hysteresis, so a light touch does not chatter.
class FsrPress {
 public:
  void begin(int baseline, int pressDelta, int releaseDelta, uint32_t debounceMs, uint32_t refractoryMs) {
    baseline_ = baseline;
    pressDelta_ = pressDelta;
    releaseDelta_ = releaseDelta;
    debounceMs_ = debounceMs;
    refractoryMs_ = refractoryMs;
    pressed_ = false;
    candidate_ = false;
    since_ = 0;
    lastRelease_ = 0;
  }

  void setBaseline(int baseline) { baseline_ = baseline; }

  // Feed one reading. Returns true exactly once for each press.
  bool update(int raw, uint32_t now) {
    const int force = raw - baseline_;
    if (!pressed_) {
      if (force < pressDelta_) { candidate_ = false; return false; }
      if (!candidate_) { candidate_ = true; since_ = now; return false; }
      if (now - since_ >= debounceMs_ && now - lastRelease_ >= refractoryMs_) {
        pressed_ = true;
        candidate_ = false;
        return true;
      }
      return false;
    }
    if (force > releaseDelta_) { candidate_ = false; return false; }
    if (!candidate_) { candidate_ = true; since_ = now; return false; }
    if (now - since_ >= debounceMs_) {
      pressed_ = false;
      candidate_ = false;
      lastRelease_ = now;
    }
    return false;
  }

  bool pressed() const { return pressed_; }

 private:
  int baseline_ = 0, pressDelta_ = 0, releaseDelta_ = 0;
  uint32_t debounceMs_ = 0, refractoryMs_ = 0, since_ = 0, lastRelease_ = 0;
  bool pressed_ = false, candidate_ = false;
};
