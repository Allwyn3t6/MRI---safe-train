// Host test for Motion.h (tilt filter and gestures). No hardware needed.
//   g++ -std=c++17 -O2 -Wall -Wextra -I../MRISafeController test_motion.cpp -o tm && ./tm
#include "Motion.h"
#include <cstdio>
#include <cmath>
#include <random>
#include <vector>

static int failures = 0;
#define CHECK(c, m) do { if (!(c)) { std::printf("  FAIL: %s\n", m); failures++; } else std::printf("  ok:   %s\n", m); } while (0)

struct Sample { float ax, ay, az, gx, gy, gz; };
struct Run { std::vector<Gesture> g; };

static std::mt19937 rng(7);
static float noise(float sd) { std::normal_distribution<float> n(0, sd); return n(rng); }

// Feed `ms` of samples at 200 Hz from generator f(t_ms_since_start)
template <typename F>
static Run feed(Motion& m, uint32_t& t, uint32_t ms, F f) {
  Run r;
  for (uint32_t end = t + ms, s = t; t < end; t += 5) {
    Sample x = f(t - s);
    Gesture g = m.update(x.ax + noise(0.01f), x.ay + noise(0.01f), x.az + noise(0.01f), x.gx + noise(0.5f), x.gy + noise(0.5f), x.gz + noise(0.5f), 0.005f, t);
    if (g != Gesture::None) r.g.push_back(g);
  }
  return r;
}
static Sample flat(uint32_t) { return {0, 0, 1, 0, 0, 0}; }
static int count(const Run& r, Gesture g) { int n = 0; for (auto x : r.g) n += x == g; return n; }

int main() {
  std::printf("Tilt\n");
  {
    Motion m; uint32_t t = 0;
    feed(m, t, 1000, flat); m.zero();
    const float a = 20.0f * 3.14159265f / 180.0f;
    feed(m, t, 3000, [&](uint32_t) { return Sample{0, std::sin(a), std::cos(a), 0, 0, 0}; });
    CHECK(std::fabs(m.roll() - 20.0f) < 1.5f, "steady 20° roll is reported within 1.5°");
    CHECK(std::fabs(m.pitch()) < 1.5f, "pitch stays near 0 during pure roll");
    feed(m, t, 3000, [&](uint32_t) { return Sample{-std::sin(a), 0, std::cos(a), 0, 0, 0}; });
    CHECK(std::fabs(m.pitch() - 20.0f) < 1.5f, "steady 20° pitch is reported within 1.5°");
  }
  std::printf("Zero offset\n");
  {
    Motion m; uint32_t t = 0;
    const float a = 10.0f * 3.14159265f / 180.0f;
    feed(m, t, 2000, [&](uint32_t) { return Sample{0, std::sin(a), std::cos(a), 0, 0, 0}; });
    m.zero();
    CHECK(std::fabs(m.roll()) < 0.5f, "zero() makes the current pose level");
  }
  std::printf("Rest\n");
  {
    Motion m; uint32_t t = 0;
    Run r = feed(m, t, 20000, flat);
    CHECK(r.g.empty(), "20 s at rest produces no gestures");
  }
  std::printf("Single tap\n");
  {
    Motion m; uint32_t t = 0; feed(m, t, 500, flat);
    Run r = feed(m, t, 1000, [](uint32_t k) { return k < 20 ? Sample{0, 0, 2.6f, 0, 0, 0} : Sample{0, 0, 1, 0, 0, 0}; });
    CHECK(count(r, Gesture::Tap) == 1 && r.g.size() == 1, "one sharp tap → exactly one Tap (after the double-tap window)");
  }
  std::printf("Double tap\n");
  {
    Motion m; uint32_t t = 0; feed(m, t, 500, flat);
    Run r = feed(m, t, 1200, [](uint32_t k) { bool spike = k < 20 || (k >= 200 && k < 220); return spike ? Sample{0, 0, 2.6f, 0, 0, 0} : Sample{0, 0, 1, 0, 0, 0}; });
    CHECK(count(r, Gesture::DoubleTap) == 1 && count(r, Gesture::Tap) == 0, "two taps 200 ms apart → one DoubleTap, no single Tap");
  }
  std::printf("Push is not a tap\n");
  {
    Motion m; uint32_t t = 0; feed(m, t, 500, flat);
    Run r = feed(m, t, 1500, [](uint32_t k) { return k < 400 ? Sample{0, 0, 2.2f, 0, 0, 0} : Sample{0, 0, 1, 0, 0, 0}; });
    CHECK(r.g.empty(), "a 400 ms push is ignored");
  }
  std::printf("Flicks\n");
  {
    Motion m; uint32_t t = 0; feed(m, t, 500, flat);
    Run r = feed(m, t, 1000, [](uint32_t k) { return k < 120 ? Sample{0, 0, 1, 0, 0, 400} : Sample{0, 0, 1, 0, 0, 0}; });
    CHECK(count(r, Gesture::FlickLeft) == 1 && r.g.size() == 1, "fast positive twist → one FlickLeft");
    Run r2 = feed(m, t, 1000, [](uint32_t k) { return k < 120 ? Sample{0, 0, 1, 0, 0, -400} : Sample{0, 0, 1, 0, 0, 0}; });
    CHECK(count(r2, Gesture::FlickRight) == 1 && r2.g.size() == 1, "fast negative twist → one FlickRight");
    Run r3 = feed(m, t, 1000, [](uint32_t k) { return k < 400 ? Sample{0, 0, 1, 0, 0, 90} : Sample{0, 0, 1, 0, 0, 0}; });
    CHECK(r3.g.empty(), "slow turning (90 °/s) is not a flick");
  }
  std::printf("Tap during rotation is suppressed\n");
  {
    Motion m; uint32_t t = 0; feed(m, t, 500, flat);
    Run r = feed(m, t, 1000, [](uint32_t k) { return k < 20 ? Sample{0, 0, 2.6f, 200, 0, 0} : Sample{0, 0, 1, 0, 0, 0}; });
    CHECK(r.g.empty(), "acceleration spike while rotating fast is not a tap");
  }
  std::printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "ALL PASSED", failures, failures == 1 ? "" : "s");
  return failures ? 1 : 0;
}
