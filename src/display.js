// Puts the current visual on an external screen.
// Streamed: a second, small renderer draws the visual's display view (its `lcdCamera`, on black) and a transport
// carries the frames as JPEGs:
//   PiTransport     WebSocket to pi/posture_display.py, which shows them full screen on the Pi's HDMI display.
//   SerialTransport Web Serial (Chrome/Edge) to esp32/PostureBuddy: "FLWR" + uint32 LE length + JPEG,
//                   answered by "OK" + status + uint16 total ms + uint16 LCD-wait ms.
// The Pi and the board acknowledge each frame as soon as it arrives.
// Drawn on the Pi: BleTransport sends only the posture (~30 times a second) and the screen settings over Bluetooth
// (Web Bluetooth, Chrome/Edge) to pi/posture_ble.py, and the Pi draws the visual itself (pi/live.js). No network,
// no addresses; the renderer here only draws the preview.
import * as THREE from "three";

// Framing. Each visual's display camera has a default shot (zoom 1). With zoom "auto" the shot is fitted to the
// visual every frame from its own geometry (visual.screenBounds): as close as maxZoom while the visual is compact,
// widening in the same frame whenever anything would come within the margin of an edge, so nothing is ever cut off.
// maxZoom "visual" means the visual's own screenZoom. A number for zoom gives a fixed shot instead.
export const FLIPS = { none: "Normal", v: "Flip vertical", h: "Flip horizontal", both: "Rotate 180°" };
export const TARGETS = {
  pi: { label: "Raspberry Pi (HDMI)", width: 960, height: 540, fps: 30, quality: 0.85, zoom: "auto", maxZoom: "visual" },
  ble: { label: "Raspberry Pi (Bluetooth)", width: 270, height: 480, fps: 30, zoom: "auto", maxZoom: "visual" },
  esp32: { label: "ESP32 LCD (USB serial)", width: 320, height: 240, fps: 20, quality: 0.8, zoom: "auto", maxZoom: 1 },
};
const FILL = 0.85;     // content stays within 85% of the half-frame: a 7.5% margin to every edge
const IN_TAU = 2.5;    // seconds; moving in again is slow so the shot doesn't pump

// Frames leave the GPU through an asynchronous read (WebGL2 pixel-buffer + fence), so neither the page nor the GPU
// waits: a plain readPixels() or toBlob() blocked for 30-150 ms behind the 3D views and pose model, which held the
// stream to ~10 fps and pulled the main view down. A worker puts the rows the right way up (GL rows are bottom-up),
// applies the screen's orientation (e.g. flipped for a screen projected from above) and brightness, and JPEG-encodes
// (~5 ms at 960x540, a few more with brightness). Brightness b lifts faint and mid tones along 1 - (1 - v)^b: black stays
// black (it's a projected image) and white never clips; b = 1 leaves the picture unchanged.
const ENCODER = `let oc, g, lut = null, lutFor = 1;
onmessage = async ({ data: { px, w, h, seq, quality, flip, bright = 1 } }) => {
  if (!oc || oc.width !== w || oc.height !== h) {
    oc = new OffscreenCanvas(w, h); g = oc.getContext("2d", { alpha: false, willReadFrequently: true });
  }
  const src = new Uint32Array(px), img = new ImageData(w, h), dst = new Uint32Array(img.data.buffer);
  const flipV = flip === "v" || flip === "both", flipH = flip === "h" || flip === "both";
  for (let y = 0; y < h; y++) {
    const from = flipV ? y : h - 1 - y;
    dst.set(src.subarray(from * w, (from + 1) * w), y * w);
    if (flipH) dst.subarray(y * w, (y + 1) * w).reverse();
  }
  if (bright !== 1) {
    if (lutFor !== bright) {
      lut = new Uint8Array(256);
      for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * (1 - Math.pow(1 - v / 255, bright)));
      lutFor = bright;
    }
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  }
  g.putImageData(img, 0, 0);
  postMessage({ seq, jpg: await oc.convertToBlob({ type: "image/jpeg", quality }) });
};`;

