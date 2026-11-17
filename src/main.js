import { PoseEngine, drawSkeleton } from "./pose.js";
import { extractFeatures, median } from "./posture.js";
import { PosturePipeline, SETTINGS } from "./pipeline.js";
import { STUDY, Recorder, conditionFor, suggestedOrder, rescoreParticipant, loadCalibration, saveCalibration,
  loadParticipant, saveParticipant } from "./study.js";
import { VISUALS } from "./visuals.js";
import { DisplayLink, TARGETS } from "./display.js";

const q = new URLSearchParams(location.search);
const INFER_HZ = +(q.get("hz") || 15);
if (q.get("studymin")) STUDY.sessionMinutes = +q.get("studymin");   // shorter sessions, for testing the study flow          // posture changes over seconds; 15 Hz leaves room for 60 fps rendering
const CAL_SECONDS = 1.5;
// The tracker's crop takes ~1–2 s to settle after (re)acquiring a person; geometry drifts a few % meanwhile.
const WARMUP_MS = 2000;

const $ = id => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), octx = overlay.getContext("2d");
const engine = new PoseEngine();

const app = window.app = { visual: null, engine, display: null, source: null, srcName: null, baseline: null, pipeline: null, seen: false, calib: null, inferMs: 0 };
const NEUTRAL = { trunk: 0, lateral: 0, head: 0, headRoll: 0, shoulderTilt: 0, protraction: 0, elevL: 0, elevR: 0 };
// Passive artifact: neutral and healthy whatever the posture; the visuals' own breathing, blinking and sway keep it alive.
const PASSIVE = { ...NEUTRAL, wellbeing: 0.9, confidence: 1 };

// Saved settings: store(key) reads, store(key, value) writes. Settings saved before the rename to Posture Buddy
// (under "posture-flower.") are still read, so calibration and choices carry over.
function store(k, v) {
  try {
    if (v !== undefined) return localStorage.setItem(`posture-buddy.${k}`, v), v;
    return localStorage.getItem(`posture-buddy.${k}`) ?? localStorage.getItem(`posture-flower.${k}`);
  } catch { return v ?? null; }
}

