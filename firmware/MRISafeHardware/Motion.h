// Motion.h — tilt estimate and gesture detection for the MPU9250 controller
//
// Plain C++ (no Arduino dependencies) so it is unit-tested on the host:
//   firmware/tests/test_motion.cpp
//
// Inputs per sample: accelerometer in g, gyroscope in deg/s, time step, time stamp.
// Outputs:
//   roll / pitch in degrees (complementary filter: gyro short-term, accel long-term)
//   gestures: Tap, DoubleTap, FlickLeft, FlickRight
//
// Mounting assumed: board flat, components up, USB cable pointing toward the user.
// Adjust the axis signs in MRISafeController.ino if your module is mounted differently.
#pragma once
#include <stdint.h>
#include <math.h>

enum class Gesture : uint8_t { None, Tap, DoubleTap, FlickLeft, FlickRight };

struct MotionConfig {
  float    alpha            = 0.98f;  // complementary filter weight on the gyro
  float    tapG             = 0.9f;   // |a| must jump this far from 1 g (in g)
  uint32_t tapMaxMs         = 90;     // spike must be shorter than this to be a tap
  uint32_t tapRefractoryMs  = 120;
  uint32_t doubleTapMs      = 380;    // second tap within this window → DoubleTap
  float    flickDps         = 260.0f; // yaw rate that counts as a flick
  uint32_t flickRefractoryMs= 600;
  float    quietDps         = 120.0f; // no taps while the board is rotating faster than this
};

class Motion {
 public:
  void configure(const MotionConfig& c) { cfg_ = c; }

  // Call once with the board at rest to define "level".
  void zero() { rollOff_ = roll_; pitchOff_ = pitch_; }

  Gesture update(float ax, float ay, float az, float gx, float gy, float gz, float dt, uint32_t now) {
    // --- orientation ---
    const float accRoll = atan2f(ay, az) * kRad2Deg;
    const float accPitch = atan2f(-ax, sqrtf(ay * ay + az * az)) * kRad2Deg;
    if (!init_) { roll_ = accRoll; pitch_ = accPitch; init_ = true; }
    else {
      roll_ = cfg_.alpha * (roll_ + gx * dt) + (1.0f - cfg_.alpha) * accRoll;
      pitch_ = cfg_.alpha * (pitch_ + gy * dt) + (1.0f - cfg_.alpha) * accPitch;
    }
    yawRate_ = gz;

    // --- flick (fast twist about the vertical axis) ---
    Gesture out = Gesture::None;
    if (!flicked_ || now - lastFlick_ >= cfg_.flickRefractoryMs) {
      if (gz > cfg_.flickDps) { out = Gesture::FlickLeft; lastFlick_ = now; flicked_ = true; pendingTap_ = false; }
      else if (gz < -cfg_.flickDps) { out = Gesture::FlickRight; lastFlick_ = now; flicked_ = true; pendingTap_ = false; }
    }
    const bool rotating = fabsf(gx) > cfg_.quietDps || fabsf(gy) > cfg_.quietDps || fabsf(gz) > cfg_.quietDps;
    const bool recentFlick = flicked_ && now - lastFlick_ < cfg_.flickRefractoryMs;

    // --- tap (short acceleration spike while the board is otherwise still) ---
    const float dev = fabsf(sqrtf(ax * ax + ay * ay + az * az) - 1.0f);
    if (!armed_ && dev < cfg_.tapG * 0.5f) armed_ = true;   // re-arm only after the board settles
    if (!inSpike_) {
      if (armed_ && dev > cfg_.tapG && !rotating && !recentFlick && now - lastTapEnd_ >= cfg_.tapRefractoryMs) { inSpike_ = true; spikeStart_ = now; }
    } else if (dev < cfg_.tapG * 0.5f) {
      inSpike_ = false; lastTapEnd_ = now;
      if (now - spikeStart_ <= cfg_.tapMaxMs) {
        if (pendingTap_ && now - pendingAt_ <= cfg_.doubleTapMs) { pendingTap_ = false; if (out == Gesture::None) out = Gesture::DoubleTap; }
        else { pendingTap_ = true; pendingAt_ = now; }
      }
    } else if (now - spikeStart_ > cfg_.tapMaxMs * 3) {
      inSpike_ = false; lastTapEnd_ = now; armed_ = false;  // long push, not a tap
    }
    // a single tap is reported once the double-tap window has passed
    if (pendingTap_ && now - pendingAt_ > cfg_.doubleTapMs && out == Gesture::None) { pendingTap_ = false; out = Gesture::Tap; }
    return out;
  }

  float roll() const { return roll_ - rollOff_; }
  float pitch() const { return pitch_ - pitchOff_; }
  float yawRate() const { return yawRate_; }

 private:
  static constexpr float kRad2Deg = 57.2957795f;
  MotionConfig cfg_;
  bool init_ = false, inSpike_ = false, pendingTap_ = false, flicked_ = false, armed_ = true;
  float roll_ = 0, pitch_ = 0, rollOff_ = 0, pitchOff_ = 0, yawRate_ = 0;
  uint32_t spikeStart_ = 0, lastTapEnd_ = 0, pendingAt_ = 0, lastFlick_ = 0;
};
