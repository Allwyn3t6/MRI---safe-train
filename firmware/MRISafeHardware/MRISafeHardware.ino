// MRISafeHardware.ino — ESP32-S3 hardware controller for MRISafe Twin (v2)
//
//   Potentiometer → chooses the checkpoint (T1…T6) that is armed; shown on the display
//   FSR            → press to send the armed checkpoint (one squeeze = one action)
//   MPU9250        → tilt to orbit or point, tap / double-tap / flick gestures, wand meter
//   1.8" TFT 128x160 (ST7735, SPI) → armed checkpoint, last sent, tilt, live readings
//   Programmable LED (WS2812-type, GPIO 48 on most S3 dev boards) → feedback colours
//
// Serial: 115200 baud, newline-delimited JSON, protocol v1 (docs/protocol.md).
// The browser app sees the same messages as the touch-pad firmware, so nothing else changes.
//
// Libraries (Arduino Library Manager): "Adafruit ST7735 and ST7789 Library" and "Adafruit GFX Library".
// Board: "ESP32S3 Dev Module", Arduino-ESP32 2.0.x or 3.x. Native USB port → USB CDC On Boot: Enabled.
// See README.md in this folder for wiring and first run.

#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <string.h>
#include <stdio.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include "Inputs.h"
#include "Mpu9250.h"
#include "Motion.h"
#if __has_include(<esp_random.h>)
#include <esp_random.h>
#endif

static const char* FW_VERSION = "2.1.0-hw";

// ---------- pins (change here if your wiring differs) ----------
static const int PIN_POT = 1;          // ADC1 channel 0
static const int PIN_FSR = 2;          // ADC1 channel 1
static const int PIN_I2C_SDA = 17;     // MPU9250 SDA
static const int PIN_I2C_SCL = 18;     // MPU9250 SCL
static const int PIN_TFT_SCK = 12;     // display SCL / SCK
static const int PIN_TFT_MOSI = 11;    // display SDA / MOSI
static const int PIN_TFT_CS = 10;      // display CS
static const int PIN_TFT_DC = 9;       // display DC / A0
static const int PIN_TFT_RST = 8;      // display RST / RESET
static const int PIN_TFT_BL = 7;       // display LED / backlight; -1 if wired to 3V3 (frees GPIO 7 for pad T4)
#ifndef PIN_STATUS_LED
#define PIN_STATUS_LED 48              // programmable RGB LED
#endif

// ---------- sensor mounting and tuning ----------
static const bool POT_REVERSED = false;   // true if turning clockwise lowers the selection
static const bool FSR_INVERTED = false;   // true if the FSR reading goes DOWN when squeezed
static const int ADC_MAX = 4095;          // 12-bit ADC
static const int POT_HYSTERESIS = 40;     // counts; stops flicker at a boundary
static const int FSR_PRESS_DELTA = 350;   // counts above rest that count as a press
static const int FSR_RELEASE_DELTA = 200; // counts above rest that count as released
static const uint32_t FSR_DEBOUNCE_MS = 15;
static const uint32_t FSR_REFRACTORY_MS = 120;

// Axis mapping: board flat, chip up, USB toward you. Flip signs if tilt feels reversed.
static const float AX_SIGN = 1, AY_SIGN = 1, AZ_SIGN = 1;
static const float GX_SIGN = 1, GY_SIGN = 1, GZ_SIGN = 1;

// ---------- timing ----------
static const uint32_t INPUT_MS = 10;       // pot and FSR at 100 Hz
static const uint32_t IMU_MS = 5;          // IMU at 200 Hz
static const uint32_t IMU_REPORT_MS = 40;  // 25 Hz "imu" messages
static const uint32_t DISPLAY_MS = 100;    // screen refresh
static const uint32_t HEARTBEAT_MS = 2000;

// ---------- checkpoints: ids and events must match PADS in simulator/engine.js ----------
struct Checkpoint { const char* id; const char* event; const char* label; };
static const Checkpoint CP[6] = {
  {"T1", "SCREENING_CHECK",  "Screening"},
  {"T2", "VERIFY_EQUIPMENT", "Equipment"},
  {"T3", "ROOM_ACCESS",      "Zone IV access"},
  {"T4", "SAFETY_CLEARANCE", "Final clearance"},
  {"T5", "PROCEED_TO_SCAN",  "Proceed to scan"},
  {"T6", "RESET_SCENARIO",   "Reset attempt"},
};
static const int NCP = 6;

// ---------- colours ----------
static const uint16_t GREY = 0x7BEF;
static const uint16_t DIM = 0x4208;