// ---- visuals (only the selected one exists; switching frees the other's GPU context) ----
let visual = null, target = { ...NEUTRAL, wellbeing: SETTINGS.startHealth, confidence: 0 };
function setTarget(s) { target = s; visual?.setTarget(s); }
$("visual").innerHTML = Object.entries(VISUALS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
async function setVisual(name) {
  if (!VISUALS[name]) name = "flower";
  const Visual = await VISUALS[name].load();
  visual?.dispose();
  visual = app.visual = new Visual($("stage"));
  if (display) display.visual = visual;
  visual.setTarget(target);
  $("visual").value = name;
  store("visual", name);
}

const storeKey = () => `baseline.${engine.model}`;
const saveBaseline = () => { if (app.srcName === "webcam") store(storeKey(), JSON.stringify(app.baseline)); };
const loadBaseline = () => { try { return JSON.parse(store(storeKey())); } catch { return null; } };
// Outside a study session the pipeline follows the app's own calibration; in a session it uses the participant's.
const resetPipeline = () => { app.pipeline = app.baseline ? new PosturePipeline(app.baseline) : null; };

// ---- metrics panel ----
// Bars show the 4 s average; the big number is the held posture's score; health is what the artifact shows.
const METRICS = [
  ["sevTrunk", "Trunk slump", s => s.trunk < -0.05 ? "back" : ""],
  ["sevStack", "Ear–shoulder–hip", () => ""],
  ["sevLateral", "Side balance", s => Math.abs(s.lateral) > 0.05 ? (s.lateral > 0 ? "R" : "L") : ""],
  ["sevHead", "Forward head", () => ""],
  ["sevShoulders", "Shoulders", s => s.protraction > s.elevL + s.elevR ? "fwd" : (s.elevL + s.elevR > 0.1 ? "up" : "")],
];
$("metrics").innerHTML = METRICS.map(([k, label]) =>
  `<div class="metric"><span class="name">${label}</span><div class="bar"><i id="bar-${k}"></i></div><span class="val" id="val-${k}"></span></div>`).join("");
const sevColor = x => x < 0.33 ? "var(--good)" : x < 0.66 ? "var(--warn)" : "var(--bad)";
function renderMetrics() {
  const p = app.pipeline, s = p?.present ? p.avg : null, h = p?.held;
  for (const [k, , note] of METRICS) {
    const x = s ? s[k] : 0;
    Object.assign($(`bar-${k}`).style, { width: `${Math.round(x * 100)}%`, background: sevColor(x) });
    $(`val-${k}`).textContent = s ? `${note(s)} ${Math.round(x * 100)}` : "";
  }
  $("score").textContent = h ? Math.round(h.score * 100) : "–";
  $("score").style.color = h ? sevColor(1 - h.score) : "";
  $("health").textContent = p ? Math.round(p.health * 100) : "–";
  $("holdStatus").textContent = p ? p.statusText : "";
}

// What the artifact shows: the sliders, the passive artifact, or the held posture and display health.
function updateTarget() {
  if (manualOn()) return setTarget(manual);
  if (studyMode() === "passive") return setTarget(PASSIVE);
  setTarget(app.pipeline ? app.pipeline.target() : { ...NEUTRAL, wellbeing: SETTINGS.startHealth, confidence: app.seen ? 1 : 0 });
}

// ---- manual sliders (to design a visual without a camera) ----
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
  app.pipeline = null;
  app.warmUntil = performance.now() + WARMUP_MS;
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
    if (!inStudy()) resetPipeline();
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
  app.calib = { frames: [], results: 0, people: 0, from: start, until: start + CAL_SECONDS * 1000 };
  // Finish even if the pose model goes quiet, so "Hold still…" can never stay up.
  clearTimeout(calTimer);
  calTimer = setTimeout(finishCalibration, app.calib.until - performance.now() + 3000);
}
let calTimer;

// Ends calibration: a baseline from the frames collected, or a message saying what was missing.
function finishCalibration() {
  const c = app.calib;
  if (!c) return;
  app.calib = null;
  clearTimeout(calTimer);
  if (c.frames.length >= 5) {
    app.baseline = median(c.frames); saveBaseline(); banner("Calibrated ✓");
    if (study.calWaiter) { const done = study.calWaiter; study.calWaiter = null; done(app.baseline); }
    else if (!inStudy()) resetPipeline();
  }
  else if (!c.results) banner("The pose model isn't running. Reload the page (Cmd+Shift+R) and try again.", 8000);
  else if (!c.people) banner("No one in view. Get your head and shoulders in the camera, then press Calibrate.", 6000);
  else banner("Couldn't see your ears and shoulders clearly. Try again.", 5000);
}
app.calibrate = calibrate;
app.infer = () => infer();   // lets tests step the pipeline when timers are throttled
app.setSource = setSource;

// ---- main loop ----
let lastInfer = performance.now(), lastVideoTime = -1, lastFrame = performance.now(), fps = 0, inferring = false;
async function infer() {
  if (inferring) return;   // the worker is still on the previous frame
  const now = performance.now();
  const dt = (now - lastInfer) / 1000; lastInfer = now;
  const src = app.source;
  if (src === video) {
    if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;
  }
  let r;
  inferring = true;
  try { r = await engine.detect(src); }
  catch (e) { app.inferError = e.message; return; }   // e.g. the model is being switched
  finally { inferring = false; }
  if (src !== app.source) return;
  app.inferMs = engine.ms;
  app.inferError = null;
  if (app.calib) { app.calib.results++; if (r) app.calib.people++; }
  if (study.rec && study.recording) study.rec.frame(studyTime(now), r);

  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (src !== video) octx.drawImage(src, 0, 0);
  let raw = null;
  if (r) {
    drawSkeleton(octx, r.lm);
    raw = extractFeatures(r.lm, r.world, overlay.width, overlay.height);
    if (app.calib && raw.conf > 0.6 && now >= app.calib.from) app.calib.frames.push(raw);
  } else app.warmUntil = now + WARMUP_MS;
  app.seen = !!raw && raw.conf >= SETTINGS.minConfidence;
  if (app.calib && now > app.calib.until) finishCalibration();
  app.pipeline?.push(now / 1000, raw);
  updateTarget();
  renderMetrics();
}

