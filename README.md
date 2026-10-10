# MRISafe Twin

One app, two modes, one handheld controller:

* **Train**: prepare a patient for MRI in a 3D suite. Touch a pad to sign off each check; a rule-based assessor verifies it against what you actually did, explains mistakes, and produces a trainer report. Any feedback card can be hidden, or saved to a feedback log.
* **Learn**: a 3D cutaway of the scanner. Build it layer by layer, then see spins, RF excitation, contrast, slice selection, k-space and quench with live physics.
* **Coach**: an offline tutor with a built-in knowledge base of about 90 topics (MR safety, screening, equipment labelling, physics, hardware, and this app). It explains your mistakes from the rule that was broken, debriefs an attempt, and answers questions. No account, key or internet is needed. An optional free local AI model (Ollama) can generate longer answers.
* **Light or dark theme**: one switch in the header, remembered in the browser.
* **ESP32-S3 controller**: six touch pads plus an MPU9250 for tilt, tap and flick control, and a magnetometer "wand" meter.

> Educational prototype. Safety rules are illustrative simplifications modelled on the ACR Manual on MR Safety and ASTM F2503, not clinical protocol. The scanner is schematic and no real field is simulated. The rule engine's decision is the reference; coach answers are teaching text.

## Start it (2 minutes)

1. Install Python 3.8 or newer. On Windows, tick **Add Python to PATH**, or install it from the Microsoft Store.
2. Unzip, then double-click **`start.bat`** (Windows) or run `./start.sh` (Mac/Linux).
   This runs `python server/server.py` and opens **http://127.0.0.1:8000** (if 8000 is busy it uses 8001, 8002 … and prints the address). Keep that window open while you use the app.
3. Use **Chrome or Edge** (USB access needs them).

The coach and the 3D modules work without the server too: you can open `simulator/index.html` through a local web server, or use the server as above. The server is needed only for the optional local AI model and for the Controller (USB) connection's localhost requirement.

The home screen shows readiness checks for the controller, the coach, and the browser. Everything works without the controller (mouse and keys 1–6).

## The coach

The coach answers from `simulator/knowledge-base.js` in your browser. Each reply is labelled **Knowledge base · offline**, so you always know where it came from. It matches your question to the most relevant entries and says so honestly when it does not know, suggesting questions it can answer.

* **Explain my last mistake** builds its answer from the rule card: the rule ID, what happened, why it matters, and the corrective step. Background is added from the knowledge base.
* **Debrief this attempt** summarises the score, actions, mistakes and the recommended next scenario.
* **Quiz me** gives a question and its answer.
* In **Learn**, the tutor explains the open chapter and answers questions about it.

Adding knowledge: append an entry to `MRIKB` in `simulator/knowledge-base.js` (fields `id`, `topic`, `q`, `tags`, `a`, `see`), then run the tests. No other change is needed.

### Optional: a free local AI model (Ollama)

This gives longer, more conversational answers. Everything runs on your laptop, with no key and no cost.

1. Install Ollama from https://ollama.com, then run `ollama pull llama3.1` once (it needs internet only for this download).
2. Copy `server/.env.example` to `server/.env` and uncomment the two lines under **Ollama**.
3. Restart the server. The terminal prints `Coach: offline knowledge base + local AI model`.

How it stays safe:
* The **server** writes the prompts. The model only sees the broken rule, the recorded evidence and recent events (or the chapter notes), and is told not to invent anything or overrule the engine.
* Every reply is checked: an explanation must cite the rule that was broken and must not mention other rules. If it fails, the reply is marked **"Check against the rule card"**.
* If the local model is not running, the coach falls back to the knowledge base and says so.
* Inputs are size-limited and requests are rate-limited (20 per minute by default).

Other OpenAI-compatible servers (LM Studio, OpenAI) also work through `server/.env`; see `server/.env.example`. Azure OpenAI is no longer supported.

## Assessor: hide and log

