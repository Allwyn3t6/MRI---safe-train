// MRISafeController.ino — ESP32-S3 controller for MRISafe Twin
//
//   6 capacitive touch pads  → checkpoint / navigation actions
//   MPU9250 (accel + gyro)   → tilt to orbit or point, tap / double-tap / flick gestures
//   AK8963 magnetometer      → "wand" meter (change in field strength near steel or magnets)
//
// Board:   ESP32-S3 dev board, Arduino-ESP32 core 2.0.x or 3.x, Board "ESP32S3 Dev Module"
// Serial:  115200 baud, newline-delimited JSON, protocol v1 (docs/protocol.md)
//
// Wiring
//   Pads:     T1 GPIO4, T2 GPIO5, T3 GPIO6, T4 GPIO7, T5 GPIO13, T6 GPIO14 (copper pads, no parts)
//   MPU9250:  VCC → 3V3, GND → GND, SDA → GPIO17, SCL → GPIO18, AD0 → GND (address 0x68)
//             (most breakout boards already have I2C pull-ups; NCS and INT can stay unconnected)
//
// Arduino IDE: native "USB" port → USB CDC On Boot: Enabled. "UART/COM" port → Disabled.
// After reset keep the board flat and still, hands off the pads, for about 2 seconds.

#include <Arduino.h>
#include <Wire.h>
#include "TouchDetector.h"
#include "Mpu9250.h"
#include "Motion.h"
#if __has_include(<esp_random.h>)
#include <esp_random.h>
#endif

static const char* FW_VERSION = "2.0.0";

// ---- pins (change here if your board differs) ----
static const int I2C_SDA = 17;
static const int I2C_SCL = 18;

// ---- axis mapping: board flat, chip up, USB toward you. Flip signs if tilt feels reversed. ----
static const float AX_SIGN = 1, AY_SIGN = 1, AZ_SIGN = 1;
static const float GX_SIGN = 1, GY_SIGN = 1, GZ_SIGN = 1;

// ---- timing ----
static const uint32_t TOUCH_MS = 10;     // 100 Hz pad sampling
static const uint32_t IMU_MS = 5;        // 200 Hz IMU sampling
static const uint32_t IMU_REPORT_MS = 40;// 25 Hz "imu" messages
static const uint32_t HEARTBEAT_MS = 2000;
static const uint32_t RAW_MS = 100;
static const int CALIB_SAMPLES = 64;

struct Pad { const char* id; uint8_t pin; const char* event; TouchDetector det; };
Pad pads[] = {   // must match PADS in simulator/engine.js
  {"T1", 4, "SCREENING_CHECK", {}},
  {"T2", 5, "VERIFY_EQUIPMENT", {}},
  {"T3", 6, "ROOM_ACCESS", {}},
  {"T4", 7, "SAFETY_CLEARANCE", {}},
  {"T5", 13, "PROCEED_TO_SCAN", {}},
  {"T6", 14, "RESET_SCENARIO", {}},
};
static const int NPADS = sizeof(pads) / sizeof(pads[0]);

Mpu9250 imu;
Motion motion;
static bool imuOk = false, imuStream = true, rawStream = false;
static float magBase = 0, magNow = 0;
static uint32_t seqNo = 0, gestureSeq = 0, bootId = 0;
static uint32_t lastTouch = 0, lastImu = 0, lastImuReport = 0, lastHb = 0, lastRaw = 0, ledOffAt = 0;
static uint32_t lastImuMicros = 0;
static char rxBuf[256]; static size_t rxLen = 0; static bool rxOverflow = false;

// ---------- LED ----------
static void led(uint8_t r, uint8_t g, uint8_t b, uint32_t ms) {
#ifdef RGB_BUILTIN
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  rgbLedWrite(RGB_BUILTIN, r, g, b);
#else
  neopixelWrite(RGB_BUILTIN, r, g, b);
#endif
  ledOffAt = ms ? millis() + ms : 0;
#else
  (void)r; (void)g; (void)b; (void)ms;
#endif
}

