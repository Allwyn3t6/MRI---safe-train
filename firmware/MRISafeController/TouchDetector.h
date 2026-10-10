// TouchDetector.h — capacitive pad edge detector for MRISafe Twin
//
// Plain C++ with no Arduino dependencies, so the same logic runs on the
// ESP32-S3 and in the host unit test (firmware/tests/test_touch_detector.cpp).
//
// Pipeline per pad:
//   raw reading -> EMA filter -> compare with baseline + delta
//   -> filtered AND raw must stay above for minPressMs (debounce) -> ONE Press event
//   -> release when below baseline + releaseFraction*delta (hysteresis)
//   -> lockout for lockoutMs before the next press can start
//   -> baseline slowly tracks drift only while the pad is idle
//
// Direction: on the ESP32-S3 the touch reading RISES when touched.
// On the classic ESP32 it FALLS. Set risingOnTouch accordingly.
#pragma once
#include <stdint.h>
#include <math.h>

struct TouchConfig {
  bool     risingOnTouch   = true;    // ESP32-S3: true. Classic ESP32: false.
  float    emaAlpha        = 0.35f;   // 0..1, higher = less smoothing
  float    thresholdRatio  = 0.04f;   // minimum change as a fraction of baseline
  float    sigmaK          = 8.0f;    // minimum change as multiples of rest noise (std dev)
  float    releaseFraction = 0.5f;    // release below baseline + 0.5 * delta
  uint32_t minPressMs      = 30;      // debounce: must stay pressed this long
  uint32_t lockoutMs       = 150;     // ignore new presses right after a release
  uint32_t stuckMs         = 10000;   // report a pad held (or drifted) this long
  float    driftAlpha      = 0.002f;  // idle baseline tracking per sample
  float    maxCalibCv      = 0.05f;   // calibration fails if std dev > 5% of mean
};

enum class TouchEvent : uint8_t { None, Press, Release, Stuck };

class TouchDetector {
 public:
  void configure(const TouchConfig& c) { cfg_ = c; }
  const TouchConfig& config() const { return cfg_; }

  // ---- calibration (hands off the pads) ----
  void beginCalibration() { n_ = 0; sum_ = 0; sumSq_ = 0; calibrated_ = false; }
  void addCalibrationSample(uint32_t raw) {
    const double v = (double)raw;
    sum_ += v; sumSq_ += v * v; n_++;
  }
  // Returns true when the pad was quiet enough to trust.
  bool finishCalibration() {
    if (n_ < 4) { calibrated_ = false; return false; }
    const double mean = sum_ / n_;
    double var = sumSq_ / n_ - mean * mean;
    if (var < 0) var = 0;
    sd_ = (float)sqrt(var);
    if (sd_ < 1.0f) sd_ = 1.0f;
    base_ = (float)mean;
    recomputeDelta();
    filtered_ = base_;
    state_ = State::Idle;
    stuckReported_ = false;
    calibrated_ = true;
    stable_ = mean > 0 && (sd_ / (float)mean) <= cfg_.maxCalibCv;
    return stable_;
  }

  // ---- runtime ----
  TouchEvent update(uint32_t raw, uint32_t nowMs) {
    if (!calibrated_) return TouchEvent::None;
    filtered_ += cfg_.emaAlpha * ((float)raw - filtered_);
    const float d = signal();
    // Unfiltered change: the debounce window requires the raw reading to stay up too,
    // so a short spike smeared out by the filter cannot count as a press.
    const float rd = cfg_.risingOnTouch ? ((float)raw - base_) : (base_ - (float)raw);
    const float pressAt = delta_;
    const float releaseAt = delta_ * cfg_.releaseFraction;

    switch (state_) {
      case State::Idle:
        if (d > pressAt && rd > pressAt) { state_ = State::Pending; t0_ = nowMs; }
        else if (d < releaseAt) {
          base_ += cfg_.driftAlpha * (filtered_ - base_);   // follow slow drift
          recomputeDelta();
        }
        return TouchEvent::None;

      case State::Pending:
        if (d <= pressAt || rd <= pressAt * 0.75f) { state_ = State::Idle; return TouchEvent::None; }  // glitch
        if (nowMs - t0_ >= cfg_.minPressMs) {
          state_ = State::Pressed; t0_ = nowMs; stuckReported_ = false;
          return TouchEvent::Press;
        }
        return TouchEvent::None;

      case State::Pressed:
        if (d < releaseAt) { state_ = State::Lockout; t0_ = nowMs; return TouchEvent::Release; }
        if (!stuckReported_ && nowMs - t0_ >= cfg_.stuckMs) { stuckReported_ = true; return TouchEvent::Stuck; }
        return TouchEvent::None;

      case State::Lockout:
        if (nowMs - t0_ >= cfg_.lockoutMs) state_ = State::Idle;
        return TouchEvent::None;
    }
    return TouchEvent::None;
  }

  bool  calibrated() const { return calibrated_; }
  bool  stable() const { return stable_; }
  bool  pressed() const { return state_ == State::Pressed; }
  float baseline() const { return base_; }
  float noise() const { return sd_; }
  float delta() const { return delta_; }
  float filtered() const { return filtered_; }
  // Absolute reading at which a press starts (for diagnostics).
  float pressThreshold() const { return cfg_.risingOnTouch ? base_ + delta_ : base_ - delta_; }

 private:
  enum class State : uint8_t { Idle, Pending, Pressed, Lockout };

  float signal() const { return cfg_.risingOnTouch ? (filtered_ - base_) : (base_ - filtered_); }
  void recomputeDelta() {
    const float byRatio = fabsf(base_) * cfg_.thresholdRatio;
    const float bySigma = sd_ * cfg_.sigmaK;
    delta_ = byRatio > bySigma ? byRatio : bySigma;
    if (delta_ < 1.0f) delta_ = 1.0f;
  }

  TouchConfig cfg_;
  State    state_ = State::Idle;
  bool     calibrated_ = false, stable_ = false, stuckReported_ = false;
  uint32_t t0_ = 0;
  float    base_ = 0, sd_ = 1, delta_ = 1, filtered_ = 0;
  uint32_t n_ = 0;
  double   sum_ = 0, sumSq_ = 0;
};
