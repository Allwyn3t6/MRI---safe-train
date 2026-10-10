// Host-side test of the touch detection logic. No hardware needed.
//   g++ -std=c++17 -O2 -Wall -Wextra -I../MRISafeController test_touch_detector.cpp -o t && ./t
// Simulated readings resemble an ESP32-S3 pad: ~30000 at rest, rising on touch.
#include "TouchDetector.h"
#include <cstdio>
#include <random>
#include <vector>
#include <functional>

static int failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { std::printf("  FAIL: %s\n", msg); failures++; } else { std::printf("  ok:   %s\n", msg); } } while (0)

struct Counts { int press = 0, release = 0, stuck = 0; };

// Runs `ms` milliseconds at 100 Hz, reading from signal(tMs).
static Counts run(TouchDetector& d, uint32_t& t, uint32_t ms, const std::function<double(uint32_t)>& signal, std::mt19937& rng, double noiseSd) {
  std::normal_distribution<double> n(0.0, noiseSd);
  Counts c;
  for (uint32_t end = t + ms; t < end; t += 10) {
    double v = signal(t) + n(rng);
    if (v < 0) v = 0;
    switch (d.update((uint32_t)v, t)) {
      case TouchEvent::Press: c.press++; break;
      case TouchEvent::Release: c.release++; break;
      case TouchEvent::Stuck: c.stuck++; break;
      default: break;
    }
  }
  return c;
}

static TouchDetector calibrated(std::mt19937& rng, double base, double sd, bool rising = true) {
  TouchDetector d;
  TouchConfig cfg; cfg.risingOnTouch = rising;
  d.configure(cfg);
  std::normal_distribution<double> n(0.0, sd);
  d.beginCalibration();
  for (int i = 0; i < 64; i++) d.addCalibrationSample((uint32_t)(base + n(rng)));
  d.finishCalibration();
  return d;
}

int main() {
  std::mt19937 rng(12345);
  const double BASE = 30000, SD = 60;

  std::printf("Calibration\n");
  {
    TouchDetector d = calibrated(rng, BASE, SD);
    CHECK(d.calibrated() && d.stable(), "quiet pad calibrates as stable");
    CHECK(d.delta() >= BASE * 0.04f - 1, "threshold is at least 4% above baseline");
    TouchDetector noisy = calibrated(rng, BASE, BASE * 0.2);
    CHECK(!noisy.stable(), "very noisy pad is reported unstable");
  }

  std::printf("Rest noise\n");
  {
    TouchDetector d = calibrated(rng, BASE, SD); uint32_t t = 0;
    Counts c = run(d, t, 60000, [&](uint32_t) { return BASE; }, rng, SD);
    CHECK(c.press == 0, "60 s of rest noise produces no events");
  }

  std::printf("Single touch with contact bounce\n");
  {
    TouchDetector d = calibrated(rng, BASE, SD); uint32_t t = 0;
    run(d, t, 500, [&](uint32_t) { return BASE; }, rng, SD);
    const uint32_t s = t;
    Counts c = run(d, t, 600, [&](uint32_t x) {
      const uint32_t k = x - s;
      if (k < 40) return (k / 10) % 2 ? BASE + 6000 : BASE;           // bounce on contact
      if (k > 520 && k < 560) return (k / 10) % 2 ? BASE : BASE + 6000; // bounce on release
      return k <= 520 ? BASE + 6000 : BASE;
    }, rng, SD);
    Counts tail = run(d, t, 500, [&](uint32_t) { return BASE; }, rng, SD);
    CHECK(c.press + tail.press == 1, "one touch -> exactly one press");
    CHECK(c.release + tail.release == 1, "one touch -> exactly one release");
  }

  std::printf("Short glitch\n");
  {
    TouchDetector d = calibrated(rng, BASE, SD); uint32_t t = 0;
    run(d, t, 300, [&](uint32_t) { return BASE; }, rng, SD);
    const uint32_t s = t;
    Counts c = run(d, t, 300, [&](uint32_t x) { return (x - s) < 20 ? BASE + 8000 : BASE; }, rng, SD);
    CHECK(c.press == 0, "20 ms spike is ignored (debounce)");
  }

  std::printf("Two separate touches\n");
  {
    TouchDetector d = calibrated(rng, BASE, SD); uint32_t t = 0;
    int presses = 0;
    for (int i = 0; i < 2; i++) {
      presses += run(d, t, 300, [&](uint32_t) { return BASE + 5000; }, rng, SD).press;
      presses += run(d, t, 400, [&](uint32_t) { return BASE; }, rng, SD).press;
    }
    CHECK(presses == 2, "touch, release, touch -> two presses");
  }

  std::printf("Touch through tape (weaker signal)\n");
  {
    TouchDetector d = calibrated(rng, BASE, SD); uint32_t t = 0;
    run(d, t, 300, [&](uint32_t) { return BASE; }, rng, SD);
    Counts c = run(d, t, 300, [&](uint32_t) { return BASE * 1.07; }, rng, SD);
    CHECK(c.press == 1, "7% rise through an overlay is detected");
  }

  std::printf("Slow drift\n");
  {
    TouchDetector d = calibrated(rng, BASE, SD); uint32_t t = 0;
    const uint32_t s = t;
    Counts c = run(d, t, 120000, [&](uint32_t x) { return BASE + 3000.0 * (x - s) / 120000.0; }, rng, SD);
    CHECK(c.press == 0, "+10% drift over 2 minutes does not trigger");
    Counts c2 = run(d, t, 300, [&](uint32_t) { return BASE + 3000 + 5000; }, rng, SD);
    CHECK(c2.press == 1, "touch still detected after drift");
  }

  std::printf("Held pad\n");
  {
    TouchDetector d = calibrated(rng, BASE, SD); uint32_t t = 0;
    Counts c = run(d, t, 12000, [&](uint32_t) { return BASE + 6000; }, rng, SD);
    CHECK(c.press == 1, "holding for 12 s gives one press, not repeats");
    CHECK(c.stuck == 1, "held pad is reported stuck once");
  }

  std::printf("Falling-direction mode (classic ESP32)\n");
  {
    TouchDetector d = calibrated(rng, 60, 1.0, false); uint32_t t = 0;
    run(d, t, 300, [&](uint32_t) { return 60.0; }, rng, 1.0);
    Counts c = run(d, t, 300, [&](uint32_t) { return 25.0; }, rng, 1.0);
    CHECK(c.press == 1, "falling reading detected when risingOnTouch=false");
  }

  std::printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "ALL PASSED", failures, failures == 1 ? "" : "s");
  return failures ? 1 : 0;
}
