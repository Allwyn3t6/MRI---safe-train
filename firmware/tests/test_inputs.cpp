// Host tests for firmware/MRISafeHardware/Inputs.h (pot selector and FSR press).
// Build and run:
//   g++ -std=c++17 -I firmware/MRISafeHardware firmware/tests/test_inputs.cpp -o ti && ./ti
#include <cstdio>
#include "Inputs.h"

static int failures = 0, passes = 0;
#define CHECK(cond, msg) do { if (cond) { ++passes; } else { ++failures; std::printf("FAIL: %s (line %d)\n", msg, __LINE__); } } while (0)

static void potTests() {
  PotSelector p;
  p.begin(6, 4095, 40);

  // Settle at each end and in the middle of a band.
  for (int i = 0; i < 50; i++) p.update(0);
  CHECK(p.slot() == 0, "fully counter-clockwise selects slot 0");
  for (int i = 0; i < 50; i++) p.update(4095);
  CHECK(p.slot() == 5, "fully clockwise selects slot 5");
  for (int i = 0; i < 50; i++) p.update(2388);     // centre of band 3 (3*682.5 .. 4*682.5)
  CHECK(p.slot() == 3, "centre of band 3 selects slot 3");

  // Hysteresis: sitting just above the 1->2 boundary (1365) must not flip the selection.
  PotSelector h;
  h.begin(6, 4095, 40);
  for (int i = 0; i < 50; i++) h.update(1024);     // slot 1 centre
  CHECK(h.slot() == 1, "centre of band 1 selects slot 1");
  for (int i = 0; i < 50; i++) h.update(1380);     // 15 counts past boundary, inside hysteresis
  CHECK(h.slot() == 1, "hysteresis keeps slot 1 just past the boundary");
  for (int i = 0; i < 50; i++) h.update(1460);     // clearly past boundary + hysteresis
  CHECK(h.slot() == 2, "clearly past boundary moves to slot 2");

  // Reversed pot wiring.
  PotSelector r;
  r.begin(6, 4095, 40, true);
  for (int i = 0; i < 50; i++) r.update(0);
  CHECK(r.slot() == 5, "reversed wiring: raw 0 selects slot 5");

  // Out-of-range readings are clamped, not wrapped.
  PotSelector c;
  c.begin(6, 4095, 40);
  for (int i = 0; i < 50; i++) c.update(9999);
  CHECK(c.slot() == 5, "readings above full scale clamp to slot 5");
}

static void fsrTests() {
  // baseline 100, press when 300 counts above rest, release when within 200, debounce 20 ms, refractory 100 ms
  FsrPress f;
  f.begin(100, 300, 200, 20, 100);

  CHECK(!f.update(100, 1000), "rest does not press");

  // A press held steadily produces exactly one edge.
  int edges = 0;
  if (f.update(500, 1000)) edges++;
  if (f.update(500, 1010)) edges++;       // still inside debounce
  if (f.update(500, 1025)) edges++;       // debounce satisfied: the one press
  CHECK(edges == 1, "press reports one edge after debounce");
  CHECK(f.pressed(), "pressed state set after the edge");
  for (uint32_t t = 1100; t <= 2000; t += 50)
    if (f.update(500, t)) edges++;
  CHECK(edges == 1, "holding the press does not repeat the action");

  // Release, then a new press inside the refractory window is ignored.
  for (uint32_t t = 2000; t <= 2030; t += 10) f.update(110, t);
  CHECK(!f.pressed(), "release after debounce clears pressed");
  bool early = false;
  for (uint32_t t = 2040; t <= 2080; t += 10) early |= f.update(500, t);
  CHECK(!early, "press inside refractory window is ignored");

  // Once the refractory window has passed, the next squeeze counts.
  bool later = false;
  for (uint32_t t = 2081; t <= 2300 && !later; t += 5) later = f.update(500, t);
  CHECK(later, "press after refractory window is accepted");

  // A short spike shorter than the debounce is ignored.
  FsrPress s;
  s.begin(100, 300, 200, 20, 100);
  bool spike = false;
  for (uint32_t t = 3000; t <= 3010; t += 2) spike |= s.update(500, t);
  s.update(100, 3012);
  CHECK(!spike, "spike shorter than debounce does not press");

  // A light touch that stays under the press threshold does nothing.
  FsrPress l;
  l.begin(100, 300, 200, 20, 100);
  bool light = false;
  for (uint32_t t = 4000; t <= 5000; t += 10) light |= l.update(350, t);
  CHECK(!light, "light touch under press threshold does not press");
}

int main() {
  potTests();
  fsrTests();
  std::printf("%d passed, %d failed\n", passes, failures);
  return failures == 0 ? 0 : 1;
}