export class DisplayLink {
  constructor(target, { host, ...opts } = {}) {
    const t = { ...TARGETS[target], ...opts };
    this.target = target;
    this.fps = t.fps;
    this.quality = t.quality;
    this.zoom = t.zoom;        // "auto", or a fixed number
    this.flip = t.flip ?? "none";   // stream orientation: "none" | "v" | "h" | "both" (rotate 180°)
    this.bright = t.bright ?? 1;    // stream brightness: 1 = unchanged, higher lifts faint and mid tones
    this.maxZoom = t.maxZoom;
    this.half = null;          // current auto-framed vertical half-angle tangent
    this.transport = target === "pi" ? new PiTransport(host) : target === "ble" ? new BleTransport() : new SerialTransport();
    this.state = null;         // Bluetooth: the posture the visual is showing, and its name (set by the app)
    this.visualName = null;
    this.transport.onclose = () => this.onchange();
    this.transport.onsize = (w, h) => this.#fitTo(w, h);
    this.budget = t.width * t.height;   // pixels per frame; the shape follows the screen's when it reports one
    this.visual = null;   // set by the app; anything with an lcdCamera and renderLcd(renderer)

    this.canvas = document.createElement("canvas");
    this.canvas.width = t.width; this.canvas.height = t.height;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    r.setPixelRatio(1);
    r.setSize(t.width, t.height, false);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;

    this.gl = r.getContext();
    this.slots = [];
    this.#allocSlots();

    this.encoder = new Worker(URL.createObjectURL(new Blob([ENCODER], { type: "text/javascript" })));
    this.encoder.onmessage = ({ data }) => this.#send(data.seq, data.jpg);
    this.encoding = 0;

    this.lastFrame = this.lastSent = 0;
    this.seq = this.sentSeq = 0;
    this.stats = { fps: 0, kb: 0, note: "" };
    this.onchange = () => {};
  }

  get supported() { return this.transport.supported; }
  get connected() { return this.transport.connected; }
  async connect() { await this.transport.connect(); this.onchange(); }
  async disconnect() { await this.transport.disconnect(); this.onchange(); }

  dispose() {
    this.transport.disconnect();
    this.encoder.terminate();
    this.#freeSlots();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // Three pixel buffers, so up to three frames can be on their way back from the GPU at once.
  #allocSlots() {
    const gl = this.gl, bytes = this.canvas.width * this.canvas.height * 4;
    this.slots = Array.from({ length: 3 }, () => {
      const pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      return { pbo, fence: null, seq: 0 };
    });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }

  #freeSlots() {
    for (const s of this.slots) { if (s.fence) this.gl.deleteSync(s.fence); this.gl.deleteBuffer(s.pbo); }
    this.slots = [];
  }

  // Match the screen's shape at the same pixel count (e.g. 960x540 → 544x960 for a portrait 1080x1920 screen).
  #fitTo(sw, sh) {
    const w = Math.round(Math.sqrt(this.budget * sw / sh) / 8) * 8, h = Math.round(Math.sqrt(this.budget * sh / sw) / 8) * 8;
    if (w === this.canvas.width && h === this.canvas.height) return;
    this.#freeSlots();
    this.renderer.setSize(w, h, false);
    this.#allocSlots();
    this.onchange();
  }

  // Call often (the app calls it ~30 times a second). Collects finished GPU reads, and once the frame interval has
  // passed and the screen can take more, renders a new frame and starts reading it back.
  // Unconnected, it only refreshes the preview a few times a second so the framing can be checked.
  tick(now) {
    if (!this.visual) return;
    const tr = this.transport, live = tr.connected;
    if (tr.sendsState) return this.#tickState(now);
    if (live) this.#collect();
    if (now - this.lastFrame < 1000 / (live ? this.fps : 5) - 8) return;  // 8 ms slack for timer jitter
    const slot = this.slots.find(s => !s.fence);
    const busy = this.slots.filter(s => s.fence).length + this.encoding;
    if (live && (!slot || busy >= tr.maxInflight || !tr.canSend(now))) return;
    this.#draw(now);
    if (!live) return;

    const gl = this.gl;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    slot.seq = ++this.seq;
    gl.flush();
  }

  // Draws the visual's display view into this.canvas (the stream's frame, or just the preview).
  #draw(now) {
    const dt = Math.min((now - this.lastFrame) / 1000, 1);
    this.lastFrame = now;
    const cam = this.visual.lcdCamera, aspect = this.canvas.width / this.canvas.height;
    const half = this.#frame(cam, aspect, dt);
    const fov = 2 * Math.atan(half) * 180 / Math.PI;
    if (cam.aspect !== aspect || cam.fov !== fov) { cam.aspect = aspect; cam.fov = fov; cam.updateProjectionMatrix(); }
    this.visual.renderLcd(this.renderer);
  }

  // Bluetooth: send the posture at this.fps (and the settings whenever they change); the Pi draws the visual.
  // The preview here refreshes a few times a second.
  #tickState(now) {
    const tr = this.transport;
    if (tr.connected && this.state && now - this.lastSent >= 1000 / this.fps - 8
        && tr.sendState(stateBytes(this.state), configBytes(this.visualName, this.flip, this.bright))) {
      if (this.lastSent) this.stats.fps += (1000 / Math.max(now - this.lastSent, 1) - this.stats.fps) * 0.1;
      this.lastSent = now;
    }
    this.stats.note = tr.note;
    if (now - this.lastFrame >= 200) this.#draw(now);
  }

  // Returns the vertical half-angle tangent for this frame's camera.
  // A visual's default shot is framed for 4:3: wider screens keep its height, taller ones keep its width.
  #frame(cam, aspect, dt) {
    const base = Math.tan((cam.userData.baseFov ??= cam.fov) * Math.PI / 360) * (aspect >= 4 / 3 ? 1 : (4 / 3) / aspect);
    if (this.zoom !== "auto" || !this.visual.screenBounds) return base / (this.zoom === "auto" ? 1 : this.zoom);
    if (this.visual !== this.framed) { this.framed = this.visual; this.half = null; }   // new visual: fit afresh
    cam.updateMatrixWorld();
    const b = this.visual.screenBounds(cam);   // half-angle tangents that everything visible spans, across and up
    const maxZoom = this.maxZoom === "visual" ? (this.visual.screenZoom ?? 1) : this.maxZoom;
    const target = Math.max(base / maxZoom, Math.max(b.y, b.x / aspect) / FILL);
    if (this.half == null || target > this.half) this.half = target;   // widen at once: nothing may leave the frame
    else this.half += (target - this.half) * (1 - Math.exp(-dt / IN_TAU));
    return this.half;
  }

  #collect() {
    const gl = this.gl, { width: w, height: h } = this.canvas;
    for (const s of this.slots.filter(s => s.fence).sort((a, b) => a.seq - b.seq)) {
      if (gl.getSyncParameter(s.fence, gl.SYNC_STATUS) !== gl.SIGNALED) break;   // keep frames in order
      gl.deleteSync(s.fence);
      s.fence = null;
      const px = new Uint8Array(w * h * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.encoding++;
      this.encoder.postMessage({ px: px.buffer, w, h, seq: s.seq, quality: this.quality, flip: this.flip, bright: this.bright }, [px.buffer]);
    }
  }

  async #send(seq, jpg) {
    this.encoding--;
    const tr = this.transport;
    if (seq < this.sentSeq || !tr.connected) return;
    this.sentSeq = seq;
    const now = performance.now();
    if (!(await tr.send(jpg, now))) return this.disconnect();
    if (this.lastSent) this.stats.fps += (1000 / Math.max(now - this.lastSent, 1) - this.stats.fps) * 0.1;
    this.lastSent = now;
    this.stats.kb = jpg.size / 1024;
    this.stats.note = tr.note;
  }
}

// ---- Raspberry Pi: WebSocket over the USB-gadget network link (or Wi-Fi) ----
export const PI_PORT = 8790;

