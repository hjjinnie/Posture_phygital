// Posture LCD: shows JPEG frames streamed from the browser over USB. When the stream stops,
// the last frame stays on screen; before the first frame it shows "loading...".
//
// Hardware: ESP32-S3 N16R8 + Waveshare 2-inch ST7789 (320x240 landscape).
// Wiring: DIN=GPIO11, CLK=GPIO12, CS=GPIO10, DC=GPIO9, RST=GPIO8, VCC=3V3, GND=GND, BL=3V3.
// Board settings: ESP32S3 Dev Module, USB CDC On Boot: Enabled, Flash Size: 16MB,
//                 Partition Scheme: 16M Flash (3MB APP/9.9MB FATFS), PSRAM: OPI PSRAM.
// Libraries: LovyanGFX (lovyan03), JPEGDEC (Larry Bank). LovyanGFX sends pixels by DMA while the
// next block decodes; the Adafruit driver pushed them through the CPU at ~25 Mbit/s whatever the clock.
//
// Protocol, host -> board: "FLWR" + uint32 little-endian length + baseline JPEG (up to 320x240).
// Reply, board -> host, as soon as a frame's bytes are in: "OK" + status byte + uint16 total ms
// + uint16 ms spent waiting on the LCD (both little-endian, for the previous frame). The host waits for the reply
// before sending the next frame, so the next transfer overlaps this frame's decode and draw.

#include <Arduino.h>
#include <LovyanGFX.hpp>
#include <JPEGDEC.h>

#define TFT_MOSI 11
#define TFT_SCLK 12
#define TFT_CS   10
#define TFT_DC    9
#define TFT_RST   8

// These are the S3's direct (IOMUX) SPI pins, so 80 MHz often works; drop to 40 MHz if the image glitches.
static constexpr uint32_t SPI_HZ = 80000000;
static constexpr int LCD_W = 320, LCD_H = 240;
static constexpr uint32_t MAX_JPEG = 64 * 1024;

enum Status : uint8_t { FRAME_OK = 0, TOO_BIG = 1, SHORT_READ = 2, BAD_JPEG = 3 };

class LGFX : public lgfx::LGFX_Device {
  lgfx::Panel_ST7789 panel;
  lgfx::Bus_SPI bus;

 public:
  LGFX() {
    auto b = bus.config();
    b.spi_host = SPI2_HOST;
    b.spi_mode = 0;
    b.freq_write = SPI_HZ;
    b.pin_sclk = TFT_SCLK;
    b.pin_mosi = TFT_MOSI;
    b.pin_miso = -1;
    b.pin_dc = TFT_DC;
    b.dma_channel = SPI_DMA_CH_AUTO;
    bus.config(b);
    panel.setBus(&bus);

    auto p = panel.config();
    p.pin_cs = TFT_CS;
    p.pin_rst = TFT_RST;
    p.panel_width = 240;
    p.panel_height = 320;
    p.invert = true;       // this panel needs inversion on (as the Adafruit driver did)
    p.readable = false;    // MISO isn't wired
    panel.config(p);
    setPanel(&panel);
  }
};

LGFX tft;
JPEGDEC jpeg;
static uint8_t* jpegBuf;

// ---------- streamed JPEG frames ----------

static uint32_t drawUs;  // time spent pushing pixels to the LCD during the current frame

// JPEGDEC hands over pixels already byte-swapped for the panel; DMA sends them while it decodes the
// next block into its other buffer (JPEG_USES_DMA), so only waiting on a previous transfer costs time.
static int drawBlock(JPEGDRAW* d) {
  const uint32_t t = micros();
  tft.pushImageDMA(d->x, d->y, d->iWidth, d->iHeight, (lgfx::swap565_t*)d->pPixels);
  drawUs += micros() - t;
  return 1;
}

// Scans incoming bytes for the "FLWR" marker; resynchronises by itself after any garbage.
static bool readHeader(uint32_t& len) {
  static uint32_t window = 0;
  while (Serial.available()) {
    window = (window << 8) | (uint8_t)Serial.read();
    if (window == 0x464C5752) {  // 'F' 'L' 'W' 'R'
      window = 0;
      uint8_t b[4];
      if (Serial.readBytes(b, 4) != 4) return false;
      len = b[0] | (b[1] << 8) | (b[2] << 16) | ((uint32_t)b[3] << 24);
      return true;
    }
  }
  return false;
}

static void reply(Status status, uint16_t totalMs = 0, uint16_t drawMs = 0) {
  const uint8_t r[7] = {'O', 'K', status, (uint8_t)totalMs, (uint8_t)(totalMs >> 8), (uint8_t)drawMs, (uint8_t)(drawMs >> 8)};
  Serial.write(r, sizeof r);
}

static Status lastStatus = FRAME_OK;
static uint16_t lastTotalMs = 0, lastDrawMs = 0;

static void showStreamedFrame(uint32_t len) {
  if (len == 0 || len > MAX_JPEG) return reply(TOO_BIG);
  if (Serial.readBytes(jpegBuf, len) != len) return reply(SHORT_READ);
  // Release the host now: the next frame streams into the USB buffer while this one draws.
  reply(lastStatus, lastTotalMs, lastDrawMs);

  const uint32_t t0 = micros();
  drawUs = 0;
  bool ok = jpeg.openRAM(jpegBuf, len, drawBlock);
  if (ok) {
    jpeg.setPixelType(RGB565_BIG_ENDIAN);
    const int x = max(0, (LCD_W - jpeg.getWidth()) / 2), y = max(0, (LCD_H - jpeg.getHeight()) / 2);
    tft.startWrite();
    ok = jpeg.decode(x, y, JPEG_USES_DMA);
    tft.waitDMA();
    tft.endWrite();
    jpeg.close();
  }
  lastStatus = ok ? FRAME_OK : BAD_JPEG;
  lastTotalMs = (micros() - t0) / 1000;
  lastDrawMs = drawUs / 1000;
}

// ---------- main ----------

void setup() {
  Serial.setRxBufferSize(32 * 1024);  // must precede begin(); holds a whole frame while we draw
  Serial.begin(921600);               // native USB ignores the baud rate
  Serial.setTimeout(250);
  jpegBuf = (uint8_t*)heap_caps_malloc(MAX_JPEG, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);

  tft.init();
  tft.initDMA();
  tft.setRotation(1);  // landscape, 320 wide x 240 high
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(0x4208);  // dim grey
  tft.setTextDatum(lgfx::middle_center);
  tft.drawString("loading...", LCD_W / 2, LCD_H / 2);
}

void loop() {
  uint32_t len;
  if (readHeader(len)) showStreamedFrame(len);
}