// While an external screen is streaming, this window's own view drops to 30 fps: on an integrated GPU the two 3D views
// and the pose model compete, and the external screen is the one being watched (measured with the blob: Pi stream
// 17 → 25 fps, pose model 150 → 60 ms).
const SHARED_FPS = +(q.get("mainfps") || 30);
function loop(now) {
  if (display?.connected && now - lastFrame < 1000 / SHARED_FPS - 4) return requestAnimationFrame(loop);
  const dt = (now - lastFrame) / 1000; lastFrame = now;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  if (manualOn()) setTarget(manual);
  if (visual) { visual.step(dt, now / 1000); visual.render(); }
  renderStudyStatus(now);
  const pose = !engine.ready ? "pose model loading…" : app.inferError ? `pose model error: ${app.inferError}`
    : `${engine.model} · inference ${app.inferMs.toFixed(0)} ms @ ${INFER_HZ} Hz`;
  $("foot").textContent = `${pose} · render ${fps.toFixed(0)} fps` + (app.baseline ? "" : " · not calibrated");
  renderDisplayStatus();
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
  if (app.source && engine.ready && now - lastInfer >= 1000 / INFER_HZ - 5) infer();
  if (study.phase === "running" && now >= study.endAt) endSession(false);
  if (now - lastFrame > 100) {
    if (manualOn()) setTarget(manual);
    visual?.step((now - lastTick) / 1000, now / 1000);
  }
  lastTick = now;
  display?.tick(now);
};

// ---- external screen: Raspberry Pi over HDMI, or the ESP32 LCD ----
let display = null;
$("dispTarget").innerHTML = Object.entries(TARGETS).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join("");
$("piHost").value = q.get("pi") || store("piHost") || "10.12.194.1";

function setDisplay(target) {
  if (!TARGETS[target]) target = "pi";
  display?.dispose();
  display = app.display = new DisplayLink(target, { host: $("piHost").value.trim(), ...(q.get("dispfps") && { fps: +q.get("dispfps") }), ...(q.get("zoom") && { zoom: q.get("zoom") === "auto" ? "auto" : +q.get("zoom") }) });
  display.visual = visual;
  $("lcdPreview").replaceChildren(display.canvas);
  $("dispTarget").value = target;
  $("piHost").hidden = target !== "pi";
  $("lcdBtn").disabled = !display.supported;
  store("display", target);
}
setDisplay(q.get("display") || store("display"));
if (q.get("connect") === "1" && display.target === "pi") display.connect().catch(e => banner(e.message, 6000));  // no picker needed

function renderDisplayStatus() {
  const s = display.stats;
  $("lcdBtn").textContent = display.connected ? "Disconnect" : "Connect";
  $("lcdStatus").textContent = !display.supported ? "Needs Chrome or Edge (Web Serial)"
    : display.connected ? `${s.fps.toFixed(0)} fps · ${s.kb.toFixed(0)} KB/frame` + (s.note ? ` · ${s.note}` : "")
    : "Not connected";
}
$("dispTarget").onchange = e => setDisplay(e.target.value);
$("piHost").onchange = e => { store("piHost", e.target.value.trim()); setDisplay("pi"); };
$("lcdBtn").onclick = async () => {
  try {
    if (display.target === "pi") display.transport.host = $("piHost").value.trim();
    display.connected ? await display.disconnect() : await display.connect();
  } catch (e) {
    // NotFoundError: the serial picker was cancelled, or this browser (e.g. an embedded preview) can't show one.
    banner(e.name === "NotFoundError" ? "No port chosen. In Chrome or Edge, pick “USB JTAG/serial debug unit”."
      : display.target === "pi" ? `${e.message}. Is the Pi plugged in and posture_display.py running?` : `LCD: ${e.message}`, 6000);
  }
};

