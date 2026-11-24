// Companion page (chrome.html, posture-buddy.pages.dev/chrome): the jello blob in a small always-on-top window while you
// work, with the posture score under it, rewards for how long a posture lasts, and movement-break reminders.
//
// The floating window is Chrome's Document Picture-in-Picture (Chrome/Edge 116+): it stays above every app and can be
// dragged anywhere by its title bar; this tab must stay open (it runs the camera and the pose model).
//
//   Active   the blob mirrors posture; the score shows under it; rewards:
//              score above 90 for 5 min -> joy (bigger smile, hops, leaf sprouts; more of each up to 15 min)
//              score below 75 for 5 min -> distress (frown, shiver, sweat; more up to 15 min)
//            The score is a 10 s average of the live posture score; a dip of up to 20 s, or up to 60 s out of view,
//            doesn't break a run.
//   Passive  the blob is alive but doesn't react, and no score is shown (as the study's passive sessions).
//   Breaks   every N minutes (from the session start, then from the last break) the blob circles and asks for a
//            movement break: Start break (a 30 s countdown, the blob circling along), or Snooze (5 min). A break is asked
//            for at most 3 times; the third offers Skip.
//
// A session saves to the participant's study files (Cloudflare, or data/ from serve.py):
//   companion_<YYYYMMDD-HHMMSS>_<mode>.jsonl  header, events (breaks, rewards, calibration), and one row a second with
//                                            the pipeline's study fields (as session<N>_scored.csv) plus the live score.
// URL options: ?src=front-man&autocal=1 (a test photo instead of the webcam), ?rewardmin=5, ?snoozemin=5, ?breaksec=30 (shorter,
// to try things out), ?save=local (data/ via serve.py).
import { PoseEngine, drawSkeleton } from "./pose.js";
import { extractFeatures, median } from "./posture.js";
import { PosturePipeline, SETTINGS } from "./pipeline.js";
import { Recorder, setStorage, checkStorage } from "./study.js";
import { JelloBlob } from "./blob.js";

const q = new URLSearchParams(location.search);
const LOCAL = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
const INFER_HZ = 15, CAL_SECONDS = 1.5, WARMUP_MS = 2000;
const GOOD = 90, BAD = 75;                              // score thresholds for the rewards
const REWARD_S = 60 * +(q.get("rewardmin") || 5);       // a posture run must last this long to show
const FULL_S = 3 * REWARD_S;                            // ...and is at its strongest at this
const GRACE_S = 20, ABSENT_S = 60;                      // what doesn't break a run
const SNOOZE_S = 60 * +(q.get("snoozemin") || 5), MAX_REMINDERS = 3, BREAK_S = +(q.get("breaksec") || 30);
const NEUTRAL = { trunk: 0, lateral: 0, head: 0, headRoll: 0, shoulderTilt: 0, protraction: 0, elevL: 0, elevR: 0 };
const PASSIVE = { ...NEUTRAL, wellbeing: 0.9, confidence: 1 };
const BG = 0x101418;

const $ = id => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), octx = overlay.getContext("2d");
const engine = new PoseEngine();
const app = window.companion = { blob: null, source: null, srcName: null, baseline: null, pipeline: null, calib: null, warmUntil: 0, seen: false };
const session = { on: false, pid: "", mode: "active", rec: null, t0: 0, file: "" };
// reminder: {n, at, until} while asking (until: the countdown's end, once the break has started); count: which reminder
// of this break comes next; praiseUntil: a moment of "Nice!" after a break.
const breaks = { every: 0, next: 0, reminder: null, count: 1, praiseUntil: 0 };
app.breaks = breaks;
const run = { good: 0, bad: 0, offGood: 0, offBad: 0, absent: 0, joy: 0, distress: 0, slow: null, shown: null };

function store(k, v) {
  try {
    if (v !== undefined) return localStorage.setItem(`posture-buddy.${k}`, v), v;
    return localStorage.getItem(`posture-buddy.${k}`);
  } catch { return v ?? null; }
}
const mode = () => document.querySelector("input[name=mode]:checked").value;
function status(text, error = false) { $("status").textContent = text; $("status").classList.toggle("error", error); }

