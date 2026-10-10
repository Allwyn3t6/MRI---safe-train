# Test matrix

All automated suites were re-run after the modules were merged into one app (9 Oct 2026).

**Executed** means it was run and passed while building this version (9 Oct 2026). **Proposed** means it still has to be run by the team, mostly because it needs the real board.

## Assessment engine — `node --test tests/engine.test.js` (28 tests)

| Case | Status |
|---|---|
| Correct sequence completes the standard scenario with 100 | Executed ✔ |
| Touch received but not accepted when requirements are unmet | Executed ✔ |
| Skipped prerequisite is a violation and blocks the transition | Executed ✔ |
| Proceed to scan without clearance → R-SCAN-01 | Executed ✔ |
| Repeated checkpoint touch logged without penalty | Executed ✔ |
| Same violation penalised once per subject | Executed ✔ |
| Invalid / unknown / malformed events rejected without crash or penalty | Executed ✔ |
| MR Unsafe item cannot be moved into Zone IV | Executed ✔ |
| Equipment sign-off with cylinder in Zone IV fails with evidence text | Executed ✔ |
| Unlabelled steel item classified MR Safe → critical | Executed ✔ |
| MR Conditional item needs conditions confirmed | Executed ✔ |
| Implant: proceed on card → critical; escalate resolves | Executed ✔ |
| Personal items block room access | Executed ✔ |
| Reset closes attempt and counts a retry | Executed ✔ |
| Trainer scenario switch is not a retry | Executed ✔ |
| Events after completion rejected | Executed ✔ |
| Drill ignores checkpoints outside the drill | Executed ✔ |
| Guided hint points at next unmet requirement | Executed ✔ |
| Adaptive: pass unlocks next level | Executed ✔ |
| Adaptive: critical equipment error → equipment drill | Executed ✔ |
| Adaptive: two failures → guided practice | Executed ✔ |
| Adaptive: passed drill returns to last full scenario | Executed ✔ |
| Parser: valid action, alias normalised | Executed ✔ |
| Parser: malformed, non-JSON, version, unknown type/event, pad mismatch, bad seq, too long | Executed ✔ |
| Line buffer reassembles split chunks | Executed ✔ |
| Sequence tracker: duplicates dropped, new boot resets | Executed ✔ |
| CSV export rows match the event log | Executed ✔ |
| Parser accepts IMU and gesture messages, rejects bad ones | Executed ✔ |

## Physics module — `node --test tests/physics.test.js` (8 tests)

| Case | Status |
|---|---|
| Larmor frequency 63.87 MHz at 1.5 T, 127.73 MHz at 3 T | Executed ✔ |
| Slice thickness 2.35 mm at 1 kHz / 10 mT/m; halves when G doubles; offset 10 mm at 4.258 kHz | Executed ✔ |
| Relaxation: Mz 63 % at T1, Mxy 37 % at T2, inversion at 180° | Executed ✔ |
| T1-weighted ordering fat > WM > GM > CSF | Executed ✔ |
| T2-weighted ordering CSF > GM > WM | Executed ✔ |
| 2D FFT round trip recovers the image | Executed ✔ |
| Full k-space reconstruction equals the phantom; centre-only differs | Executed ✔ |
| FFT rejects non power-of-two length | Executed ✔ |

## Inside the scanner — headless Chromium (`tests/internals-smoke.mjs`)

| Case | Status |
|---|---|
| Chapters 1, 9, 13 and 14 load and render without script errors (9 Oct 2026, software rendering: the full 14-chapter run was not completed in this sandbox) | Executed ✔ (subset) |
| All 14 chapters load and render without script errors | Proposed (run on the laptop) |
| Assembly auto-build, RF pulse, k-space acquisition and quench controls run | Executed ✔ |
| 400 px wide layout has no horizontal scroll | Executed ✔ |
| Frame rate on a typical faculty laptop GPU | Proposed |

## Motion and gestures — `firmware/tests/test_motion.cpp` (host, simulated IMU data)

