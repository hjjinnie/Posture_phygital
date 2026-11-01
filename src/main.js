import { PoseEngine, drawSkeleton } from "./pose.js";
import { extractFeatures, FeatureFilter, scorePosture, Wellbeing, median } from "./posture.js";
import { Flower } from "./flower.js";

const q = new URLSearchParams(location.search);
const INFER_HZ = +(q.get("hz") || 15);          // posture changes over seconds; 15 Hz leaves room for 60 fps rendering
const CAL_SECONDS = 1.5;
// The tracker's crop takes ~1–2 s to settle after (re)acquiring a person; geometry drifts a few % meanwhile.
const WARMUP_MS = 2000;

const $ = id => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), octx = overlay.getContext("2d");
const flower = new Flower($("stage"));
const engine = new PoseEngine();
const wellbeing = new Wellbeing(+(q.get("tau") || 45));
let filter = new FeatureFilter();

const app = window.app = { flower, engine, source: null, srcName: null, baseline: null, features: null, state: null, calib: null, inferMs: 0 };
const NEUTRAL = { trunk: 0, lateral: 0, head: 0, headRoll: 0, shoulderTilt: 0, protraction: 0, elevL: 0, elevR: 0 };

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
  if (!r) { app.state = null; app.warmUntil = now + WARMUP_MS; flower.setTarget({ ...NEUTRAL, wellbeing: wellbeing.value, confidence: 0 }); renderMetrics(null); return; }
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
    flower.setTarget({ ...NEUTRAL, wellbeing: wellbeing.value, confidence: f.conf });
    renderMetrics(null);
    return;
  }
  const s = app.state = scorePosture(f, app.baseline);
  wellbeing.update(s.score, dt);
  flower.setTarget({ ...s, wellbeing: wellbeing.value, confidence: f.conf });
  renderMetrics(s);
}

function loop(now) {
  const dt = (now - lastFrame) / 1000; lastFrame = now;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  if (manualOn()) flower.setTarget(manual);
  flower.frame(dt, now / 1000);
  $("foot").textContent = `${engine.model ?? "…"} · inference ${app.inferMs.toFixed(0)} ms @ ${INFER_HZ} Hz · render ${fps.toFixed(0)} fps` +
    (app.baseline ? "" : " · not calibrated");
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
// Inference runs on a timer, not rAF, so posture tracking continues (throttled) when the window is hidden.
setInterval(() => { if (app.source && engine.landmarker) infer(); }, 1000 / INFER_HZ);

// ---- wiring ----
$("startBtn").onclick = () => setSource($("src").value);
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

const model = q.get("model") || "heavy";
$("model").value = model;
await engine.load(model);
$("camMsg").textContent = "Press Start camera";
$("startBtn").disabled = false;
if (q.get("src")) { $("src").value = q.get("src"); await setSource(q.get("src")); if (q.has("autocal")) calibrate(); }