// ---- the blob: `card` (the blob's `stage` above, `under` below) moves between this tab and the floating window, and is
// laid out the same in both ----
const card = document.createElement("div");
card.className = "blob-card";
const stage = document.createElement("div");
stage.className = "stage";
const blob = new JelloBlob(stage, { maxPixels: 120_000 });
blob.scene.background.setHex(BG);
blob.scene.fog.color.setHex(BG);
blob.ground.visible = false;
blob.bodyShadow.visible = false;
blob.dropShadows.forEach(m => (m.visible = false));
blob.controls.enabled = false;   // dragging in the little window shouldn't spin it
app.blob = blob;
const view = { y: 1.5, dist: 4.0, circle: 0 };   // close framing: the window is small

// What shows under the blob: the score, or the movement-break prompt.
const under = document.createElement("div");
under.className = "under";
under.innerHTML = `<div class="score"></div><div class="brk" hidden><div class="msg">Time to move!</div>
  <div class="btns"><button class="go">Start break</button><button class="snooze">Snooze 5m</button></div></div>`;
const scoreEl = under.querySelector(".score"), brkEl = under.querySelector(".brk"), msgEl = under.querySelector(".msg"), btnsEl = under.querySelector(".btns");
under.querySelector(".go").onclick = startBreak;
under.querySelector(".snooze").onclick = () => (breaks.reminder?.n >= MAX_REMINDERS ? endBreak("skipped") : snooze());
card.append(stage, under);
const CARD_CSS = `
  .blob-card { width: 100%; height: 100%; display: flex; flex-direction: column; background: #101418; overflow: hidden; }
  .stage { flex: 1; min-height: 0; position: relative; }
  .stage canvas { position: absolute; inset: 0; width: 100% !important; height: 100% !important; display: block; }
  .under { flex: none; min-height: 50px; padding: 4px; box-sizing: border-box; display: grid; place-items: center; font: 13px/1.2 -apple-system, system-ui, sans-serif; color: #dde3e8; }
  .score { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: .02em; }
  .brk { display: grid; gap: 4px; justify-items: center; }
  .brk[hidden] { display: none; }
  .msg { font-size: 12px; font-weight: 600; text-align: center; }
  .btns { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; }   /* stack in a narrow window */
  .btns[hidden] { display: none; }
  .btns button { font: 11px -apple-system, system-ui, sans-serif; padding: 3px 7px; border-radius: 6px; border: 1px solid #3a4550; background: #26303a; color: #dde3e8; cursor: pointer; }
  .btns .go { background: #2f6b4f; border-color: #3d8a66; }
  .msg.count { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; color: #6fd39a; }`;
document.head.insertAdjacentHTML("beforeend", `<style>${CARD_CSS}
  .home-box { width: 170px; height: 210px; border-radius: 12px; overflow: hidden; border: 1px solid var(--line); }</style>`);

// ---- the floating window (Document Picture-in-Picture) ----
let pip = null;
function showHome() {   // the blob in this tab (no floating window open)
  const box = document.createElement("div");
  box.className = "home-box";
  box.append(card);
  const reopen = document.createElement("button");
  reopen.id = "reopen";
  reopen.textContent = "Float the blob";
  reopen.onclick = openFloat;
  reopen.hidden = !session.on || !("documentPictureInPicture" in window);
  $("home").replaceChildren(box, reopen);
  startLoop(window);
}
async function openFloat() {
  if (!("documentPictureInPicture" in window)) {
    status("This browser can't float the blob above other windows (needs Chrome or Edge). It's shown here instead.", true);
    return showHome();
  }
  if (pip) return pip.focus();
  try {
    pip = await documentPictureInPicture.requestWindow({ width: 170, height: 210, disallowReturnToOpener: true, preferInitialWindowPlacement: false });
  } catch (e) { status(`Couldn't open the floating window: ${e.message}`, true); return showHome(); }
  const d = pip.document;
  d.title = "Posture Buddy";
  d.head.insertAdjacentHTML("beforeend", `<style>html, body { margin: 0; height: 100%; background: #101418; overflow: hidden; } ${CARD_CSS}</style>`);
  d.body.append(card);
  $("home").replaceChildren();
  pip.addEventListener("pagehide", () => { pip = null; showHome(); });
  startLoop(pip);
}
function closeFloat() { if (pip) { const w = pip; pip = null; w.close(); } showHome(); }

