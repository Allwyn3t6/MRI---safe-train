# MRISafeController firmware (ESP32-S3 + MPU9250)

Six capacitive pads and an MPU9250 motion sensor → JSON lines over USB serial (protocol in `../docs/protocol.md`).

## Wiring

| Part | ESP32-S3 |
|---|---|
| Pads T1–T6 | GPIO 4, 5, 6, 7, 13, 14 (copper/foil pads, short wires, no components) |
| MPU9250 VCC / GND | 3V3 / GND |
| MPU9250 SDA / SCL | GPIO 17 / GPIO 18 (change `I2C_SDA` / `I2C_SCL` if your board needs other pins) |
| MPU9250 AD0 | GND → I2C address 0x68 |
| MPU9250 NCS, INT, EDA, ECL, FSYNC | leave unconnected |

GPIO 4–7 and 13–14 are touch channels and not strapping pins (GPIO 13 and 14 are free on the hardware controller board too). If the TFT from `MRISafeHardware` is on the same board, its backlight goes to 3V3, not GPIO 7, so GPIO 7 can be the T4 pad. Do not use GPIO 19/20 (native USB). Most MPU9250 breakouts include I2C pull-up resistors; if `IMU_MISSING` appears with correct wiring, add 4.7 kΩ pull-ups from SDA and SCL to 3V3.

## Build

* Arduino IDE 2.x, Boards Manager → **esp32 by Espressif** (2.0.x or 3.x). No other libraries.
* Board **ESP32S3 Dev Module**. Native **USB** port → *USB CDC On Boot: Enabled*; **UART/COM** port → *Disabled*.
* Open `MRISafeController/MRISafeController.ino`. The `.h` files must stay in the same folder.
* Upload. Then keep the board **flat, still, hands off** for 2 s while pads and gyro calibrate.
* Close the Serial Monitor before connecting from the browser.

## What the firmware sends

| Message | When |
|---|---|
| `hello` | After start-up and on request; includes firmware version, IMU type (`MPU9250`, `MPU9255`, `MPU6500` or `none`) and whether a magnetometer exists |
| `action` | Once per pad touch (T1–T6) |
| `imu` | 25 times a second: roll, pitch, yaw rate, field magnitude and change since levelling |
| `gesture` | `tap`, `double_tap`, `flick_left`, `flick_right` |
| `cal`, `hb`, `err`, `raw`, `log` | Calibration, heartbeat, problems, raw pad values, notes |

## Files

| File | Purpose |
|---|---|
| `MRISafeController.ino` | Pins, timing, messages, commands |
| `TouchDetector.h` | Pad calibration, filtering, debounce, hysteresis, drift tracking (host-tested) |
| `Mpu9250.h` | Register-level driver: accel ±4 g, gyro ±500 °/s at 200 Hz; AK8963 magnetometer via I2C bypass |
| `Motion.h` | Complementary filter for roll/pitch and gesture detection (host-tested) |

## Tuning

* **Tilt feels reversed**: flip `AX_SIGN`/`AY_SIGN` and `GX_SIGN`/`GY_SIGN` in the sketch (mounting differs between breakouts).
* **Taps trigger too easily / not at all**: raise or lower `tapG` in `MotionConfig` (default 0.9 g above rest).
* **Flicks**: `flickDps` (default 260 °/s).
* **Pads**: `thresholdRatio` and `sigmaK` in `TouchConfig`; use *Trainer view → Device diagnostics → Stream raw values* to see readings against thresholds.

## Host tests (no hardware)

```bash
g++ -std=c++17 -I MRISafeController tests/test_touch_detector.cpp -o tdt && ./tdt
g++ -std=c++17 -I MRISafeController tests/test_motion.cpp -o tm && ./tm
```
