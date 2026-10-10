# MRISafe hardware controller (v2)

Your parts: ESP32-S3, one programmable LED, a potentiometer, an FSR (force-sensitive resistor),
an MPU9250, and a 1.8" SPI TFT (128×160, ST7735).

| Part | What it does |
|---|---|
| Potentiometer | Turn to pick the checkpoint T1…T6. The display shows which one is armed. |
| FSR | Squeeze once to send the armed checkpoint to the app. One squeeze = one action. |
| MPU9250 | Tilt to orbit or point the view. Tap, double-tap and flick do the same as in the app. |
| Programmable LED | Colour feedback: cyan = action sent, green = app received it, magenta = gesture, red = error. |
| TFT | Armed checkpoint, last sent, tilt, live pot and FSR readings, status messages. |

The serial protocol is the same as the touch-pad firmware (`docs/protocol.md`), so the app works unchanged.

## Wiring

| Signal | ESP32-S3 pin | Notes |
|---|---|---|
| Pot wiper | GPIO 1 | Pot ends to 3V3 and GND |
| FSR | GPIO 2 | Voltage divider: FSR from 3V3 to GPIO 2, 10 kΩ from GPIO 2 to GND |
| MPU9250 SDA | GPIO 17 | |
| MPU9250 SCL | GPIO 18 | |
| MPU9250 VCC / GND / AD0 | 3V3 / GND / GND | AD0 to GND gives address 0x68 |
| TFT SCL (SCK) | GPIO 12 | |
| TFT SDA (MOSI) | GPIO 11 | |
| TFT CS | GPIO 10 | |
| TFT DC (A0) | GPIO 9 | |
| TFT RST | GPIO 8 | |
| TFT BL (LED) | GPIO 7 | Wire the backlight to 3V3 if this board also carries the touch pads, since T4 uses GPIO 7 there |
| TFT VCC / GND | 3V3 / GND | Use 3.3 V. Most 1.8" modules are 3.3 V logic, not 5 V. |
| Programmable LED data | GPIO 48 | Onboard WS2812 on most S3 dev boards. For an external one, change `PIN_STATUS_LED`. |

Pot and FSR are read by ADC1 (GPIO 1 and 2). ADC2 is avoided on purpose.
Do not use GPIO 0, 3, 45 or 46 (strapping pins), or 19 and 20 (USB).

Expect the FSR's divider to read LOW when it is not pressed and HIGH when it is. If the
readings go the other way, set `FSR_INVERTED = true`.

## Libraries and board

1. Arduino IDE → Library Manager, install:
   * **Adafruit ST7735 and ST7789 Library** (installs with its dependency, Adafruit GFX Library)
   * Accept the prompt to install dependencies.
2. Board: **esp32 by Espressif** (2.0.x or 3.x), board **ESP32S3 Dev Module**.
3. Native USB port → **USB CDC On Boot: Enabled**.
4. Open `MRISafeHardware.ino` (all the .h files must stay in the same folder), select the port, upload.

## First run

1. Keep the **FSR untouched** for about a second after reset. The screen says "Hands off the FSR".
2. Then place the board flat and still. The screen says "Level: keep still" for about 1 s. Leave it alone.
3. The screen reads "HOST ON" once the app talks to it. Until then it reads "WAIT".
4. In the app: controller chip (top right) → **Connect**, pick the port, then **Level the controller**.
5. Turn the pot until the checkpoint you want is shown, then squeeze the FSR.

Check that each thing works in this order:
1. Pot: the selected box on the bar changes smoothly. A value of `pot 0` should be fully CCW.
2. FSR: `fsr` stays near the rest value (roughly 0 to 100). It climbs when squeezed. Tune `FSR_PRESS_DELTA` if a light squeeze does nothing, or a touch of the board fires it.
3. IMU: `roll` and `pitch` read near 0 when the board is flat, and move when you tilt it.
4. Send: one squeeze gives one "sent Tn #k" line and one action in the app.

## Tuning (top of the .ino)

| Constant | Default | Change when |
|---|---|---|
| `FSR_PRESS_DELTA` | 350 | Light squeezes don't register (lower it) or the board fires on bumps (raise it) |
| `FSR_RELEASE_DELTA` | 200 | Keep below `FSR_PRESS_DELTA`. Lower it for a longer hold before the next press. |
| `FSR_REFRACTORY_MS` | 120 | Double-fires on a squeeze (raise it) |
| `POT_HYSTERESIS` | 40 | The selection jitters at a boundary (raise it) |
| `POT_REVERSED` | false | Turning clockwise moves the selection the wrong way |
| `FSR_INVERTED` | false | The FSR reads lower when squeezed |
| `AX_SIGN` … `GZ_SIGN` | 1 | Tilt direction is reversed in the app |

## Testing

```bash
g++ -std=c++17 -I firmware/MRISafeHardware firmware/tests/test_inputs.cpp -o ti && ./ti
```

The pot and FSR logic has 17 host tests, all passing. The sketch has been compiled against
stub Arduino and display headers, but **not** against the real libraries on a board. The first real
upload is where any remaining problems will appear. Record the result in `docs/test-matrix.md`.

## Troubleshooting

* **Blank or garbled screen**: check the wiring, especially DC, RST and CS. If colours are wrong (red and blue swapped, or a rainbow), change `INITR_BLACKTAB` to `INITR_GREENTAB` or `INITR_REDTAB`.
* **"MPU9250 not found"**: check SDA = GPIO 17, SCL = GPIO 18, AD0 to GND. A board with no magnetometer reports `MPU6500`, which is fine; only the wand meter is disabled.
* **LED stays dark**: the programmable LED is not on GPIO 48. Look for the pin in your board's schematic and set `PIN_STATUS_LED`.
* **Upload fails**: hold BOOT, tap RESET, then release BOOT. Or check that USB CDC On Boot is enabled.