* **Hide** collapses the feedback card so the procedure list and inspector are visible again. A new mistake opens it again.
* **Save to log** keeps the card in a feedback log, kept in this browser. The log appears in the **Trainer view** (T) and can be downloaded as text or included in the JSON report.
* The event log is unchanged: it still records every action, so the CSV export still matches what happened.

## Hand control (webcam, optional)

Click **Hand control** in the header while Train or Learn is open. Two hands work together:

- **Right hand:** point with the index finger to aim, pinch to tap or select, pinch and drag to orbit, and hold an open palm for one second to reset the view.
- **Both palms open:** move them apart to zoom in, and together to zoom out. While zooming, the right hand's taps, drags and resets pause, so the two never fight.

The card has two extra buttons:

- **Swap hands:** use it if your right hand is treated as left. Camera left and right can be read either way, so this is the quick fix.
- **Speak feedback:** reads status aloud (hand found, zoom on or off, tap, view reset). It is off until you turn it on. Screen readers always receive the same messages through a live region, whatever this button says.

The camera image is analysed in your browser with MediaPipe and never leaves this computer. The hand model file (`hand_landmarker.task`, about 8 MB) is loaded from `simulator/models/` if present, otherwise from Google's storage the first time you use it. To run fully offline, save it into `simulator/models/` (see `simulator/vendor/mediapipe/README.md`). Use Chrome or Edge on `localhost` or `https`. The standalone `trainer.html` has no hand control; it lives in the app shell.

Voice commands are not included. Browser speech recognition sends audio to a cloud service, which would break the promise that camera and voice stay on this computer.

## Theme

Use the **Light / Dark** button in the header. The choice applies to Home, Train and Learn, including the 3D scenes, and is remembered in this browser.

## Build the controller

**Parts**: ESP32-S3 dev board, MPU9250 breakout (I2C), six copper-tape pads (2–3 cm), jumper wires. No resistors needed.

| Connection | ESP32-S3 pin |
|---|---|
| Pad T1 … T6 | GPIO 4, 5, 6, 7, 13, 14 (keeps GPIO 8–12 free for the TFT) |
| MPU9250 VCC | 3V3 |
| MPU9250 GND | GND |
| MPU9250 SDA | GPIO 17 |
| MPU9250 SCL | GPIO 18 |
| MPU9250 AD0 | GND (address 0x68) |

Firmware: open `firmware/MRISafeController/MRISafeController.ino` in Arduino IDE with **esp32 by Espressif**, board **ESP32S3 Dev Module**. Native USB port → *USB CDC On Boot: Enabled* (UART port → Disabled). No extra libraries. Upload, then keep the board **flat, still and hands off** for 2 seconds.

In the app: controller chip (top right) → **Connect** → pick the port → **Level the controller**.

Many cheap "MPU9250" boards are really MPU6500 (no magnetometer). The app tells you; tilt and gestures still work, only the wand meter is disabled.

## Controls

| Pad | Train | Learn | Home |
|---|---|---|---|
| T1 | Screening sign-off | Previous chapter | Open Train |
| T2 | Equipment verified | Next chapter | Open Learn |
| T3 | Zone IV access | Peel a layer | |
| T4 | Final clearance | Restore a layer | |
| T5 | Proceed to scan | Explode / assemble | |
| T6 | Reset attempt | Reset view | |

| Motion | Train | Learn |
|---|---|---|
| Tilt | Orbit the view, or move the pointer in point mode | Orbit the view |
| Tap | Select what the pointer is on | Play the chapter action (RF pulse, acquire, build, quench) |
| Double tap | Reset camera | Reset camera |
| Flick left/right | Switch orbit ↔ point mode | Previous / next chapter |

Tilt works like a joystick: a 7° dead zone, then speed rises smoothly up to 32°. No compass heading is used, so there is no drift.