// ---- study sessions (study.js) ----
// Each session: a 5 s neutral camera check, calibration if the session is active, then the 22-minute timer.
// Landmarks are recorded from the camera check to the end; scoring happens afterwards from the recording.
const study = app.study = { phase: "idle", calWaiter: null, rec: null, recording: false, note: "" };
const inStudy = () => !["idle", "done"].includes(study.phase);
const studyTime = now => (now - study.logStart) / 1000;
// Passive while the session is setting up, saving or done; the session's condition while its timer runs.
function studyMode() {
  if (!inStudy() && study.phase !== "done") return "active";
  return study.phase === "running" ? study.condition : "passive";
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startSession() {
  if (inStudy()) return;
  const pid = $("pid").value.trim(), session = +$("session").value, order = $("order").value;
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(pid)) return studyNote("Enter a participant ID (letters, digits, - or _).");
  if (!app.source) return studyNote("Start the camera first.");
  if (!engine.ready) return studyNote("Wait for the pose model to load.");
  const condition = conditionFor(order, session);
  try {
    const existing = await loadParticipant(pid);
    if (existing && existing.order !== order && !confirm(`${pid} was set up with order ${existing.order}. Change it to ${order}?`)) return;
    await saveParticipant(pid, { participant: pid, order, created: existing?.created ?? new Date().toISOString() });
    Object.assign(study, { pid, session, order, condition, phase: "check", logStart: performance.now(), note: "" });
    study.rec = new Recorder(pid, `session${session}.jsonl`);
    await study.rec.open({ participant: pid, session, order, condition, startedAt: new Date().toISOString(),
      W: overlay.width, H: overlay.height, source: app.srcName, model: engine.model, settings: SETTINGS, study: STUDY });
  } catch (e) {
    study.phase = "idle";
    return studyNote(`Can't save study data (${e.message}). Is the app running from serve.py?`);
  }
  study.recording = true;
  app.pipeline = null;   // nothing is shown or scored until the timer starts
  studyControls();

  study.rec.event(studyTime(performance.now()), "camera_check_start");
  banner("Please look at the screen and sit as you normally would", 0);
  await sleep(STUDY.cameraCheckSeconds * 1000);
  if (study.phase !== "check") return;
  study.rec.event(studyTime(performance.now()), "camera_check_end");
  banner("");

  let baseline = null;
  if (condition === "active") {
    study.phase = "calibrating";
    studyNote("Calibrating. If it fails, press Calibrate (sit tall) again.");
    baseline = await new Promise(res => { study.calWaiter = res; calibrate(); });
    if (study.phase !== "calibrating") return;
    await saveCalibration(study.pid, { participant: study.pid, session, at: new Date().toISOString(), model: engine.model, baseline });
    study.rec.event(studyTime(performance.now()), "calibrated", { baseline });
    // A passive first session can be scored now.
    rescoreParticipant(study.pid).then(msg => studyNote(msg)).catch(e => studyNote(`Re-scoring failed: ${e.message}`));
  } else {
    baseline = (await loadCalibration(pid))?.baseline ?? null;   // active-first participants: from session 1
  }

  study.phase = "running";
  study.timerStart = performance.now();
  study.endAt = study.timerStart + STUDY.sessionMinutes * 60e3;
  study.rec.event(studyTime(study.timerStart), "timer_start");
  app.pipeline = baseline ? new PosturePipeline(baseline) : null;
  banner("");
  studyControls();
}

