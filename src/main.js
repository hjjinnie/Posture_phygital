import { PoseEngine, drawSkeleton } from "./pose.js";
import { extractFeatures, FeatureFilter, scorePosture, Wellbeing, median } from "./posture.js";
import { VISUALS } from "./visuals.js";
import { LcdLink } from "./lcd.js";

const q = new URLSearchParams(location.search);
const INFER_HZ = +(q.get("hz") || 15);          // posture changes over seconds; 15 Hz leaves room for 60 fps rendering
const CAL_SECONDS = 1.5;
// The tracker's crop takes ~1–2 s to settle after (re)acquiring a person; geometry drifts a few % meanwhile.
const WARMUP_MS = 2000;

const $ = id => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), octx = overlay.getContext("2d");
const engine = new PoseEngine();
const wellbeing = new Wellbeing(+(q.get("tau") || 45));
const lcd = new LcdLink({ fps: +(q.get("lcdfps") || 20) });
let filter = new FeatureFilter();

const app = window.app = { visual: null, engine, lcd, source: null, srcName: null, baseline: null, features: null, state: null, calib: null, inferMs: 0 };
const NEUTRAL = { trunk: 0, lateral: 0, head: 0, headRoll: 0, shoulderTilt: 0, protraction: 0, elevL: 0, elevR: 0 };

// ---- visuals (only the selected one exists; switching frees the other's GPU context) ----
let visual = null, target = { ...NEUTRAL, wellbeing: wellbeing.value, confidence: 0 };
function setTarget(s) { target = s; visual?.setTarget(s); }
$("visual").innerHTML = Object.entries(VISUALS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
async function setVisual(name) {
  if (!VISUALS[name]) name = "flower";
  const Visual = await VISUALS[name].load();
  visual?.dispose();
  visual = app.visual = lcd.visual = new Visual($("stage"));
  visual.setTarget(target);
  $("visual").value = name;
  try { localStorage.setItem("posture-flower.visual", name); } catch {}
}

const storeKey = () => `posture-flower.baseline.${engine.model}`;
const saveBaseline = () => { if (app.srcName === "webcam") try { localStorage.setItem(storeKey(), JSON.stringify(app.baseline)); } catch {} };
const loadBaseline = () => { try { return JSON.parse(localStorage.getItem(storeKey())); } catch { return null; } };

// ---- metrics panel ----
const METRICS = [
  ["trunk", "Trunk slump", s => s.trunk < -0.05 ? "back" : ""],
  ["stack", "Ear–shoulder–hip", () => ""],
  ["lateral", "Side balance", s => Math.abs(s.lateral) > 0.05 ? (s.lateral > 0 ? "R" : "L") : ""],
  ["head", "Forward head", () => ""],
  ["shoulders", "Shoulders", s => s.sev.protraction > s.sev.elevL + s.sev.elevR ? "fwd" : (s.sev.elevL + s.sev.elevR > 0.1 ? "up" : "")],
];
$("metrics").innerHTML = METRICS.map(([k, label]) =>
  `<div class="metric"><span class="name">${label}</span><div class="bar"><i id="bar-${k}"></i></div><span class="val" id="val-${k}"></span></div>`).join("");
const sevColor = x => x < 0.33 ? "var(--good)" : x < 0.66 ? "var(--warn)" : "var(--bad)";
function renderMetrics(s) {
  for (const [k, , note] of METRICS) {
    const x = s ? s.sev[k] : 0;
    Object.assign($(`bar-${k}`).style, { width: `${Math.round(x * 100)}%`, background: sevColor(x) });
    $(`val-${k}`).textContent = s ? `${note(s)} ${Math.round(x * 100)}` : "";
  }
  $("score").textContent = s ? Math.round(s.score * 100) : "–";
  $("score").style.color = s ? sevColor(1 - s.score) : "";
  $("health").textContent = Math.round(wellbeing.value * 100);
}

// ---- manual sliders (to design the flower without a camera) ----
const SLIDERS = [["trunk", -1, 1], ["lateral", -1, 1], ["head", 0, 1], ["headRoll", -30, 30], ["shoulderTilt", -15, 15],
  ["protraction", 0, 1], ["elevL", 0, 1], ["elevR", 0, 1], ["wellbeing", 0, 1]];
const manual = { ...NEUTRAL, wellbeing: 0.9, confidence: 1 };
$("sliders").innerHTML = SLIDERS.map(([k, lo, hi]) =>
  `<label class="slider">${k}<input type="range" min="${lo}" max="${hi}" step="0.01" value="${manual[k]}" data-k="${k}"></label>`).join("");
$("sliders").addEventListener("input", e => { manual[e.target.dataset.k] = +e.target.value; });
const manualOn = () => $("manual").open;

// ---- sources ----
async function setSource(name) {
  app.srcName = name;
  app.baseline = null;
  app.warmUntil = performance.now() + WARMUP_MS;
  filter = new FeatureFilter();
  if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
  if (name === "webcam") {
    $("camMsg").textContent = "Requesting camera…";
    try {
      video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: "user" }, audio: false });
      await video.play();
    } catch (e) {
      $("camMsg").textContent = `Camera unavailable: ${e.message}`;
      app.source = null;
      return;
    }
    app.source = video;
    app.baseline = loadBaseline();
    $("camMsg").textContent = "";
  } else {
    const img = new Image();
    img.src = `test-images/${name}.jpg`;
    await img.decode();
    app.source = img;
    $("camMsg").textContent = "";
  }
  overlay.width = app.source.videoWidth || app.source.naturalWidth;
  overlay.height = app.source.videoHeight || app.source.naturalHeight;
  $("calBtn").disabled = false;
  banner(app.baseline ? "" : "Sit tall and comfortable, then press Calibrate", 0);
}