// ---------- globals ----------
Adafruit_ST7735 tft(&SPI, PIN_TFT_CS, PIN_TFT_DC, PIN_TFT_RST);
Mpu9250 imu;
Motion motion;
PotSelector pot;
FsrPress fsr;

static bool imuOk = false, imuStream = true, hostSeen = false;
static int potRaw = 0, fsrRaw = 0, fsrBaseline = 0;
static float magBase = 0, magNow = 0;
static uint32_t seqNo = 0, gestureSeq = 0, bootId = 0;
static uint32_t lastInput = 0, lastImu = 0, lastImuReport = 0, lastHb = 0, lastDisplay = 0;
static uint32_t lastImuMicros = 0, ledOffAt = 0, msgUntil = 0;
static char rxBuf[256];
static size_t rxLen = 0;
static bool rxOverflow = false;
static char lastSent[24] = "none";
static char msgText[40] = "";
static uint16_t msgColor = 0xFFFF;

// ---------- status LED ----------
static void led(uint8_t r, uint8_t g, uint8_t b, uint32_t ms) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  rgbLedWrite(PIN_STATUS_LED, r, g, b);
#else
  neopixelWrite(PIN_STATUS_LED, r, g, b);
#endif
  ledOffAt = ms ? millis() + ms : 0;
}

// ---------- on-screen messages ----------
static void showMessage(const char* text, uint32_t ms, uint16_t color) {
  strncpy(msgText, text, sizeof(msgText) - 1);
  msgText[sizeof(msgText) - 1] = 0;
  msgColor = color;
  msgUntil = ms ? millis() + ms : 0;
}

// ---------- serial output (protocol v1) ----------
static void sendHello() {
  Serial.printf("{\"v\":1,\"type\":\"hello\",\"fw\":\"%s\",\"boot\":%lu,\"pads\":%d,\"board\":\"ESP32-S3\",\"imu\":\"%s\",\"mag\":%s}\n",
                FW_VERSION, (unsigned long)bootId, NCP, imuOk ? imu.name() : "none",
                (imuOk && imu.hasMag()) ? "true" : "false");
}

static void sendErr(const char* code, const char* msg) {
  Serial.printf("{\"v\":1,\"type\":\"err\",\"code\":\"%s\",\"pad\":\"\",\"msg\":\"%s\"}\n", code, msg ? msg : "");
  showMessage(code, 3000, ST77XX_RED);
  led(50, 0, 0, 300);
}

static void sendGesture(const char* name) {
  gestureSeq++;
  Serial.printf("{\"v\":1,\"type\":\"gesture\",\"g\":\"%s\",\"seq\":%lu,\"t\":%lu}\n",
                name, (unsigned long)gestureSeq, (unsigned long)millis());
  char m[40];
  snprintf(m, sizeof(m), "gesture: %s", name);
  showMessage(m, 900, ST77XX_MAGENTA);
  led(30, 0, 30, 100);
}

static void sendAction(int slot) {
  const Checkpoint& c = CP[slot];
  seqNo++;
  Serial.printf("{\"v\":1,\"type\":\"action\",\"id\":\"%s\",\"event\":\"%s\",\"seq\":%lu,\"t\":%lu,\"boot\":%lu}\n",
                c.id, c.event, (unsigned long)seqNo, (unsigned long)millis(), (unsigned long)bootId);
  snprintf(lastSent, sizeof(lastSent), "%s  #%lu", c.id, (unsigned long)seqNo);
  led(0, 25, 30, 120);
}

// ---------- calibration ----------
static int readFsr() {
  int f = analogRead(PIN_FSR);
  return FSR_INVERTED ? ADC_MAX - f : f;
}

static void calibrateFsr() {
  showMessage("Hands off the FSR", 0, ST77XX_YELLOW);
  led(40, 25, 0, 0);
  long sum = 0;
  for (int i = 0; i < 64; i++) { sum += readFsr(); delay(8); }
  fsrBaseline = (int)(sum / 64);
  fsr.setBaseline(fsrBaseline);
  Serial.printf("{\"v\":1,\"type\":\"log\",\"msg\":\"fsr rest\",\"base\":%d}\n", fsrBaseline);
  led(0, 0, 0, 0);
  showMessage("FSR ready", 1200, ST77XX_GREEN);
}

static float magMagnitude() {
  float m[3];
  for (int i = 0; i < 20; i++) {
    if (imu.readMag(m)) return sqrtf(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]);
    delay(12);
  }
  return magNow;
}