// Draws in whichever window shows the blob: the floating window keeps animating while this tab is in the background.
// Time comes from this page's clock, never the frame's timestamp: the floating window's clock starts at 0 when it opens,
// so mixing the two made the jelly's springs jump (the blob flew around and zoomed for a moment as the window opened).
let loopToken = null, lastFrame = performance.now(), drawnSize = "";
function startLoop(win) {
  const token = loopToken = {};
  const frame = () => {
    if (token !== loopToken) return;
    win.requestAnimationFrame(frame);
    const now = performance.now(), dt = Math.min(Math.max((now - lastFrame) / 1000, 0), 0.1); lastFrame = now;
    // Follow the stage's size (the floating window lays out after it opens, and can be resized).
    const size = `${stage.clientWidth}x${stage.clientHeight}`;
    if (size !== drawnSize && stage.clientWidth && stage.clientHeight) { drawnSize = size; blob.resize(); }
    blob.setTarget(target());
    blob.setMood(run.joy, run.distress);
    blob.step(dt, now / 1000);
    // Movement break: the blob travels in a circle (the camera moves the other way), pulled back a little to fit.
    view.circle += ((breaks.reminder ? 1 : 0) - view.circle) * (1 - Math.exp(-dt * 3));
    const a = now / 1000 * Math.PI * 2 / 2.2, r = 0.42 * view.circle;
    const cam = blob.camera, t = blob.controls.target;
    t.set(-r * Math.cos(a), view.y - r * Math.sin(a), 0);
    cam.position.set(t.x, t.y + 0.35, view.dist + 1.4 * view.circle);
    blob.render();
    renderUnder();
  };
  win.requestAnimationFrame(frame);
}

function target() {
  if (session.on && session.mode === "passive") return PASSIVE;
  return app.pipeline ? app.pipeline.liveTarget() : { ...NEUTRAL, wellbeing: SETTINGS.startHealth, confidence: app.seen ? 1 : 0 };
}

function renderUnder() {
  const r = breaks.reminder, praise = !r && Date.now() < breaks.praiseUntil;
  brkEl.hidden = !r && !praise;
  scoreEl.hidden = !brkEl.hidden;
  if (!brkEl.hidden) {
    const counting = !!r?.until;
    msgEl.className = counting ? "msg count" : "msg";
    msgEl.textContent = praise ? "Nice break!" : counting ? `${Math.max(0, Math.ceil((r.until - Date.now()) / 1000))}` : "Time to move!";
    btnsEl.hidden = praise || counting;
    if (!btnsEl.hidden) under.querySelector(".snooze").textContent = r.n >= MAX_REMINDERS ? "Skip" : SNOOZE_S >= 60 ? `Snooze ${Math.round(SNOOZE_S / 60)}m` : "Snooze";
    return;
  }
  const passive = session.on && session.mode === "passive";
  const s = run.shown;
  scoreEl.textContent = passive ? "" : s == null ? "–" : Math.round(s);
  scoreEl.style.color = s == null ? "#8b97a3" : s >= GOOD ? "#6fd39a" : s >= BAD ? "#f0c060" : "#f07a6a";
}