let bannerTimer;
function banner(text, ms = 2500) {
  const b = $("banner");
  b.textContent = text; b.style.display = text ? "block" : "none";
  clearTimeout(bannerTimer);
  if (text && ms) bannerTimer = setTimeout(() => (b.style.display = "none"), ms);
}

async function calibrate() {
  if (app.srcName === "webcam") {
    for (const n of [3, 2, 1]) { banner(`Sit tall… ${n}`, 0); await new Promise(r => setTimeout(r, 700)); }
  }
  banner("Hold still…", 0);
  const start = Math.max(performance.now(), app.warmUntil ?? 0);
  app.calib = { frames: [], from: start, until: start + CAL_SECONDS * 1000 };
}
app.calibrate = calibrate;
app.infer = () => infer();   // lets tests step the pipeline when timers are throttled
app.setSource = setSource;

// ---- main loop ----
let lastInfer = performance.now(), lastVideoTime = -1, lastFrame = performance.now(), fps = 0;
function infer() {
  const now = performance.now();
  const dt = (now - lastInfer) / 1000; lastInfer = now;
  const src = app.source;
  if (src === video) {
    if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;
  }
  const r = engine.detect(src);
  app.inferMs = engine.ms;

  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (src !== video) octx.drawImage(src, 0, 0);
  if (!r) { app.state = null; app.warmUntil = now + WARMUP_MS; setTarget({ ...NEUTRAL, wellbeing: wellbeing.value, confidence: 0 }); renderMetrics(null); return; }
  drawSkeleton(octx, r.lm);

  const raw = extractFeatures(r.lm, r.world, overlay.width, overlay.height);
  const f = app.features = filter.apply(raw, now / 1000);

  if (app.calib) {
    if (raw.conf > 0.6 && now >= app.calib.from) app.calib.frames.push(raw);
    if (now > app.calib.until) {
      if (app.calib.frames.length >= 5) { app.baseline = median(app.calib.frames); saveBaseline(); banner("Calibrated ✓"); }
      else banner("Couldn't see your ears and shoulders clearly — try again");
      app.calib = null;
    }
  }
  if (!app.baseline || f.conf < 0.5) {
    setTarget({ ...NEUTRAL, wellbeing: wellbeing.value, confidence: f.conf });
    renderMetrics(null);
    return;
  }
  const s = app.state = scorePosture(f, app.baseline);
  wellbeing.update(s.score, dt);
  setTarget({ ...s, wellbeing: wellbeing.value, confidence: f.conf });
  renderMetrics(s);
}