// From the hosted (https) site, Chrome and Edge let the page reach the Pi's plain ws:// address once the person allows
// the site "local network access" (Chrome asks the first time). Firefox and Safari refuse outright. The local app
// (http://localhost) needs no permission.
const LNA_NAMES = ["local-network", "local-network-access"];   // Chrome 14x+ name first, then the earlier single one
async function localNetworkPermission() {
  if (!window.isSecureContext || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return "not needed";
  for (const name of LNA_NAMES) {
    try { return (await navigator.permissions.query({ name })).state; } catch {}
  }
  return "unknown";
}
export const LNA_HELP = "Chrome is blocking this site from the Pi: click the icon left of the address bar, " +
  "set Local network access to Allow, reload, then press Connect again";

class PiTransport {
  constructor(host = "10.12.194.1") {
    this.host = host; this.ws = null; this.size = null; this.note = "";
    this.onclose = this.onsize = () => {};
    this.onwait = () => {};   // called with a message while the browser is asking the person for permission
  }
  get supported() { return true; }
  get connected() { return this.ws?.readyState === WebSocket.OPEN; }
  get maxInflight() { return 3; }
  canSend() { return this.ws.bufferedAmount < 256 * 1024; }   // back off if the link falls behind

  async connect() {
    const before = await localNetworkPermission();
    if (before === "denied") throw new Error(LNA_HELP);
    // While Chrome's permission prompt is open the connection waits on the person, so give them time to answer.
    if (before === "prompt") this.onwait("Chrome is asking to let this site reach devices on your local network (the Pi): click Allow");
    const waitMs = before === "prompt" ? 60000 : 5000;
    let ws;
    try { ws = new WebSocket(`ws://${this.host}:${PI_PORT}/source`); }
    catch (e) {   // Firefox and Safari: a secure page may not open a plain ws:// connection at all
      throw new Error(`this browser won't let the website reach the Pi (${e.name}). Use Chrome or Edge, or the local app`);
    }
    return new Promise((resolve, reject) => {
      const fail = async () => {
        clearTimeout(timer); ws.onerror = ws.onopen = null; ws.close();
        const after = await localNetworkPermission();
        reject(new Error(after === "denied" ? LNA_HELP
          : `can't reach the Pi at ${this.host}:${PI_PORT}. Is the Pi's USB-C cable plugged into this computer, and has the Pi finished starting?`));
      };
      const timer = setTimeout(fail, waitMs);
      ws.onerror = fail;
      ws.onopen = () => {
        clearTimeout(timer);
        ws.onerror = null;
        this.ws = ws;
        ws.onmessage = e => {
          const s = JSON.parse(e.data);
          if (s.width && s.height && (s.width !== this.size?.[0] || s.height !== this.size?.[1])) {
            this.size = [s.width, s.height];
            this.onsize(s.width, s.height);
          }
          this.note = s.screens ? `Pi screen ${s.fps.toFixed(0)} fps, draw ${s.drawMs.toFixed(0)} ms` : "Pi screen page not open";
        };
        ws.onclose = () => { this.ws = null; this.onclose(); };
        resolve();
      };
    });
  }

  async disconnect() { const ws = this.ws; this.ws = null; ws?.close(); }

  async send(jpg) {
    if (!this.connected) return false;
    this.ws.send(jpg);
    return true;
  }
}

// ---- Raspberry Pi over Bluetooth LE: posture and settings only; the Pi draws the visual (pi/posture_ble.py, pi/live.js) ----
const BLE = {
  service: "8f6a0001-5c1e-4f0a-9b8e-7f2a3c4d5e60",
  state: "8f6a0002-5c1e-4f0a-9b8e-7f2a3c4d5e60",    // 20 bytes, write without response
  config: "8f6a0003-5c1e-4f0a-9b8e-7f2a3c4d5e60",   // 4 bytes, write
  status: "8f6a0004-5c1e-4f0a-9b8e-7f2a3c4d5e60",   // 6 bytes, notify: fps, width, height, screens
};
// The settings message carries indexes into these; pi/live.js has the same lists.
export const BLE_VISUALS = ["ema-liquid", "ema-contour", "ema-dandelion", "ema-branching", "blob"];
export const BLE_FLIPS = ["none", "v", "h", "both"];
const MILLI = ["trunk", "lateral", "head", "protraction", "elevL", "elevR", "wellbeing", "confidence"];   // x1000
const CENTI = ["headRoll", "shoulderTilt"];   // degrees x100

// 20 bytes (fits a default Bluetooth packet): the ten posture values as int16 LE.
function stateBytes(s) {
  const v = new DataView(new ArrayBuffer(20)), i16 = x => Math.max(-32768, Math.min(32767, Math.round(x || 0)));
  MILLI.forEach((k, i) => v.setInt16(i * 2, i16(s[k] * 1000), true));
  CENTI.forEach((k, i) => v.setInt16(16 + i * 2, i16(s[k] * 100), true));
  return v.buffer;
}
const configBytes = (name, flip, bright) => new Uint8Array([Math.max(0, BLE_VISUALS.indexOf(name)),
  Math.max(0, BLE_FLIPS.indexOf(flip)), Math.round(Math.min(Math.max(bright, 1), 25) * 10), 0]);

let bleDevice = null;   // the Pi chosen in Chrome's Bluetooth chooser; reconnecting in this page needs no chooser

class BleTransport {
  constructor() { this.chars = null; this.busy = false; this.sentConfig = null; this.wanted = false; this.note = ""; this.onclose = () => {}; }
  get supported() { return !!navigator.bluetooth; }
  get sendsState() { return true; }
  get connected() { return !!this.chars && !!bleDevice?.gatt.connected; }

  async connect() {
    if (!navigator.bluetooth) throw new Error("this browser can't use Bluetooth from a website. Use Chrome or Edge");
    bleDevice ??= await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE.service] }, { namePrefix: "Posture" }], optionalServices: [BLE.service] });
    bleDevice.ongattserverdisconnected = () => this.#dropped();
    this.wanted = true;
    const server = await bleDevice.gatt.connect();
    const svc = await server.getPrimaryService(BLE.service);
    const state = await svc.getCharacteristic(BLE.state), config = await svc.getCharacteristic(BLE.config);
    const status = await svc.getCharacteristic(BLE.status);
    this.chars = { state, config, status };
    this.sentConfig = null;
    this.note = "connected";
    try {
      status.addEventListener("characteristicvaluechanged", e => this.#status(e.target.value));
      await status.startNotifications();
    } catch {}
  }

  #status(v) {
    if (v.byteLength < 6) return;
    const fps = v.getUint8(0), w = v.getUint16(1, true), h = v.getUint16(3, true), screens = v.getUint8(5);
    this.note = screens ? `Pi drawing ${fps} fps at ${w}×${h}` : "Pi screen page not open";
  }

  // Out of range or the Pi restarted: keep trying every few seconds until it's back or Disconnect is pressed.
  #dropped() {
    if (!this.chars && !this.wanted) return;
    this.chars = null;
    this.note = "reconnecting…";
    this.onclose();
    const retry = () => this.wanted && !this.connected && this.connect().then(() => this.onclose(), () => setTimeout(retry, 3000));
    setTimeout(retry, 2000);
  }

  async disconnect() {
    const had = this.chars || this.wanted;
    this.wanted = false;
    this.chars = null;
    if (bleDevice?.gatt.connected) bleDevice.gatt.disconnect();
    if (had) this.onclose();
  }

  // One Bluetooth operation at a time (overlapping ones are rejected): the settings first whenever they've changed,
  // otherwise the posture. Returns false if the link is still busy with the last one.
  sendState(state, config) {
    if (this.busy || !this.connected) return false;
    this.busy = true;
    const key = config.join(",");
    const op = key !== this.sentConfig
      ? this.chars.config.writeValueWithResponse(config).then(() => { this.sentConfig = key; })
      : this.chars.state.writeValueWithoutResponse(state);
    op.catch(e => { this.note = `Bluetooth: ${e.message}`; }).finally(() => { this.busy = false; });
    return true;
  }
}