static void zeroImu() {
  if (!imuOk) { sendErr("IMU_MISSING", "No MPU9250/MPU6500 found on I2C."); return; }
  showMessage("Level: keep still", 0, ST77XX_YELLOW);
  led(40, 25, 0, 0);
  imu.calibrateGyro(200);
  float a[3], g[3];
  for (int i = 0; i < 150; i++) {
    if (imu.read(a, g)) motion.update(a[0] * AX_SIGN, a[1] * AY_SIGN, a[2] * AZ_SIGN, 0, 0, 0, 0.005f, millis());
    delay(3);
  }
  motion.zero();
  if (imu.hasMag()) { magBase = magMagnitude(); magNow = magBase; }
  led(0, 0, 0, 0);
  showMessage("Level set", 1200, ST77XX_GREEN);
  Serial.printf("{\"v\":1,\"type\":\"log\",\"msg\":\"imu zeroed\",\"magBase\":%.1f}\n", magBase);
}

// ---------- commands from the browser ----------
static bool has(const char* s, const char* n) { return strstr(s, n) != nullptr; }

static void handleCommand(const char* line) {
  hostSeen = true;
  if (has(line, "\"type\":\"ack\"")) { led(0, 30, 0, 80); showMessage("host received", 700, ST77XX_GREEN); return; }
  if (!has(line, "\"type\":\"cmd\"")) return;
  if (has(line, "\"cmd\":\"hello\""))    { sendHello(); return; }
  if (has(line, "\"cmd\":\"ping\""))     { Serial.printf("{\"v\":1,\"type\":\"pong\",\"t\":%lu}\n", (unsigned long)millis()); return; }
  if (has(line, "\"cmd\":\"recal\""))    { calibrateFsr(); return; }
  if (has(line, "\"cmd\":\"imu_on\""))   { imuStream = true; return; }
  if (has(line, "\"cmd\":\"imu_off\""))  { imuStream = false; return; }
  if (has(line, "\"cmd\":\"imu_zero\"")) { zeroImu(); return; }
  // raw_on / raw_off belong to the touch-pad firmware; accepted and ignored here.
}

static void pollSerial() {
  while (Serial.available() > 0) {
    const int c = Serial.read();
    if (c < 0) break;
    if (c == '\n' || c == '\r') {
      if (rxLen && !rxOverflow) { rxBuf[rxLen] = 0; handleCommand(rxBuf); }
      rxLen = 0;
      rxOverflow = false;
    } else if (rxLen < sizeof(rxBuf) - 1) {
      rxBuf[rxLen++] = (char)c;
    } else {
      rxOverflow = true;
    }
  }
}

// ---------- display ----------
// Each text row is a cell. A row is only repainted when its text or colour changes, so the screen does not flicker.
struct Cell { char text[40]; uint16_t fg; uint8_t size; bool used; };
static Cell cells[12];

static void showText(int slot, int x, int y, int w, int h, const char* txt, uint16_t fg, uint8_t size = 1) {
  Cell& c = cells[slot];
  if (c.used && c.fg == fg && c.size == size && strcmp(c.text, txt) == 0) return;
  c.used = true;
  c.fg = fg;
  c.size = size;
  strncpy(c.text, txt, sizeof(c.text) - 1);
  c.text[sizeof(c.text) - 1] = 0;
  tft.fillRect(x, y, w, h, ST77XX_BLACK);
  tft.setTextSize(size);
  tft.setTextColor(fg);
  tft.setCursor(x + 2, y + 1);
  tft.print(c.text);
}

static int barSel = -1;
static void drawBar(int sel) {
  if (sel == barSel) return;
  barSel = sel;
  tft.fillRect(0, 44, 160, 13, ST77XX_BLACK);
  tft.setTextSize(1);
  for (int i = 0; i < NCP; i++) {
    const int x = 4 + i * 26, y = 44, w = 24, h = 12;
    if (i == sel) {
      tft.fillRect(x, y, w, h, ST77XX_CYAN);
      tft.setTextColor(ST77XX_BLACK);
    } else {
      tft.drawRect(x, y, w, h, ST77XX_BLUE);
      tft.setTextColor(ST77XX_WHITE);
    }
    tft.setCursor(x + 6, y + 3);
    tft.print(CP[i].id);
  }
}

static bool hostLive() { return hostSeen; }