function loop(now) {
  const dt = (now - lastFrame) / 1000; lastFrame = now;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  if (manualOn()) setTarget(manual);
  if (visual) { visual.step(dt, now / 1000); visual.render(); }
  $("foot").textContent = `${engine.model ?? "…"} · inference ${app.inferMs.toFixed(0)} ms @ ${INFER_HZ} Hz · render ${fps.toFixed(0)} fps` +
    (app.baseline ? "" : " · not calibrated");
  renderLcdStatus();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Inference and the LCD run off a worker's timer rather than rAF or page timers, which the browser
// pauses or slows to ~1 Hz when the window is hidden or covered (measured: rAF 1.5/s, worker 30/s).
// Whenever rAF has stalled, the tick also advances the visual so the LCD keeps animating.
const ticker = new Worker(URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 33)"], { type: "text/javascript" })));
let lastTick = performance.now();
ticker.onmessage = () => {
  const now = performance.now();
  if (app.source && engine.landmarker && now - lastInfer >= 1000 / INFER_HZ - 5) infer();
  if (now - lastFrame > 100) {
    if (manualOn()) setTarget(manual);
    visual?.step((now - lastTick) / 1000, now / 1000);
  }
  lastTick = now;
  lcd.tick(now);
};

// ---- LCD ----
$("lcdPreview").appendChild(lcd.canvas);
function renderLcdStatus() {
  const s = lcd.stats;
  $("lcdBtn").textContent = lcd.connected ? "Disconnect LCD" : "Connect LCD";
  $("lcdStatus").textContent = !lcd.supported ? "Needs Chrome or Edge (Web Serial)"
    : lcd.connected ? `${s.fps.toFixed(0)} fps · ${s.kb.toFixed(1)} KB/frame · board ${s.boardMs} ms` + (s.errors ? ` · ${s.errors} errors` : "")
    : "Not connected";
}
$("lcdBtn").disabled = !lcd.supported;
$("lcdBtn").onclick = async () => {
  try { lcd.connected ? await lcd.disconnect() : await lcd.connect(); }
  catch (e) {
    // NotFoundError: the picker was cancelled, or this browser (e.g. an embedded preview) can't show one.
    banner(e.name === "NotFoundError" ? "No port chosen. In Chrome or Edge, pick “USB JTAG/serial debug unit”." : `LCD: ${e.message}`, 5000);
  }
};

// ---- wiring ----
$("startBtn").onclick = () => setSource($("src").value);
$("visual").onchange = e => setVisual(e.target.value);
$("calBtn").onclick = calibrate;
$("src").onchange = () => { if (app.source) setSource($("src").value); };
$("model").onchange = async e => {
  $("camMsg").textContent = "Loading model…";
  await engine.load(e.target.value);
  // Models disagree on absolute geometry (measured: up to 0.1 in ear/shoulder ratio), so baselines are per model.
  app.baseline = app.srcName === "webcam" ? loadBaseline() : null;
  $("camMsg").textContent = "";
  if (!app.baseline && app.source) banner("New model — please recalibrate", 3000);
};

let savedVisual = null;
try { savedVisual = localStorage.getItem("posture-flower.visual"); } catch {}
await setVisual(q.get("visual") || savedVisual || "flower");

const model = q.get("model") || "heavy";
$("model").value = model;
await engine.load(model);
$("camMsg").textContent = "Press Start camera";
$("startBtn").disabled = false;
if (q.get("src")) { $("src").value = q.get("src"); await setSource(q.get("src")); if (q.has("autocal")) calibrate(); }