// ---------- output ----------
static void sendHello() {
  Serial.printf("{\"v\":1,\"type\":\"hello\",\"fw\":\"%s\",\"boot\":%lu,\"pads\":%d,\"board\":\"ESP32-S3\",\"imu\":\"%s\",\"mag\":%s}\n",
                FW_VERSION, (unsigned long)bootId, NPADS, imuOk ? imu.name() : "none", (imuOk && imu.hasMag()) ? "true" : "false");
}
static void sendErr(const char* code, const char* pad, const char* msg) {
  Serial.printf("{\"v\":1,\"type\":\"err\",\"code\":\"%s\",\"pad\":\"%s\",\"msg\":\"%s\"}\n", code, pad ? pad : "", msg ? msg : "");
}
static void sendGesture(const char* name) {
  gestureSeq++;
  Serial.printf("{\"v\":1,\"type\":\"gesture\",\"g\":\"%s\",\"seq\":%lu,\"t\":%lu}\n", name, (unsigned long)gestureSeq, (unsigned long)millis());
  led(30, 0, 30, 100);
}

// ---------- calibration ----------
static void calibratePads() {
  led(0, 0, 40, 0);
  for (int p = 0; p < NPADS; p++) pads[p].det.beginCalibration();
  for (int i = 0; i < CALIB_SAMPLES; i++) {
    for (int p = 0; p < NPADS; p++) pads[p].det.addCalibrationSample(touchRead(pads[p].pin));
    delay(8);
  }
  for (int p = 0; p < NPADS; p++) {
    Pad& pad = pads[p];
    const bool ok = pad.det.finishCalibration();
    Serial.printf("{\"v\":1,\"type\":\"cal\",\"pad\":\"%s\",\"gpio\":%u,\"base\":%lu,\"thr\":%lu,\"sd\":%lu,\"ok\":%s}\n",
                  pad.id, pad.pin, (unsigned long)pad.det.baseline(), (unsigned long)pad.det.pressThreshold(),
                  (unsigned long)pad.det.noise(), ok ? "true" : "false");
    if (!ok) sendErr("CAL_UNSTABLE", pad.id, "Pad noisy during calibration. Hands off, check wiring, then recal.");
    if (pad.det.baseline() < 1.0f) sendErr("PAD_ZERO", pad.id, "Reading is zero. Is this a touch-capable GPIO?");
  }
  led(0, 0, 0, 0);
}

static float magMagnitude() {
  float m[3];
  for (int i = 0; i < 20; i++) { if (imu.readMag(m)) return sqrtf(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]); delay(12); }
  return magNow;
}

static void zeroImu() {
  if (!imuOk) { sendErr("IMU_MISSING", "", "No MPU9250/MPU6500 found on I2C."); return; }
  led(40, 25, 0, 0);
  imu.calibrateGyro(200);
  // let the filter settle on the accelerometer, then define level
  float a[3], g[3];
  for (int i = 0; i < 150; i++) { if (imu.read(a, g)) motion.update(a[0] * AX_SIGN, a[1] * AY_SIGN, a[2] * AZ_SIGN, 0, 0, 0, 0.005f, millis()); delay(3); }
  motion.zero();
  if (imu.hasMag()) { magBase = magMagnitude(); magNow = magBase; }
  led(0, 0, 0, 0);
  Serial.printf("{\"v\":1,\"type\":\"log\",\"msg\":\"imu zeroed\",\"magBase\":%.1f}\n", magBase);
}

// ---------- commands from the browser ----------
static bool has(const char* s, const char* n) { return strstr(s, n) != nullptr; }
static void handleCommand(const char* line) {
  if (has(line, "\"type\":\"ack\"")) { led(0, 30, 0, 80); return; }
  if (!has(line, "\"type\":\"cmd\"")) return;
  if (has(line, "\"cmd\":\"hello\""))    { sendHello(); return; }
  if (has(line, "\"cmd\":\"ping\""))     { Serial.printf("{\"v\":1,\"type\":\"pong\",\"t\":%lu}\n", (unsigned long)millis()); return; }
  if (has(line, "\"cmd\":\"recal\""))    { calibratePads(); return; }
  if (has(line, "\"cmd\":\"raw_on\""))   { rawStream = true; return; }
  if (has(line, "\"cmd\":\"raw_off\""))  { rawStream = false; return; }
  if (has(line, "\"cmd\":\"imu_on\""))   { imuStream = true; return; }
  if (has(line, "\"cmd\":\"imu_off\""))  { imuStream = false; return; }
  if (has(line, "\"cmd\":\"imu_zero\"")) { zeroImu(); return; }
}
static void pollSerial() {
  while (Serial.available() > 0) {
    const int c = Serial.read();
    if (c < 0) break;
    if (c == '\n' || c == '\r') { if (rxLen && !rxOverflow) { rxBuf[rxLen] = 0; handleCommand(rxBuf); } rxLen = 0; rxOverflow = false; }
    else if (rxLen < sizeof(rxBuf) - 1) rxBuf[rxLen++] = (char)c;
    else rxOverflow = true;
  }
}