// ---- camera and pose ----
async function setSource(name) {
  app.srcName = name; app.baseline = null; app.pipeline = null; app.warmUntil = performance.now() + WARMUP_MS;
  if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
  if (name === "webcam") {
    status("Requesting camera…");
    try {
      video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: "user" }, audio: false });
      await video.play();
    } catch (e) { app.source = null; return status(`Camera unavailable: ${e.message}`, true); }
    app.source = video;
  } else {
    const img = new Image();
    img.src = `test-images/${name}.jpg`;
    await img.decode();
    app.source = img;
  }
  overlay.width = app.source.videoWidth || app.source.naturalWidth;
  overlay.height = app.source.videoHeight || app.source.naturalHeight;
  $("cam").classList.add("on");
  $("startBtn").textContent = "Camera on";
  $("startBtn").disabled = true;
  $("calBtn").disabled = false;
  status("Sit tall and comfortable, then press Calibrate.");
  controls();
}

let calTimer;
async function calibrate() {
  $("calBtn").disabled = true;
  // The pose model's first frame can take 10+ s (it compiles on the GPU): wait for it before the countdown.
  for (let i = 0; !app.poseWarm && i < 150; i++) { status("Starting the pose model…"); await new Promise(r => setTimeout(r, 200)); }
  if (app.srcName === "webcam") for (const n of [3, 2, 1]) { status(`Sit tall… ${n}`); await new Promise(r => setTimeout(r, 700)); }
  status("Hold still…");
  const start = Math.max(performance.now(), app.warmUntil);
  app.calib = { frames: [], results: 0, people: 0, from: start, until: start + CAL_SECONDS * 1000 };
  clearTimeout(calTimer);
  calTimer = setTimeout(finishCalibration, app.calib.until - performance.now() + 3000);
}
function finishCalibration() {
  const c = app.calib;
  if (!c) return;
  app.calib = null;
  clearTimeout(calTimer);
  $("calBtn").disabled = false;
  if (c.frames.length >= 5) {
    app.baseline = median(c.frames);
    newPipeline();
    $("calBtn").textContent = "Recalibrate";
    if (session.on) session.rec.event(sessionTime(), "calibrated", { baseline: app.baseline });
    status(session.on ? "Recalibrated ✓" : "Calibrated ✓ Enter the participant ID and start the session.");
  }
  else if (!c.results) status("The pose model isn't running. Reload the page and try again.", true);
  else if (!c.people) status("No one in view. Get your head and shoulders in the camera, then press Calibrate.", true);
  else status("Couldn't see your ears and shoulders clearly. Try again.", true);
  controls();
}
// A fresh pipeline for the current calibration; during a session its once-a-second rows are recorded.
function newPipeline() {
  app.pipeline = new PosturePipeline(app.baseline, {
    onSecond: row => {
      if (!session.on) return;
      session.rec.record({ ...row, t: +sessionTime().toFixed(3), mode: session.mode, live_score: run.slow == null ? "" : +(run.slow / 100).toFixed(4),
        joy: +run.joy.toFixed(3), distress: +run.distress.toFixed(3), break: breaks.reminder?.until ? 2 : breaks.reminder ? 1 : 0 });   // 1 asking, 2 on a break
    },
  });
}

let lastInfer = performance.now(), lastVideoTime = -1, inferring = false;
async function infer() {
  if (inferring) return;
  const now = performance.now(), dt = Math.min((now - lastInfer) / 1000, 1);
  lastInfer = now;
  const src = app.source;
  if (src === video) {
    if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;
  }
  let r;
  inferring = true;
  try { r = await engine.detect(src); } catch { return; } finally { inferring = false; }
  if (src !== app.source) return;
  app.poseWarm = true;
  if (app.calib) { app.calib.results++; if (r) app.calib.people++; }
  if (document.visibilityState === "visible") {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (src !== video) octx.drawImage(src, 0, 0);
    if (r) drawSkeleton(octx, r.lm);
  }
  let raw = null;
  if (r) {
    raw = extractFeatures(r.lm, r.world, overlay.width, overlay.height);
    if (app.calib && raw.conf > 0.6 && now >= app.calib.from) app.calib.frames.push(raw);
  } else app.warmUntil = now + WARMUP_MS;
  app.seen = !!raw && raw.conf >= SETTINGS.minConfidence;
  if (app.calib && now > app.calib.until) finishCalibration();
  app.pipeline?.push(now / 1000, raw);
  updateRun(dt);
}

