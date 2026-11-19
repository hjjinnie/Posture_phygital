// The Bluetooth path's screen: draws the posture visual on the Pi itself from the posture and settings the app sends
// (posture_ble.py -> posture_display.py -> ws://localhost:8790/live). screen.html loads this on the first message.
//
// The Pi's GPU can't draw the heavier visuals at full screen size (measured on a Pi 5 at 1080x1920: blob 3 fps, liquid
// metaball 3), so each visual is drawn smaller and scaled up: the size starts where that visual runs smoothly and steps
// down or back up to stay there (see adapt()).
// Framing, orientation and brightness match what the computer-rendered stream (src/display.js) does.
import * as THREE from "three";
import { VISUALS } from "./src/visuals.js";

// Order shared with the app (src/display.js BLE_VISUALS / BLE_FLIPS): the settings message carries indexes.
const NAMES = ["ema-liquid", "ema-contour", "ema-dandelion", "ema-branching", "blob"];
const FLIPS = ["none", "v", "h", "both"];
// Posture message: 10 x int16 LE. These eight are scaled by 1000, the two angles (degrees) by 100.
const MILLI = ["trunk", "lateral", "head", "protraction", "elevL", "elevR", "wellbeing", "confidence"];
const CENTI = ["headRoll", "shoulderTilt"];

const LONG = [1920, 1600, 1280, 1120, 960, 800, 720, 640, 560, 480, 400, 360, 320];   // long side, in pixels
const START = { blob: 400, "ema-liquid": 480, "ema-contour": 480, "ema-dandelion": 960, "ema-branching": 960 };
const FILL = 0.85, IN_TAU = 2.5;   // as src/display.js: 7.5% margin to every edge; moving in again is slow