// ---------- setup / loop ----------
void setup() {
  Serial.begin(115200);
  const uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 1500) delay(10);
  bootId = esp_random();

  for (int p = 0; p < NPADS; p++) { TouchConfig c; c.risingOnTouch = true; pads[p].det.configure(c); (void)touchRead(pads[p].pin); }

  Wire.begin(I2C_SDA, I2C_SCL, 400000);
  imuOk = imu.begin(Wire) != Mpu9250::NONE;
  delay(200);
  calibratePads();
  if (imuOk) {
    zeroImu();
    if (!imu.hasMag()) sendErr("MAG_MISSING", "", "No AK8963 magnetometer (board may be an MPU6500). Wand meter disabled.");
  } else {
    sendErr("IMU_MISSING", "", "No MPU9250 found at 0x68. Check SDA=GPIO17, SCL=GPIO18, 3V3, GND, AD0=GND.");
  }
  lastImuMicros = micros();
  sendHello();
}

void loop() {
  const uint32_t now = millis();
  pollSerial();

  // touch pads
  if (now - lastTouch >= TOUCH_MS) {
    lastTouch = now;
    for (int p = 0; p < NPADS; p++) {
      Pad& pad = pads[p];
      const TouchEvent ev = pad.det.update(touchRead(pad.pin), now);
      if (ev == TouchEvent::Press) {
        seqNo++;
        Serial.printf("{\"v\":1,\"type\":\"action\",\"id\":\"%s\",\"event\":\"%s\",\"seq\":%lu,\"t\":%lu,\"boot\":%lu}\n",
                      pad.id, pad.event, (unsigned long)seqNo, (unsigned long)now, (unsigned long)bootId);
        led(0, 25, 30, 120);
      } else if (ev == TouchEvent::Stuck) {
        sendErr("PAD_STUCK", pad.id, "Pad has read as touched for 10 s. Release it or recalibrate.");
      }
    }
  }

  // IMU
  if (imuOk && now - lastImu >= IMU_MS) {
    lastImu = now;
    const uint32_t us = micros();
    const float dt = (us - lastImuMicros) / 1e6f;
    lastImuMicros = us;
    float a[3], g[3];
    if (imu.read(a, g)) {
      const Gesture gs = motion.update(a[0] * AX_SIGN, a[1] * AY_SIGN, a[2] * AZ_SIGN,
                                       g[0] * GX_SIGN, g[1] * GY_SIGN, g[2] * GZ_SIGN, dt, now);
      if (gs == Gesture::Tap) sendGesture("tap");
      else if (gs == Gesture::DoubleTap) sendGesture("double_tap");
      else if (gs == Gesture::FlickLeft) sendGesture("flick_left");
      else if (gs == Gesture::FlickRight) sendGesture("flick_right");
    }
    float m[3];
    if (imu.readMag(m)) magNow = 0.8f * magNow + 0.2f * sqrtf(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]);
  }
  if (imuOk && imuStream && now - lastImuReport >= IMU_REPORT_MS) {
    lastImuReport = now;
    if (imu.hasMag())
      Serial.printf("{\"v\":1,\"type\":\"imu\",\"r\":%.1f,\"p\":%.1f,\"gz\":%.0f,\"mag\":%.1f,\"dmag\":%.1f,\"t\":%lu}\n",
                    motion.roll(), motion.pitch(), motion.yawRate(), magNow, magNow - magBase, (unsigned long)now);
    else
      Serial.printf("{\"v\":1,\"type\":\"imu\",\"r\":%.1f,\"p\":%.1f,\"gz\":%.0f,\"t\":%lu}\n",
                    motion.roll(), motion.pitch(), motion.yawRate(), (unsigned long)now);
  }

  if (rawStream && now - lastRaw >= RAW_MS) {
    lastRaw = now;
    Serial.print("{\"v\":1,\"type\":\"raw\",\"vals\":[");
    for (int p = 0; p < NPADS; p++) { Serial.print((unsigned long)pads[p].det.filtered()); if (p < NPADS - 1) Serial.print(','); }
    Serial.println("]}");
  }
  if (now - lastHb >= HEARTBEAT_MS) {
    lastHb = now;
    Serial.printf("{\"v\":1,\"type\":\"hb\",\"t\":%lu,\"seq\":%lu}\n", (unsigned long)now, (unsigned long)seqNo);
  }
  if (ledOffAt && (int32_t)(now - ledOffAt) >= 0) { led(0, 0, 0, 0); ledOffAt = 0; }
}
