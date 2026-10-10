# Serial protocol v1

USB serial, 115200 baud, 8N1. One JSON object per line, terminated by `\n` (the browser also accepts `\r\n`). Maximum line length 512 characters. Every message carries `"v":1`; a different version is rejected.

The same event names are used by the firmware (`MRISafeController.ino`), the browser parser (`parseLine` in `simulator/engine.js`), the assessment engine and the trainer report.

## Device → browser

| type | Fields | When |
|---|---|---|
| `hello` | `fw`, `boot` (random 32-bit id per power-up), `pads`, `board`, `imu` (`MPU9250`/`MPU9255`/`MPU6500`/`none`), `mag` (true/false) | After calibration, and on `cmd:hello` |
| `cal` | `pad`, `gpio`, `base`, `thr`, `sd`, `ok` | Once per pad after each calibration |
| `action` | `id` (T1–T6), `event`, `seq` (starts at 1 per boot), `t` (ms since boot), `boot` | Once per valid touch (press edge only) |
| `hb` | `t`, `seq` (last action seq) | Every 2 s |
| `raw` | `vals` (six filtered readings) | Every 100 ms while raw streaming is on |
| `imu` | `r` roll °, `p` pitch °, `gz` yaw rate °/s, `mag` field µT, `dmag` change since levelling µT (last two only with a magnetometer), `t` | 25 Hz while streaming (default on) |
| `gesture` | `g` = `tap` · `double_tap` · `flick_left` · `flick_right`, `seq` (own counter), `t` | When detected |
| `err` | `code`, `pad`, `msg` | `CAL_UNSTABLE`, `PAD_ZERO`, `PAD_STUCK`, `IMU_MISSING`, `MAG_MISSING` |
| `log` | `msg` and details | Information, e.g. after levelling |
| `pong` | `t` | Reply to `cmd:ping` |

Example:

```
{"v":1,"type":"action","id":"T1","event":"SCREENING_CHECK","seq":1,"t":5123,"boot":3141592653}
```

## Browser → device

| Message | Effect |
|---|---|
| `{"v":1,"type":"ack","seq":N,"status":"received"}` | Sent for each accepted action. Device flashes the on-board LED green. |
| `{"v":1,"type":"cmd","cmd":"hello"}` | Device re-sends `hello` (sent by the browser on connect). |
| `{"v":1,"type":"cmd","cmd":"recal"}` | Re-measure baselines. Keep hands off the pads. |
| `{"v":1,"type":"cmd","cmd":"raw_on"}` / `raw_off` | Start/stop `raw` streaming for threshold tuning. |
| `{"v":1,"type":"cmd","cmd":"ping"}` | Device answers `pong`. |
| `{"v":1,"type":"cmd","cmd":"imu_zero"}` | Re-measure gyro bias, define the current pose as level, and reset the magnetometer baseline. Keep the board flat and still. |
| `{"v":1,"type":"cmd","cmd":"imu_on"}` / `imu_off` | Start/stop `imu` streaming. |

## Pad map

| Pad | GPIO | Event |
|---|---|---|
| T1 | 4 | `SCREENING_CHECK` |
| T2 | 5 | `VERIFY_EQUIPMENT` |
| T3 | 6 | `ROOM_ACCESS` |
| T4 | 7 | `SAFETY_CLEARANCE` |
| T5 | 8 | `PROCEED_TO_SCAN` (the brief's `START_SIMULATION` is accepted as an alias) |
| T6 | 9 | `RESET_SCENARIO` |

## Validation rules in the browser

| Problem | Result |
|---|---|
| Boot ROM text or any non-JSON line | Ignored, counted as `NOT_JSON` |
| Broken JSON | Ignored, `BAD_JSON` |
| `v` not 1 | Rejected, `VERSION_MISMATCH` |
| Unknown `type` | Rejected, `UNKNOWN_TYPE` |
| Unknown `event` | Rejected, `UNKNOWN_EVENT` |
| `id` and `event` disagree | Rejected, `PAD_EVENT_MISMATCH` |
| `seq` missing, negative or not an integer | Rejected, `BAD_SEQ` |
| `seq` ≤ last seen for this `boot` | Dropped as duplicate (never reaches the engine) |
| `seq` jumps by more than 1 | Accepted, counted as a gap |
| `imu` with non-numeric or out-of-range roll/pitch | Rejected, `BAD_IMU` |
| Unknown gesture name | Rejected, `UNKNOWN_GESTURE` |
| New `boot` id | Sequence tracking restarts |

All counters are visible under **Trainer view → Device diagnostics**.

## Received is not completed

A touch produces an `action` message. The browser records it as **received**. The engine then decides whether it is **accepted**, whether it **completes a checkpoint**, and whether it is a **violation**. These are separate fields in every event-log row and in the CSV export.

## Who handles what in the app

The app shell (`index.html`) owns the USB port. In **Train** it forwards every line to the trainer, which validates, filters duplicates, acknowledges and assesses as before. In **Learn** and **Home** the shell acknowledges pad actions itself and maps them to navigation. `imu` messages become orbit or pointer movement (`controller.js`), and gestures become select / reset / navigation.

## Disconnects

* Unplugging fires the Web Serial `disconnect` event; the header shows *Device lost*.
* Plugging the same board back in fires `connect`; the page re-opens the port without the picker.
* On page load, a single previously granted port is opened automatically.
* If no data arrives for 6 s (heartbeat is 2 s), the header warns *No data*.
* Keys 1–6 and the on-screen pads keep working throughout, using the same event contract.