| Case | Status |
|---|---|
| Steady 20° roll and 20° pitch reported within 1.5° | Executed ✔ |
| Levelling (zero) makes the current pose 0° | Executed ✔ |
| 20 s at rest → no gestures | Executed ✔ |
| One sharp tap → exactly one Tap | Executed ✔ |
| Two taps 200 ms apart → one DoubleTap and no single Tap | Executed ✔ |
| A 400 ms push is not a tap | Executed ✔ |
| Fast twist → one FlickLeft / FlickRight; slow turning is not a flick | Executed ✔ |
| Acceleration spike while rotating fast is not a tap | Executed ✔ |

## Controller mapping — `node --test tests/controller.test.js` (6 tests)

| Case | Status |
|---|---|
| Dead zone, smooth signed ramp, saturation | Executed ✔ |
| Orbit step proportional to time, large gaps capped | Executed ✔ |
| Pointer direction and pitch inversion | Executed ✔ |
| Wand meter levels; every pad and gesture has a meaning in both modes | Executed ✔ |

## Coach — `node --test tests/coach.test.js` (7 tests, offline)

| Case | Status |
|---|---|
| Knowledge base is well formed: 80+ entries, unique ids, answers present, no Azure text | Executed ✔ (9 Oct 2026) |
| Retrieval answers common questions with the right entry and enough confidence | Executed ✔ |
| Unrelated question gets an honest "I don't have a confident answer" with suggestions | Executed ✔ |
| Chapter notes are used when a Learn question asks about the chapter | Executed ✔ |
| Explanation cites the broken rule, adds background, and never mentions other rules | Executed ✔ |
| Debrief summarises the attempt from its context; quiz returns question and answer | Executed ✔ |

## Hand control — `node --test tests/hand-logic.test.js` (14 tests, offline)

| Case | Status |
|---|---|
| Palm held for 1 s fires reset once; a hold starting at time 0 is not lost | Executed ✔ |
| Pinch fires tap; pinch-drag fires orbit deltas; hysteresis stops flicker at the threshold | Executed ✔ |
| Pointing maps camera coordinates to screen (mirrored, central 80 % of frame, clamped) | Executed ✔ |
| Hand leaving the frame sends one lost event, not one per frame | Executed ✔ |
| Two open palms move apart → zoom in; together → zoom out | Executed ✔ |
| Zoom starts only after both palms are open for 250 ms; one palm never zooms | Executed ✔ |
| Zoom ends once after a palm is gone for 200 ms | Executed ✔ |
| During zoom the right hand's taps, drags and palm resets are paused | Executed ✔ |
| Aiming hand chosen by MediaPipe label, with fallbacks for one hand or no labels | Executed ✔ |
| Shell button starts the camera path; missing model shows an honest message and reverts | Executed ✔ (headless Chromium, fake camera) |
| Shell hand events move the Train cursor and hide it on lost | Executed ✔ (headless Chromium) |
| Zoom event moves the camera in Train and Learn; zoom out stops at the maximum distance | Executed ✔ (headless Chromium) |
| Swap and Speak buttons toggle aria-pressed; swap is remembered; tap is announced in the live region | Executed ✔ (headless Chromium) |
| Real webcam: right-hand aim and tap respond within about 0.3 s | Proposed |
| Real webcam: both palms zoom smoothly; the label "Left" is the user's right hand (else use Swap hands) | Proposed |
| Model loads from `simulator/models/` with no internet | Proposed |
| Screen reader (NVDA or VoiceOver) reads "Hand found", "Zoom on" and "Tap" | Proposed |
| Speak feedback reads status in Chrome and Edge with a system voice | Proposed |

## Optional local AI server — `python -m unittest discover -s tests -p "test_server.py"` (14 tests)

| Case | Status |
|---|---|
| Provider selection: OpenAI-compatible when a base URL is set, otherwise none; Azure settings are ignored | Executed ✔ |
| Status never exposes the key | Executed ✔ |
| Ollama request: no key, no Authorization header, model in body; OpenAI-compatible URL and bearer token | Executed ✔ |
| Reasoning-model settings (`max_completion_tokens`, no temperature) | Executed ✔ |
| Prompt building; bad requests rejected; history bounded; injected system turns dropped; context clipped | Executed ✔ |
| Grounding check: must cite the broken rule, must not invent rules | Executed ✔ |
| Static file path traversal blocked; rate limiter | Executed ✔ |
| Live call through the real server to a mock OpenAI-compatible provider | Executed ✔ |
| Live call to a real Ollama install on the faculty laptop | **Proposed** (needs Ollama and a pulled model on that machine) |

