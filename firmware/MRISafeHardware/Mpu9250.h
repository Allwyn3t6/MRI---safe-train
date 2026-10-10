// Mpu9250.h — minimal register-level driver for MPU9250 / MPU9255 / MPU6500 over I2C
//
// No external library needed. Accelerometer ±4 g, gyroscope ±500 dps, 200 Hz with a
// 41 Hz digital low-pass filter. The AK8963 magnetometer inside the MPU9250 is reached
// through I2C bypass mode at address 0x0C (16-bit output, 100 Hz continuous).
//
// Note: many boards sold as "MPU9250" actually carry an MPU6500, which has no
// magnetometer. begin() reports what it found; the wand meter is disabled without one.
#pragma once
#include <Arduino.h>
#include <Wire.h>

class Mpu9250 {
 public:
  enum Kind : uint8_t { NONE = 0, MPU6500 = 0x70, MPU9250 = 0x71, MPU9255 = 0x73 };

  // Returns the detected chip (WHO_AM_I), or NONE.
  Kind begin(TwoWire& w, uint8_t addr = 0x68) {
    w_ = &w; addr_ = addr;
    const uint8_t who = read8(addr_, 0x75);
    if (who != MPU6500 && who != MPU9250 && who != MPU9255) { kind_ = NONE; return NONE; }
    kind_ = (Kind)who;
    write8(addr_, 0x6B, 0x80); delay(100);   // reset
    write8(addr_, 0x6B, 0x01); delay(20);    // wake, PLL clock
    write8(addr_, 0x6C, 0x00);               // all sensors on
    write8(addr_, 0x1A, 0x03);               // gyro DLPF 41 Hz
    write8(addr_, 0x19, 0x04);               // sample rate 1 kHz / (1+4) = 200 Hz
    write8(addr_, 0x1B, 0x08);               // gyro ±500 dps
    write8(addr_, 0x1C, 0x08);               // accel ±4 g
    write8(addr_, 0x1D, 0x03);               // accel DLPF 41 Hz
    write8(addr_, 0x37, 0x02);               // I2C bypass on → AK8963 visible at 0x0C
    delay(10);
    hasMag_ = initMag();
    return kind_;
  }

  bool hasMag() const { return hasMag_; }
  Kind kind() const { return kind_; }
  const char* name() const {
    switch (kind_) { case MPU9250: return "MPU9250"; case MPU9255: return "MPU9255"; case MPU6500: return "MPU6500"; default: return "none"; }
  }

  // Average gyro readings while still; call at boot and on "imu_zero".
  void calibrateGyro(int samples = 200) {
    float s[3] = {0, 0, 0}, a[3], g[3];
    for (int i = 0; i < samples; i++) { readRaw(a, g); for (int k = 0; k < 3; k++) s[k] += g[k]; delay(3); }
    for (int k = 0; k < 3; k++) gBias_[k] = s[k] / samples;
  }

  // Accelerometer in g, gyroscope in deg/s (bias removed). Returns false on I2C error.
  bool read(float a[3], float g[3]) {
    if (!readRaw(a, g)) return false;
    for (int k = 0; k < 3; k++) g[k] -= gBias_[k];
    return true;
  }

  // Magnetic field in microtesla (chip axes). Returns true only when a fresh sample was read.
  bool readMag(float m[3]) {
    if (!hasMag_) return false;
    if (!(read8(0x0C, 0x02) & 0x01)) return false;          // ST1.DRDY
    uint8_t b[7];
    if (!readN(0x0C, 0x03, b, 7)) return false;               // HXL..HZH + ST2
    if (b[6] & 0x08) return false;                            // magnetic overflow
    for (int k = 0; k < 3; k++) {
      const int16_t v = (int16_t)((b[2 * k + 1] << 8) | b[2 * k]);   // little-endian
      m[k] = v * 0.15f * asa_[k];                                     // 0.15 µT/LSB at 16-bit
    }
    return true;
  }

 private:
  bool initMag() {
    if (read8(0x0C, 0x00) != 0x48) return false;  // AK8963 WIA
    write8(0x0C, 0x0A, 0x00); delay(10);           // power down
    write8(0x0C, 0x0A, 0x0F); delay(10);           // fuse ROM access
    uint8_t asa[3];
    if (!readN(0x0C, 0x10, asa, 3)) return false;
    for (int k = 0; k < 3; k++) asa_[k] = ((float)asa[k] - 128.0f) / 256.0f + 1.0f;
    write8(0x0C, 0x0A, 0x00); delay(10);
    write8(0x0C, 0x0A, 0x16); delay(10);           // 16-bit, continuous mode 2 (100 Hz)
    return true;
  }

  bool readRaw(float a[3], float g[3]) {
    uint8_t b[14];
    if (!readN(addr_, 0x3B, b, 14)) return false;
    for (int k = 0; k < 3; k++) {
      a[k] = (int16_t)((b[2 * k] << 8) | b[2 * k + 1]) / 8192.0f;      // ±4 g
      g[k] = (int16_t)((b[8 + 2 * k] << 8) | b[9 + 2 * k]) / 65.5f;    // ±500 dps
    }
    return true;
  }

  void write8(uint8_t dev, uint8_t reg, uint8_t v) { w_->beginTransmission(dev); w_->write(reg); w_->write(v); w_->endTransmission(); }
  uint8_t read8(uint8_t dev, uint8_t reg) { uint8_t v = 0; readN(dev, reg, &v, 1); return v; }
  bool readN(uint8_t dev, uint8_t reg, uint8_t* buf, uint8_t n) {
    w_->beginTransmission(dev); w_->write(reg);
    if (w_->endTransmission(false) != 0) return false;
    if (w_->requestFrom((int)dev, (int)n) != n) return false;
    for (uint8_t i = 0; i < n; i++) buf[i] = w_->read();
    return true;
  }

  TwoWire* w_ = nullptr;
  uint8_t addr_ = 0x68;
  Kind kind_ = NONE;
  bool hasMag_ = false;
  float gBias_[3] = {0, 0, 0};
  float asa_[3] = {1, 1, 1};
};