// ---- ESP32-S3: Web Serial over native USB ----
const ESPRESSIF_USB_VID = 0x303a;

class SerialTransport {
  constructor() { this.port = this.writer = this.reader = null; this.ready = false; this.sentAt = 0; this.note = ""; this.errors = 0; this.onclose = () => {}; }
  get supported() { return "serial" in navigator; }
  get connected() { return !!this.writer; }
  get maxInflight() { return 1; }
  canSend(now) { return this.ready || now - this.sentAt > 1000; }   // a lost reply shouldn't stall the stream

  async connect() {
    this.port = await navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_USB_VID }] });
    await this.port.open({ baudRate: 921600, bufferSize: 65536 }); // native USB ignores the baud rate
    this.writer = this.port.writable.getWriter();
    this.ready = true;
    this.#readReplies();
  }

  async disconnect() {
    const port = this.port;
    if (!port) return;
    this.port = null;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    this.writer = null;
    try { await port.close(); } catch {}
    this.onclose();
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

  #onReply([status, t0, t1]) {
    if (status) this.errors++;
    this.note = `board ${t0 | (t1 << 8)} ms` + (this.errors ? ` · ${this.errors} errors` : "");
    this.ready = true;
  }

  async send(jpg, now) {
    this.ready = false;
    this.sentAt = now;
    const bytes = new Uint8Array(await jpg.arrayBuffer());
    const packet = new Uint8Array(8 + bytes.length);
    packet.set([0x46, 0x4c, 0x57, 0x52]); // "FLWR"
    new DataView(packet.buffer).setUint32(4, bytes.length, true);
    packet.set(bytes, 8);
    try { await this.writer?.write(packet); return true; }
    catch { return false; }
  }
}