## Unified app — headless Chromium (`tests/shell-smoke.mjs`, with the server and a mock provider)

| Case | Status |
|---|---|
| Home loads with readiness checks (coach ready offline, no server needed) | Executed ✔ |
| Simulated controller line reaches the trainer as a hardware action and is assessed | Executed ✔ |
| IMU messages orbit the view; flick switches to point mode | Executed ✔ |
| "Explain with the coach" opens the assistant with a knowledge-base reply that cites the rule | Executed ✔ |
| In Learn, pad T2 and a flick advance chapters; the shell receives the chapter context | Executed ✔ |
| Tutor question answered from the knowledge base (Larmor frequency at 1.5 T) | Executed ✔ |
| Assessor Hide collapses the feedback card; Save to log stores it in the feedback log | Executed ✔ |
| Light theme switched in the shell reaches the trainer frame | Executed ✔ |
| 400 px layout has no horizontal scroll | Executed ✔ |

## Touch detection logic — `firmware/tests/test_touch_detector.cpp` (host, simulated readings)

| Case | Status |
|---|---|
| Quiet pad calibrates stable; very noisy pad flagged | Executed ✔ |
| 60 s rest noise → no events | Executed ✔ |
| Touch with contact bounce → exactly one press, one release | Executed ✔ |
| 20 ms spike ignored | Executed ✔ |
| Touch, release, touch → two presses | Executed ✔ |
| 7 % rise through tape overlay detected | Executed ✔ |
| +10 % drift over 2 min → no trigger, touch still detected after | Executed ✔ |
| Held 12 s → one press, stuck reported once | Executed ✔ |
| Falling-direction mode (classic ESP32) | Executed ✔ |

These use synthetic readings shaped like an S3 pad (about 30 000 at rest). Real pads will differ; see the hardware rows below.

## Firmware build

| Case | Status |
|---|---|
| Sketch compiles against stub Arduino/Wire headers (syntax and types) | Executed ✔ |
| Sketch compiles with Arduino-ESP32 3.x for "ESP32S3 Dev Module" | **Proposed** (toolchain could not be downloaded in the build environment) |

## Browser — headless Chromium smoke test (`tests/browser-smoke.mjs`)

| Case | Status |
|---|---|
| Page loads, 3D suite renders, no script errors | Executed ✔ |
| Keyboard pad 3 before prerequisites → critical violation card | Executed ✔ |
| Scene actions (record, ID, classify, move) update checklist | Executed ✔ |
| Simulated device lines through the serial handler: hello, action, duplicate dropped, garbage ignored | Executed ✔ |
| Scan animation, completion dialog, adaptive recommendation | Executed ✔ |
| Trainer view renders tables from the event log | Executed ✔ |
| Clicking an object in the canvas selects it | Executed ✔ |
| 400 px wide layout has no horizontal scroll | Executed ✔ |

## Hardware and end-to-end — needs the real board

| Case | Status |
|---|---|
| Each of the six electrodes produces its event | Proposed |
| MPU9250 detected (`hello` shows `imu`), levelling works, tilt direction feels right | Proposed |
| Tap / double tap / flick thresholds comfortable in the hand | Proposed |
| Wand meter reacts to a magnet near the board | Proposed |
| Readings stable at rest (check `raw` meters in Trainer view) | Proposed |
| One touch → one event; release and touch again → another | Proposed |
| No repeat triggers from noise with laptop on battery and on charger | Proposed |
| Unplug / replug → page reconnects without the picker | Proposed |
| Board reset (EN button) → new boot id, sequence restarts cleanly | Proposed |
| Physical touch changes browser state | Proposed |
| Deliberately wrong sequence → recorded violation that names the actual mistake | Proposed |
| Exported CSV matches the on-screen event log | Proposed |

Record results in this file as you run them, with the date and who ran them.