The **wand meter** (controller panel) shows the change in magnetic field strength since levelling. Bring a magnet or steel near the board to demonstrate how ferromagnetic detectors respond. Real detectors support screening; they never replace it.

Keyboard: `1`–`6` = pads, `←` `→` = chapters, `T` = trainer report, `?` = help.

## Five-minute demo

1. **Home**: show the readiness checks, connect the controller, level it. Switch the theme to show both.
2. **Train**: tilt to look around the suite. Touch **T3** first: critical violation, explained. Press **Explain this with the coach**: the rule is cited. Press **Save to log**, then **Hide** to show that the procedure is still usable.
3. Touch **T2** with the oxygen cylinder still in Zone IV: rejected with the evidence. Flick to point mode, aim at the cylinder, tap to select, classify it MR Unsafe, move it out, touch **T2** again.
4. Finish (T3, T4, T5); the table slides into the bore. Ask the coach for a **debrief**.
5. **Learn**: flick right through Assembly and The magnet; tap to fire an RF pulse in chapter 9; ask the tutor "Why is the field always on?".
6. Close with the quench chapter: it links the hardware back to the safety rules.

## Project layout

```
start.bat / start.sh       one-click start (runs the server, opens the browser)
server/
  server.py                static files + optional local AI proxy (Ollama / OpenAI-compatible), stdlib only
  .env.example             optional, copy to .env
simulator/
  index.html               the app shell: Home, mode switch, controller link, coach, help, theme
  trainer.html             Train mode (also runs on its own)
  internals.html           Learn mode (also runs on its own)
  knowledge-base.js        the coach's knowledge base (about 90 entries)
  coach.js                 offline retrieval coach: answers, rule-grounded explanations, debrief, quiz
  hand-logic.js            pinch, point, open-palm gesture logic and camera-to-screen mapping (pure)
  hand-control.js          webcam + MediaPipe HandLandmarker loop, preview and status
  engine.js                assessment engine, rules, scenarios, adaptive selection, serial parser
  physics.js               Larmor, slice selection, Bloch relaxation, signal equation, FFT
  controller.js            tilt → orbit/pointer mapping, pad and gesture meanings
  theme.css, theme.js      light and dark colour tokens and the theme switch
  vendor/                  three.js r165, GSAP 3.12.5 and MediaPipe Tasks Vision 0.10.14 (offline copies)
  models/                  optional hand_landmarker.task for offline hand control
firmware/
  MRISafeController/       ESP32-S3 sketch + TouchDetector.h + Mpu9250.h + Motion.h
  tests/                   host tests for touch detection and motion/gestures (g++)
tests/                     engine, physics, controller, coach (node); server (python); browser smoke tests
docs/                      protocol, rules, test matrix
tools/build_hosted.py      single-file copies for a static host (the coach works there too)
```

## Run the tests

```bash
node --test tests/engine.test.js tests/physics.test.js tests/controller.test.js tests/coach.test.js tests/hand-logic.test.js
python -m unittest discover -s tests -p "test_server.py"
g++ -std=c++17 -I firmware/MRISafeController firmware/tests/test_touch_detector.cpp -o tdt && ./tdt
g++ -std=c++17 -I firmware/MRISafeController firmware/tests/test_motion.cpp -o tm && ./tm
```

## Known limitations

* Rules and scenarios are illustrative; review by a qualified MR safety officer is still needed.
* The coach answers only what its knowledge base covers. It says so when it does not know. Its answers are teaching text, not clinical advice.
* The firmware is syntax-checked and its touch and motion logic host-tested, but it has not yet been compiled or run on a real board in this build.
* Gesture thresholds are set for a hand-held breadboard; adjust `MotionConfig` in `Motion.h` if taps or flicks trigger too easily or not at all.
* Learning effectiveness has not been evaluated.

## Use of AI in this project

This codebase was generated with an AI assistant (Claude) from the team's specification. Check the hackathon's current rules, declare the AI use accurately, and make sure every team member can explain every component.