static void updateDisplay() {
  const int sel = pot.slot();
  char buf[48];

  showText(0, 0, 0, 100, 12, "MRI SAFE TWIN", ST77XX_CYAN);
  showText(1, 100, 0, 60, 12, hostLive() ? "HOST ON" : "WAIT", hostLive() ? ST77XX_GREEN : ST77XX_ORANGE);

  showText(2, 0, 14, 50, 26, CP[sel].id, ST77XX_WHITE, 3);
  showText(3, 52, 15, 108, 10, CP[sel].label, ST77XX_WHITE);
  showText(4, 52, 27, 108, 10, "turn pot, squeeze FSR", GREY);
  drawBar(sel);

  snprintf(buf, sizeof(buf), "sent %s", lastSent);
  showText(5, 0, 60, 160, 10, buf, ST77XX_YELLOW);

  snprintf(buf, sizeof(buf), "roll %5.1f  pitch %5.1f", motion.roll(), motion.pitch());
  showText(6, 0, 72, 160, 10, buf, ST77XX_WHITE);

  snprintf(buf, sizeof(buf), "pot %4d  fsr %4d", potRaw, fsrRaw);
  showText(7, 0, 84, 160, 10, buf, GREY);

  snprintf(buf, sizeof(buf), "imu %s%s", imuOk ? imu.name() : "NONE",
           (imuOk && imu.hasMag()) ? " + mag" : "");
  showText(8, 0, 96, 160, 10, buf, imuOk ? ST77XX_WHITE : ST77XX_RED);

  // message line; empty when expired
  if (msgUntil && (int32_t)(millis() - msgUntil) >= 0) { msgText[0] = 0; msgUntil = 0; }
  showText(9, 0, 110, 160, 12, msgText, msgColor);
}

// ---------- setup ----------
void setup() {
  Serial.begin(115200);
  const uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 1500) delay(10);
  bootId = esp_random();

  if (PIN_TFT_BL >= 0) {          // set PIN_TFT_BL to -1 when the backlight is wired to 3V3
    pinMode(PIN_TFT_BL, OUTPUT);
    digitalWrite(PIN_TFT_BL, HIGH);
  }
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_POT, ADC_11db);
  analogSetPinAttenuation(PIN_FSR, ADC_11db);

  SPI.begin(PIN_TFT_SCK, -1, PIN_TFT_MOSI, PIN_TFT_CS);
  tft.initR(INITR_BLACKTAB);      // most 1.8" 128x160 modules; if colours look wrong try INITR_GREENTAB or INITR_REDTAB
  tft.setRotation(1);             // landscape, 160 x 128
  tft.setTextWrap(false);
  tft.fillScreen(ST77XX_BLACK);
  showMessage("Starting...", 0, ST77XX_YELLOW);

  pot.begin(NCP, ADC_MAX, POT_HYSTERESIS, POT_REVERSED);
  for (int i = 0; i < 20; i++) pot.update(analogRead(PIN_POT));
  potRaw = analogRead(PIN_POT);

  calibrateFsr();
  fsr.begin(fsrBaseline, FSR_PRESS_DELTA, FSR_RELEASE_DELTA, FSR_DEBOUNCE_MS, FSR_REFRACTORY_MS);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 400000);
  imuOk = imu.begin(Wire) != Mpu9250::NONE;
  delay(200);
  if (imuOk) {
    zeroImu();
    if (!imu.hasMag()) sendErr("MAG_MISSING", "No AK8963 magnetometer (board may be an MPU6500). Wand meter disabled.");
  } else {
    sendErr("IMU_MISSING", "No MPU9250 found at 0x68. Check SDA=GPIO17, SCL=GPIO18, 3V3, GND, AD0=GND.");
  }
  lastImuMicros = micros();
  sendHello();
}

// ---------- loop ----------
void loop() {
  const uint32_t now = millis();
  pollSerial();

  // pot and FSR
  if (now - lastInput >= INPUT_MS) {
    lastInput = now;
    potRaw = analogRead(PIN_POT);
    fsrRaw = readFsr();
    const int slot = pot.update(potRaw);
    if (fsr.update(fsrRaw, now)) sendAction(slot);
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

  if (now - lastDisplay >= DISPLAY_MS) {
    lastDisplay = now;
    updateDisplay();
  }

  if (now - lastHb >= HEARTBEAT_MS) {
    lastHb = now;
    Serial.printf("{\"v\":1,\"type\":\"hb\",\"t\":%lu,\"seq\":%lu}\n", (unsigned long)now, (unsigned long)seqNo);
  }

  if (ledOffAt && (int32_t)(now - ledOffAt) >= 0) { led(0, 0, 0, 0); ledOffAt = 0; }
}