// ---- rewards: how long the score has stayed above GOOD or below BAD ----
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const level = s => s < REWARD_S ? 0 : 0.35 + 0.65 * smoothstep(REWARD_S, FULL_S, s);
function updateRun(dt) {
  const p = app.pipeline, live = p?.liveSeen && p.live ? p.live.score * 100 : null;
  if (live == null) {
    run.absent += dt;
    if (run.absent > 3) run.shown = null;
    if (run.absent > ABSENT_S) run.good = run.bad = 0;
  } else {
    run.absent = 0;
    run.slow = run.slow == null ? live : run.slow + (1 - Math.exp(-dt / 10)) * (live - run.slow);
    run.shown = run.shown == null ? live : run.shown + (1 - Math.exp(-dt / 1.5)) * (live - run.shown);
    if (run.slow >= GOOD) { run.good += dt; run.offGood = 0; } else if ((run.offGood += dt) > GRACE_S) run.good = 0;
    if (run.slow < BAD) { run.bad += dt; run.offBad = 0; } else if ((run.offBad += dt) > GRACE_S) run.bad = 0;
  }
  const rewards = session.on && session.mode === "active";
  const joy = rewards ? level(run.good) : 0, distress = rewards ? level(run.bad) : 0;
  if (session.on) {
    if ((joy > 0) !== (run.joy > 0)) session.rec.event(sessionTime(), joy > 0 ? "good_run_reward_on" : "good_run_reward_off", { seconds: Math.round(run.good) });
    if ((distress > 0) !== (run.distress > 0)) session.rec.event(sessionTime(), distress > 0 ? "poor_run_distress_on" : "poor_run_distress_off", { seconds: Math.round(run.bad) });
  }
  run.joy = joy; run.distress = distress;
}

// ---- movement breaks ----
function checkBreak() {
  if (breaks.reminder?.until && Date.now() >= breaks.reminder.until) return endBreak("done");
  if (!session.on || !breaks.every || breaks.reminder || Date.now() < breaks.next) return;
  breaks.reminder = { n: breaks.count, at: Date.now() };
  const w = pip ?? window;   // the size of the window showing the blob, to check the prompt fits
  session.rec.event(sessionTime(), "break_reminder", { reminder: breaks.count, window: `${w.innerWidth}x${w.innerHeight}`, floating: !!pip });
  pip?.focus?.();
}
function startBreak() {
  const r = breaks.reminder;
  if (!r || r.until) return;
  r.until = Date.now() + BREAK_S * 1000;
  session.rec.event(sessionTime(), "break_started", { reminder: r.n, seconds: BREAK_S });
}
function snooze() {
  session.rec.event(sessionTime(), "break_snoozed", { reminder: breaks.reminder.n });
  breaks.count = breaks.reminder.n + 1;
  breaks.reminder = null;
  breaks.next = Date.now() + SNOOZE_S * 1000;
}
function endBreak(how) {
  if (!breaks.reminder) return;
  session.rec.event(sessionTime(), `break_${how}`, { reminder: breaks.reminder.n });
  breaks.reminder = null;
  if (how === "done") breaks.praiseUntil = Date.now() + 3000;
  breaks.count = 1;
  breaks.next = Date.now() + breaks.every * 60e3;
}

