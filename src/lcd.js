// Streams the current visual to the ESP32-S3 LCD (esp32/FlowerStream) over USB with Web Serial (Chrome/Edge).
// A second, small renderer draws the visual's 320x240 LCD view; each frame goes out as
// "FLWR" + uint32 LE length + JPEG, and the board answers "OK" + status + uint16 total ms + uint16 LCD-wait ms
// once it has the bytes, which is the signal to send the next frame.
import * as THREE from "three";

const W = 320, H = 240;
const ESPRESSIF_USB_VID = 0x303a;

export class LcdLink {
  constructor({ fps = 20, quality = 0.8 } = {}) {
    this.visual = null;   // set by the app; anything with renderLcd(renderer)
    this.fps = fps;
    this.quality = quality;
    this.canvas = document.createElement("canvas");
    this.canvas.width = W; this.canvas.height = H;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    r.setPixelRatio(1);
    r.setSize(W, H, false);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;

    this.port = this.writer = null;
    this.ready = false;
    this.lastSend = 0;
    this.sent = 0;
    this.stats = { fps: 0, kb: 0, boardMs: 0, lcdMs: 0, errors: 0 };
    this.onchange = () => {};
  }

  get supported() { return "serial" in navigator; }
  get connected() { return !!this.writer; }

  async connect() {
    this.port = await navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_USB_VID }] });
    await this.port.open({ baudRate: 921600, bufferSize: 65536 }); // native USB ignores the baud rate
    this.writer = this.port.writable.getWriter();
    this.ready = true;
    this.#readReplies();
    this.onchange();
  }

  async disconnect() {
    const port = this.port;
    this.port = null;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    this.writer = null;
    try { await port?.close(); } catch {}
    this.onchange();
  }

  async #readReplies() {
    const reader = this.reader = this.port.readable.getReader();
    let prev = 0, need = 0, buf = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const b of value) {
          if (need) {
            buf.push(b);
            if (--need === 0) this.#onReply(buf);
          } else if (prev === 0x4f && b === 0x4b) { // "OK"
            need = 5; buf = [];
          }
          prev = b;
        }
      }
    } catch {
      // Port vanished (unplugged or board reset).
    } finally {
      reader.releaseLock();
      if (this.port) this.disconnect();
    }
  }

  #onReply([status, t0, t1, d0, d1]) {
    if (status) this.stats.errors++;
    this.stats.boardMs = t0 | (t1 << 8);
    this.stats.lcdMs = d0 | (d1 << 8);
    this.ready = true;
  }

  // Call often; renders (and, when connected, sends) a frame once the interval has passed and the board is ready.
  // Unconnected, it still refreshes the preview a few times a second so the framing can be checked.
  async tick(now) {
    if (!this.visual || now - this.lastSend < 1000 / (this.writer ? this.fps : 5)) return;
    if (this.writer && !this.ready && now - this.lastSend < 1000) return; // a lost reply shouldn't stall the stream
    this.ready = false;
    const dt = (now - this.lastSend) / 1000;
    this.lastSend = now;

    this.visual.renderLcd(this.renderer);
    if (!this.writer) return;

    const blob = await new Promise(res => this.canvas.toBlob(res, "image/jpeg", this.quality));
    const jpg = new Uint8Array(await blob.arrayBuffer());
    const packet = new Uint8Array(8 + jpg.length);
    packet.set([0x46, 0x4c, 0x57, 0x52]); // "FLWR"
    new DataView(packet.buffer).setUint32(4, jpg.length, true);
    packet.set(jpg, 8);
    try {
      await this.writer?.write(packet);
    } catch {
      return this.disconnect();
    }
    this.sent++;
    this.stats.kb = jpg.length / 1024;
    this.stats.fps += (1 / Math.max(dt, 1e-3) - this.stats.fps) * 0.1;
  }
}