async function endSession(early) {
  if (!inStudy() || study.phase === "saving") return;
  study.calWaiter = null;
  const ran = study.phase === "running";
  study.rec.event(studyTime(performance.now()), ran ? "timer_end" : "cancelled", early ? { early: true } : {});
  study.recording = false;
  study.phase = "saving";
  studyControls();
  banner(ran && !early ? "Session complete – thank you!" : "", 0);
  try {
    await study.rec.close();
    studyNote(await rescoreParticipant(study.pid));
  } catch (e) { studyNote(`Saving failed: ${e.message}`); }
  study.phase = "done";
  resetPipeline();
  studyControls();
}

function studyNote(text) { study.note = text; renderStudyStatus(performance.now()); }
function studyControls() {
  const busy = inStudy();
  for (const id of ["pid", "order", "session", "studyStart", "studyRescore"]) $(id).disabled = busy;
  $("studyStop").disabled = !busy || study.phase === "saving";
  $("studyCond").textContent = `Session ${$("session").value}: ${conditionFor($("order").value, +$("session").value)}`;
}
const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
function renderStudyStatus(now) {
  const phase = { idle: "", check: "camera check", calibrating: "calibrating", running: `${study.condition} · ${mmss(study.endAt - now)} left`,
    saving: "saving…", done: "done" }[study.phase];
  const rec = study.rec && inStudy() ? ` · ${study.rec.written} records saved` + (study.rec.error ? ` · SAVE ERROR: ${study.rec.error}` : "") : "";
  $("studyStatus").textContent = (phase ? `${study.pid} · ${phase}${rec}` : "") + (study.note ? (phase ? " — " : "") + study.note : "");
}

$("pid").value = store("study.pid") || "";
$("pid").onchange = async () => {
  const pid = $("pid").value.trim();
  store("study.pid", pid);
  const p = pid && await loadParticipant(pid).catch(() => null);
  $("order").value = p?.order ?? suggestedOrder(pid);
  studyNote(p ? `${pid}: order ${p.order} (saved)` : pid ? `${pid}: new participant, suggested order ${$("order").value}` : "");
  studyControls();
};
$("order").onchange = $("session").onchange = studyControls;
$("studyStart").onclick = startSession;
$("studyStop").onclick = () => { if (confirm("End this session early? What's recorded so far is kept and scored.")) endSession(true); };
$("studyRescore").onclick = async () => {
  const pid = $("pid").value.trim();
  if (!pid) return studyNote("Enter a participant ID.");
  studyNote("Re-scoring…");
  try { studyNote(await rescoreParticipant(pid)); } catch (e) { studyNote(`Re-scoring failed: ${e.message}`); }
};
// Participant view: only the artifact, full window. Esc brings the researcher panel back.
const participantView = on => { document.body.classList.toggle("participant", on); dispatchEvent(new Event("resize")); };
$("participantView").onclick = () => participantView(true);
addEventListener("keydown", e => { if (e.key === "Escape") participantView(false); });
addEventListener("beforeunload", e => { if (inStudy()) { e.preventDefault(); e.returnValue = ""; } });
studyControls();
if ($("pid").value) $("pid").onchange();

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
  if (!inStudy()) resetPipeline();
  $("camMsg").textContent = "";
  if (!app.baseline && app.source) banner("New model — please recalibrate", 3000);
};

await setVisual(q.get("visual") || store("visual") || "flower");

const model = q.get("model") || "lite";   // lite keeps up best alongside the 3D views; ?model=heavy for accuracy
$("model").value = model;
await engine.load(model);
$("camMsg").textContent = "Press Start camera";
$("startBtn").disabled = false;
if (q.get("src")) { $("src").value = q.get("src"); await setSource(q.get("src")); if (q.has("autocal")) calibrate(); }