// ---- session ----
const sessionTime = () => (performance.now() - session.t0) / 1000;
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
async function startSession() {
  const pid = $("pid").value.trim(), every = Math.max(0, +$("breakMin").value || 0);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(pid)) return status("Enter a participant ID (letters, digits, - or _).", true);
  if (!app.baseline) return status("Calibrate first.", true);
  // Opened first: Chrome only allows it straight after a click.
  const floating = openFloat();
  status("Checking study storage…");
  try { await checkStorage(); }
  catch (e) {
    if (/study key/.test(e.message)) $("studyKey").hidden = false;
    await floating; closeFloat();
    return status(`Can't start: ${e.message}.`, true);
  }
  Object.assign(session, { on: true, pid, mode: mode(), t0: performance.now(), file: `companion_${stamp()}_${mode()}.jsonl` });
  session.rec = new Recorder(pid, session.file);
  try {
    await session.rec.open({ participant: pid, page: "companion", mode: session.mode, startedAt: new Date().toISOString(),
      breakEveryMin: every, snoozeMin: SNOOZE_S / 60, maxReminders: MAX_REMINDERS, goodAbove: GOOD, poorBelow: BAD, rewardAfterS: REWARD_S,
      W: overlay.width, H: overlay.height, source: app.srcName, model: engine.model, baseline: app.baseline, settings: SETTINGS });
  } catch (e) {
    session.on = false; await floating; closeFloat();
    return status(`Can't save study data (${e.message}).`, true);
  }
  Object.assign(breaks, { every, next: Date.now() + every * 60e3, reminder: null, count: 1 });
  Object.assign(run, { good: 0, bad: 0, offGood: 0, offBad: 0, joy: 0, distress: 0 });
  newPipeline();
  store("study.pid", pid); store("companion.breakMin", every);
  session.rec.event(0, "session_start", { mode: session.mode });
  await floating;
  status(`Session running · ${session.mode} · saving to ${session.pid}/${session.file}`);
  controls();
}
async function endSession() {
  if (!session.on) return;
  session.rec.event(sessionTime(), "session_end", {});
  session.on = false;
  breaks.reminder = null;
  run.joy = run.distress = 0;
  controls();
  status("Saving…");
  try { await session.rec.close(); status(`Session saved: ${session.pid}/${session.file}`); }
  catch (e) { status(`Saving failed: ${e.message}`, true); }
  closeFloat();
}

function controls() {
  for (const el of [$("pid"), $("breakMin"), $("modeActive"), $("modePassive")]) el.disabled = session.on;
  $("sessionBtn").disabled = !session.on && (!app.baseline || !engine.ready);
  $("sessionBtn").textContent = session.on ? "End session" : "Start session";
  $("sessionBtn").className = session.on ? "stop" : "primary";
  const reopen = $("reopen");
  if (reopen) reopen.hidden = !session.on || !("documentPictureInPicture" in window);
}

// Inference, rewards and breaks run off a worker's timer: a background tab's own timers slow to once a minute.
const ticker = new Worker(URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 33)"], { type: "text/javascript" })));
ticker.onmessage = () => {
  const now = performance.now();
  if (app.source && engine.ready && now - lastInfer >= 1000 / INFER_HZ - 5) infer();
  checkBreak();
};

// ---- storage: Cloudflare by default (the hosted site's own API; from this Mac, the hosted one), or data/ via serve.py ----
const local = LOCAL && q.get("save") === "local";
$("studyKey").value = store("study.key") || "";   // the same key the full app saved in this browser
const applyStorage = () => setStorage(local ? "local" : "cloud", $("studyKey").value.trim(), LOCAL && !local ? "https://posture-buddy.pages.dev" : "");
$("studyKey").onchange = () => { store("study.key", $("studyKey").value.trim()); applyStorage(); };
applyStorage();

// ---- wiring ----
$("pid").value = store("study.pid") || "";
$("breakMin").value = store("companion.breakMin") ?? 25;
$("startBtn").onclick = () => setSource("webcam");
$("calBtn").onclick = calibrate;
$("sessionBtn").onclick = () => (session.on ? confirm("End this session?") && endSession() : startSession());
addEventListener("beforeunload", e => { if (session.on) { e.preventDefault(); e.returnValue = ""; } });
addEventListener("pagehide", () => pip?.close());
showHome();

status("Loading pose model…");
await engine.load("lite");
$("startBtn").disabled = false;
status("Press Start camera.");
controls();
if (q.get("src")) { await setSource(q.get("src")); if (q.has("autocal")) calibrate(); }