const POST_VS = `#version 300 es
out vec2 uv;
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
// Orientation, then brightness along 1 - (1 - v)^b (black stays black, white never clips), as the stream's encoder.
const POST_FS = `#version 300 es
precision mediump float;
in vec2 uv; out vec4 color;
uniform sampler2D tex; uniform vec2 flip; uniform float bright;
void main() {
  vec2 p = mix(uv, 1.0 - uv, flip);
  vec3 c = texture(tex, p).rgb;
  color = vec4(1.0 - pow(1.0 - c, vec3(bright)), 1.0);
}`;

export function createLive({ onStats }) {
  // The visual also builds its own main view in this host; only its display view (renderLcd) is drawn here.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:0;top:0;width:320px;height:240px;opacity:0;pointer-events:none";
  document.body.append(host);

  // Three.js draws into a small offscreen canvas; a second WebGL canvas fills the screen, scaling it up and applying
  // orientation and brightness in one pass (three.js's tone mapping only happens when drawing to a canvas, so the
  // visual is drawn to one rather than to a render target).
  const src = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas: src, antialias: true });
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const out = document.createElement("canvas");
  out.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;display:none";
  document.body.append(out);
  const gl = out.getContext("webgl2", { alpha: false, antialias: false });
  const shader = (type, code) => { const s = gl.createShader(type); gl.shaderSource(s, code); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, POST_VS));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, POST_FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const uFlip = gl.getUniformLocation(prog, "flip"), uBright = gl.getUniformLocation(prog, "bright");
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);   // canvas rows are top-down; GL's texture rows are bottom-up

  const state = { trunk: 0, lateral: 0, head: 0, headRoll: 0, shoulderTilt: 0, protraction: 0, elevL: 0, elevR: 0, wellbeing: 1, confidence: 0 };
  const settings = { visual: null, flip: "v", bright: 2 };
  let visual = null, name = null, loading = null, half = null, long = 480, size = [0, 0];
  let frames = 0, windowStart = performance.now(), slowWindows = 0, fastWindows = 0, settle = 0, last = performance.now();
  let shown = false, ready = false;

  function fit() {
    out.width = Math.round(innerWidth * devicePixelRatio);
    out.height = Math.round(innerHeight * devicePixelRatio);
    const aspect = out.width / out.height;
    const h = aspect < 1 ? long : Math.round(long / aspect), w = Math.round(h * aspect / 8) * 8;
    if (w !== size[0] || h !== size[1]) { size = [w, h]; renderer.setSize(w, h, false); }
  }
  addEventListener("resize", fit);

  // Switches visual. The new one draws its first frame (which compiles its shaders: up to ~20 s on the Pi the first
  // time, then cached by Chromium) before it replaces the old one, so the screen never goes black meanwhile.
  async function load(n) {
    if (!VISUALS[n] || n === name) return;
    name = n;
    const token = loading = Symbol();
    let Visual;
    try { Visual = await VISUALS[n].load(); }
    catch (e) { if (token === loading) { loading = null; name = visual ? name : null; } console.error("couldn't load", n, e); return; }
    if (token !== loading) return;
    const next = new Visual(host), old = visual;
    next.setTarget(state);
    long = START[n] ?? 480;
    half = null;
    fit();
    visual = next;
    draw(performance.now(), 0);
    last = performance.now();
    old?.dispose();
    loading = null;
    ready = true;
    applyShow();
    // The frame rate settles once the new visual is running: don't judge the drawing size on the first few seconds.
    frames = 0; windowStart = performance.now(); slowWindows = fastWindows = 0; settle = 2;
  }

  // The shot: as src/display.js's auto framing, fitted to the visual's own geometry, never cutting anything off.
  function framing(cam, aspect, dt) {
    const base = Math.tan((cam.userData.baseFov ??= cam.fov) * Math.PI / 360) * (aspect >= 4 / 3 ? 1 : (4 / 3) / aspect);
    if (!visual.screenBounds) return base;
    cam.updateMatrixWorld();
    const b = visual.screenBounds(cam);
    const target = Math.max(base / (visual.screenZoom ?? 1), Math.max(b.y, b.x / aspect) / FILL);
    if (half == null || target > half) half = target;
    else half += (target - half) * (1 - Math.exp(-dt / IN_TAU));
    return half;
  }

  // Keep at least ~25 fps (smooth for these slowly morphing forms): step the drawing size down after two slow 2-second
  // windows, back up (not past the visual's start) after five fast ones. Measured on a Pi 5 with the visual framed to
  // fill the screen: blob ~26 fps at 224x400, liquid metaball ~26 at 272x480, dandelions ~43 at 544x960.
  function adapt(fps) {
    if (settle > 0) { settle--; return; }
    const i = LONG.indexOf(long);
    if (fps < 22) { fastWindows = 0; if (++slowWindows >= 2 && i < LONG.length - 1) { long = LONG[i + 1]; slowWindows = 0; fit(); } }
    else if (fps > 40) { slowWindows = 0; if (++fastWindows >= 5 && i > 0 && LONG[i - 1] <= (START[name] ?? 480)) { long = LONG[i - 1]; fastWindows = 0; fit(); } }
    else slowWindows = fastWindows = 0;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!visual || loading) return;
    draw(now, Math.min((now - last) / 1000, 0.1));
    last = now;
    frames++;
    if (now - windowStart >= 2000) {
      const fps = frames * 1000 / (now - windowStart);
      frames = 0; windowStart = now;
      adapt(fps);
      onStats?.(fps, size[0], size[1]);
    }
  }

  function draw(now, dt) {
    visual.step(dt, now / 1000);
    const cam = visual.lcdCamera, aspect = size[0] / size[1];
    const fov = 2 * Math.atan(framing(cam, aspect, dt)) * 180 / Math.PI;
    if (cam.aspect !== aspect || cam.fov !== fov) { cam.aspect = aspect; cam.fov = fov; cam.updateProjectionMatrix(); }
    visual.renderLcd(renderer);

    gl.viewport(0, 0, out.width, out.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
    const f = settings.flip;
    gl.uniform2f(uFlip, f === "h" || f === "both" ? 1 : 0, f === "v" || f === "both" ? 1 : 0);
    gl.uniform1f(uBright, settings.bright);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  const applyShow = () => { out.style.display = shown && ready ? "block" : "none"; };

  fit();
  requestAnimationFrame(frame);

  return {
    // A message from the app, as relayed: b"S" + posture, or b"C" + settings.
    message(buf) {
      const dv = new DataView(buf), kind = String.fromCharCode(dv.getUint8(0));
      if (kind === "S" && buf.byteLength >= 21) {
        MILLI.forEach((k, i) => { state[k] = dv.getInt16(1 + i * 2, true) / 1000; });
        CENTI.forEach((k, i) => { state[k] = dv.getInt16(17 + i * 2, true) / 100; });
        visual?.setTarget(state);
      } else if (kind === "C" && buf.byteLength >= 4) {
        settings.flip = FLIPS[dv.getUint8(2)] ?? "v";
        settings.bright = Math.max(1, dv.getUint8(3) / 10);
        load(NAMES[dv.getUint8(1)] ?? "ema-liquid");
      }
      if (!visual && !loading) load("ema-liquid");   // posture before any settings: show the default visual
    },
    show(on) { if (on !== shown) { shown = on; applyShow(); } },
    get ready() { return ready; },   // true once a visual has drawn: until then the page keeps showing "loading…"
  };
}
