# Posture Flower

Real-time sitting-posture tracking from a laptop's front webcam (MediaPipe Pose Landmarker, heavy),
rendered as a 3D visual (three.js) that mirrors your body: a flower or a jello blob. The same picture can stream to a small
ESP32-S3 LCD.

![The app running on a test photo, with the jello blob selected](docs/app.jpg)

| Flower | Jello blob |
|---|---|
| ![Flower in six posture states](docs/flower-states.jpg) | ![Jello blob in six posture states](docs/blob-states.jpg) |

Both grids show the same six states: upright, slumped, forward head, leaning right, shoulders shrugged, and poor posture for minutes.

## Run

No build step: three.js and MediaPipe load from a CDN. Serve the folder and open it in Chrome:

```bash
python3 -m http.server 8785
```

Open http://localhost:8785, press **Start camera**, sit tall, and press **Calibrate**.
Camera frames stay in the browser. The MediaPipe library does send usage metrics to Google (see its README).

Pick **Flower** or **Jello blob** from the **Visual** dropdown; the LCD follows the choice, and it's remembered.

URL options: `?visual=flower|blob`, `?model=heavy|full|lite`, `?hz=15` (inference rate), `?tau=45` (seconds for flower health to respond),
`?src=front-man&autocal=1` (run on a test photo instead of the webcam).
`bench.html` benchmarks the three models on the test photos.

## Layout

| file | role |
|---|---|
| `src/pose.js` | PoseLandmarker wrapper (VIDEO mode, GPU delegate) |
| `src/posture.js` | landmarks → frontal features → One Euro filter → calibrated severities |
| `src/visuals.js` | registry of visuals for the **Visual** dropdown; only the selected one is loaded |
| `src/flower.js` | procedural flower; springs on every parameter |
| `src/blob.js` | raymarched jello blob (same `setTarget` contract); main view capped at 0.3 MP to keep it fast |
| `blob-prototype/` | side-by-side flower vs. blob comparison page with presets and a state gallery |
| `src/lcd.js` | renders the selected visual's 320×240 view and streams it to the ESP32 LCD over Web Serial |
| `src/main.js` | camera, calibration, inference timer, UI |
| `esp32/FlowerStream/` | Arduino sketch for the ESP32-S3 + ST7789 LCD |
| `esp32/lcd_test.py` | sends JPEG files to the board and reports frame rate (needs pyserial) |

## ESP32-S3 LCD

The computer does all the tracking and 3D rendering; the board only decodes and displays.
Each frame is a ~3–6 KB JPEG sent over the USB cable. On an ESP32-S3 N16R8 + Waveshare 2" ST7789 it runs at
~28 fps for the flower and ~32 fps for the blob (decode + draw 20–22 ms per frame); the page sends 20 fps. When the stream stops, the last frame stays on screen;
at power-on the screen shows "waiting for Posture Flower" until the first frame arrives.

1. Wire the LCD: DIN→GPIO11, CLK→GPIO12, CS→GPIO10, DC→GPIO9, RST→GPIO8, VCC→3V3, GND→GND, BL→3V3.
2. Install the **LovyanGFX** and **JPEGDEC** libraries.
3. Open `esp32/FlowerStream/FlowerStream.ino`. Board: *ESP32S3 Dev Module*, USB CDC On Boot: *Enabled*,
   Flash Size: *16MB*, Partition Scheme: *16M Flash (3MB APP/9.9MB FATFS)*, PSRAM: *OPI PSRAM*. Upload.
4. In Chrome or Edge, press **Connect LCD** and pick the "USB JTAG/serial debug unit" port.
   Close the Arduino Serial Monitor first; only one program can hold the port.

Command-line equivalent of step 3:

```bash
arduino-cli compile --upload -p /dev/cu.usbmodem14201 -b "esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi" esp32/FlowerStream
```

The SPI clock is 80 MHz. If the image shows noise or wrong colours, set `SPI_HZ` to 40 MHz in the sketch.
`?lcdfps=20` sets the stream rate.

## Body → visual

| posture dimension | frontal-camera signal | flower | jello blob |
|---|---|---|---|
| Trunk slump / recline (spine ⟂ thighs) | shoulders sink + get nearer the camera | stem bends forward/back as a C-curve | curls into a bean and turns indigo / arches back and turns sky blue |
| Ear–shoulder–hip stack | hips aren't visible, so inferred from head + trunk | (combined) | (combined) |
| Side balance (weight) | shoulder-line tilt + sideways shift | stem leans, pot tips | jelly pools to one side and tips over, turns lemon |
| Forward head | ear-above-shoulder height ÷ shoulder width shrinks; head grows relative to shoulders; 3D ear-vs-shoulder depth | top of stem nods, bloom droops; head roll tilts the bloom | top lobe swells and droops, turns amber; head roll tilts the face |
| Shoulders protracted / raised | 3D shoulder span narrows; shoulders rise relative to ears | leaves swing forward / lift and tremble | droplets stretch out in front / drift up off the top, turns pink |
| Sustained posture (45 s average) | — | petals open and pink → closed, brown, drooping | floating and smiling → sinks, sags, goes dull, frowns |

Severities are relative to your calibration, not absolute angles; [docs/METRICS.md](docs/METRICS.md) explains each one.
Thresholds are in `TOLERANCE` in `src/posture.js`.

Test photos in `test-images/` (including the one in the screenshot above) are from Wikimedia Commons;
see [test-images/CREDITS.md](test-images/CREDITS.md).

## README images

`docs/shots.html?visual=flower` and `?visual=blob` draw the state grids. With the server running:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1200,680 --virtual-time-budget=30000 --screenshot=blob-states.png "http://localhost:8785/docs/shots.html?visual=blob"
```
