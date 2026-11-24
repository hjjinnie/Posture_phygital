// Study mode: two 22-minute sessions per participant, one with the artifact passive (alive but not reacting) and one
// active (mirroring posture), in counterbalanced order.
//
// Every session records the tracked body landmarks (no video), saved either to Cloudflare (the hosted app's D1 database,
// through functions/api/data, protected by the study key) or to data/<participant>/ on this Mac through serve.py.
// The local app can save to Cloudflare too, so a session that drives the Pi screen still lands in the cloud.
// Scores are never taken from the live run: each session is re-scored from its recording
// against that session's own calibration (taken at its start, in passive and active sessions alike), with the same
// pipeline the live display uses. Sessions recorded before per-session calibration fall back to the participant's
// shared calibration.json, or to the other session's calibration.
//
// Files per participant (data/<participant>/ locally, or the same names in the cloud):
//   session<N>.jsonl        header, events and ~15 landmark frames per second
//   calibration_session<N>.json   the baseline taken at the start of session N, used to score it
//   calibration.json        (older recordings) one baseline shared by both sessions
//   session<N>_scored.csv   one row per second of the 22 minutes: presence, status (held, or why it was ignored),
//                           display health, 4 s average and held posture metrics
//   summary.json            per-session totals, plus each session's camera check, to spot a changed setup
import { extractFeatures, median } from "./posture.js";
import { PosturePipeline, SETTINGS, FIELDS } from "./pipeline.js";

export const STUDY = { sessionMinutes: 22, cameraCheckSeconds: 5 };
export const ORDERS = { A: ["passive", "active"], B: ["active", "passive"] };   // A: passive first
export const conditionFor = (order, session) => ORDERS[order][session - 1];
export const suggestedOrder = pid => (parseInt(pid.replace(/\D/g, ""), 10) || 0) % 2 === 1 ? "A" : "B";   // P01 = A, P02 = B

// ---- storage: Cloudflare ("cloud", needs the study key) or this Mac ("local", serve.py's data/ folder) ----
// Study keys are compared after the same clean-up on both sides (browser and Cloudflare), so invisible differences
// don't lock anyone out: Unicode normalised (NFKC), case ignored, zero-width characters dropped, any run of spaces
// (including non-breaking ones from copy-paste) counted as one space, and spaces at the ends trimmed.
export const normalizeKey = k => String(k || "").normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
  .replace(/\s+/g, " ").trim().toLowerCase();
// Shareable links carry the key after "#key=" (never sent to the server). Opening one saves the key in this browser
// (where the app and the dashboard both read it) and removes it from the address bar at once.
export const KEY_STORE = "posture-buddy.study.key";
export function takeKeyFromLink() {
  const m = location.hash.match(/(?:^#|&)key=([^&]*)/);
  if (!m) return null;
  const key = decodeURIComponent(m[1]);
  try { localStorage.setItem(KEY_STORE, key); } catch {}
  history.replaceState(null, "", location.pathname + location.search);
  return key;
}
export function shareLink(path, key) { return `${location.origin}${path}#key=${encodeURIComponent(key)}`; }
export async function copyShareLink(path, key) {
  const link = shareLink(path, key);
  try { await navigator.clipboard.writeText(link); return true; }
  catch { prompt("Copy this link (it includes the study key):", link); return false; }
}
export const STORAGE = { mode: "local", key: "", api: "" };
export function setStorage(mode, key = "", api = "") { Object.assign(STORAGE, { mode, key: normalizeKey(key), api }); }
const cloud = () => STORAGE.mode === "cloud";
const dataUrl = (pid, file) => cloud() ? `${STORAGE.api}/api/data/${encodeURIComponent(pid)}/${file}` : `data/${encodeURIComponent(pid)}/${file}`;
const auth = () => cloud() ? { "X-Study-Key": STORAGE.key } : {};
// Says exactly why cloud storage refused, so a problem on another computer can be told apart from a wrong key.
function failure(r, what) {
  const here = location.origin.startsWith("http") ? location.origin : "a file opened directly";
  if (r.status === 401) return new Error("the study key doesn't match the one set in Cloudflare (capitals and extra spaces don't matter, so check the letters and words; press Show to see what's typed)");
  if (r.status === 403) return new Error(`this address (${here}) isn't allowed to use study storage: open https://posture-buddy.pages.dev, or the local app at http://localhost:8785`);
  if (r.status === 503) return new Error("cloud storage isn't set up on this copy of the site: open https://posture-buddy.pages.dev");
  if (r.status === 404 || r.status === 405 || r.status === 501) return new Error(`there's no study storage at ${STORAGE.api || here}: open https://posture-buddy.pages.dev, or the local app at http://localhost:8785`);
  return new Error(`${what}: the server answered HTTP ${r.status}`);
}
// A fetch that never got an answer: blocked network, offline, or a key with characters browsers can't send.
function unreachable(e) {
  if (/ISO-8859-1|code point|header/i.test(e?.message || "")) return new Error("the study key contains a character browsers can't send (use letters, digits, spaces and simple punctuation)");
  return new Error(`can't reach Cloudflare from this computer (${e?.message || "network error"}): check the internet connection, VPN or network filter`);
}
// mode: append; write (an existing file is kept as a .bak first: raw recordings, calibration); replace (derived files)
async function save(pid, file, body, mode = "write") {
  const r = await fetch(`${dataUrl(pid, file)}?mode=${mode}`, { method: "POST", body, headers: auth() });
  if (!r.ok) throw failure(r, `saving ${file}`);
}
async function load(pid, file) {
  const r = await fetch(dataUrl(pid, file), { cache: "no-store", headers: auth() });
  if (r.status === 401 || r.status === 503) throw failure(r, `reading ${file}`);
  return r.ok ? r : null;
}
// Checks the storage works before a session starts. Resolves to a short description, or throws.
export async function checkStorage() {
  if (!cloud()) {
    const r = await fetch("__study_ping", { cache: "no-store" }).catch(() => null);
    if (!r?.ok) throw new Error("can't save on this Mac: run the app from serve.py");
    return "saving to this Mac (data/)";
  }
  let r;
  try { r = await fetch(`${STORAGE.api}/api/data/`, { cache: "no-store", headers: auth() }); }
  catch (e) { throw unreachable(e); }
  if (!r.ok) throw failure(r, "checking cloud storage");
  return `saving to Cloudflare (${(await r.json()).length} participants so far)`;
}
// The files a participant can have, for downloading.
export const PARTICIPANT_FILES = ["participant.json", "calibration_session1.json", "calibration_session2.json", "calibration.json", "session1.jsonl", "session2.jsonl",
  "session1_scored.csv", "session2_scored.csv", "summary.json"];
export async function downloadParticipant(pid) {
  let n = 0;
  for (const file of PARTICIPANT_FILES) {
    const r = await load(pid, file);
    if (!r) continue;
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(await r.blob()), download: `${pid}_${file}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    n++;
    await new Promise(res => setTimeout(res, 300));   // browsers drop rapid-fire downloads
  }
  return n;
}

// ---- recording ----
const r5 = x => Math.round(x * 1e5) / 1e5, r3 = x => Math.round(x * 1e3) / 1e3;

export class Recorder {
  constructor(pid, file) { Object.assign(this, { pid, file, lines: [], written: 0, error: null, timer: null, flushing: false }); }
  async open(header) {
    await save(this.pid, this.file, JSON.stringify({ type: "header", ...header }) + "\n", "write");
    this.timer = setInterval(() => this.flush(), cloud() ? 5000 : 1000);   // fewer, bigger writes to the cloud
  }
  event(t, name, extra = {}) { this.lines.push(JSON.stringify({ type: "event", t: r3(t), name, ...extra })); }
  record(o) { this.lines.push(JSON.stringify(o)); }   // any other line (the companion page's once-a-second rows)
  // r: a pose result {lm, world} or null when nobody was found.
  frame(t, r) {
    this.lines.push(JSON.stringify(r
      ? { t: r3(t), lm: r.lm.flatMap(p => [r5(p.x), r5(p.y), r5(p.z), r3(p.visibility ?? 1)]), w: r.world.flatMap(p => [r5(p.x), r5(p.y), r5(p.z)]) }
      : { t: r3(t), lm: null }));
  }
  async flush() {
    if (this.flushing || !this.lines.length) return;
    this.flushing = true;
    const batch = this.lines.splice(0);
    try { await save(this.pid, this.file, batch.join("\n") + "\n", "append"); this.written += batch.length; this.error = null; }
    catch (e) { this.lines.unshift(...batch); this.error = e.message; }   // keep it and retry next time
    finally { this.flushing = false; }
  }
  async close() {
    clearInterval(this.timer);
    for (let i = 0; i < 40 && (this.lines.length || this.flushing); i++) { await this.flush(); if (this.lines.length || this.flushing) await new Promise(r => setTimeout(r, 250)); }
    if (this.lines.length) throw new Error(`could not save the last ${this.lines.length} records: ${this.error}`);
  }
}

// ---- re-scoring ----
export function parseLog(text) {
  const out = { header: null, events: [], frames: [] };
  for (const line of text.split("\n")) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }   // a half-written last line after a crash
    if (o.type === "header") out.header = o;
    else if (o.type === "event") out.events.push(o);
    else out.frames.push(o);
  }
  return out;
}
const toLm = a => Array.from({ length: a.length / 4 }, (_, i) => ({ x: a[4 * i], y: a[4 * i + 1], z: a[4 * i + 2], visibility: a[4 * i + 3] }));
const toWorld = a => Array.from({ length: a.length / 3 }, (_, i) => ({ x: a[3 * i], y: a[3 * i + 1], z: a[3 * i + 2] }));
const featuresOf = (f, h) => f.lm ? extractFeatures(toLm(f.lm), toWorld(f.w), h.W, h.H) : null;
const csvCell = v => typeof v === "number" ? (Number.isInteger(v) ? v : +v.toFixed(4)) : /[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;

// Replays one session's 22 minutes through the pipeline. Returns {rows, stats}.
export function scoreSession(log, baseline) {
  const ev = name => log.events.find(e => e.name === name)?.t;
  const start = ev("timer_start"), end = ev("timer_end") ?? Infinity;
  if (start === undefined) return null;
  const rows = [];
  const pipe = new PosturePipeline(baseline, { onSecond: row => rows.push(row) });
  for (const f of log.frames) if (f.t >= start && f.t <= end) pipe.push(f.t, featuresOf(f, log.header));
  const held = rows.filter(r => r.status === "held");
  const avg = (list, k) => list.length ? list.reduce((a, r) => a + r[k], 0) / list.length : null;
  const count = s => rows.filter(r => r.status === s).length;
  const stats = {
    seconds: rows.length,
    presentShare: rows.length ? rows.filter(r => r.present).length / rows.length : 0,
    secondsHeld: held.length,
    secondsIgnored: { outOfView: count("absent"), stretchingOrReaching: count("arms"), movingQuickly: count("moving"),
      settlingBack: count("settling"), postureStillChanging: count("unsteady") },
    meanHeldScore: avg(held, "held_score"),
    secondsHeldPoor: held.filter(r => r.held_score < SETTINGS.goodScore).length,
    meanHealth: avg(rows, "health"), finalHealth: rows.at(-1)?.health ?? null,
  };
  return { rows, stats };
}

// Median raw features during a session's camera check: where the camera saw the person before anything started.
function cameraCheck(log) {
  const a = log.events.find(e => e.name === "camera_check_start")?.t, b = log.events.find(e => e.name === "camera_check_end")?.t;
  const feats = log.frames.filter(f => f.lm && f.t >= a && f.t <= b).map(f => featuresOf(f, log.header)).filter(f => f.conf > 0.6);
  if (!feats.length) return null;
  const m = median(feats);
  return { frames: feats.length, shoulderWidthPx: m.S, shoulderX: m.shX, shoulderY: m.shY, earY: m.earY, shoulderTiltDeg: m.shTilt, shoulderWidth3dM: m.Sw };
}

// Re-scores every recorded session of a participant against its calibration and writes the CSVs and summary.
// Each session uses, in order: its own calibration file, the calibration recorded in its log, the participant's
// shared calibration.json (older recordings), or the other session's calibration. Returns a short description.
export async function rescoreParticipant(pid) {
  const json = async f => { const r = await load(pid, f); return r ? r.json() : null; };
  const own = { 1: await json("calibration_session1.json"), 2: await json("calibration_session2.json") };
  const shared = await json("calibration.json");
  const logs = {};
  for (const n of [1, 2]) { const r = await load(pid, `session${n}.jsonl`); if (r) logs[n] = parseLog(await r.text()); }
  const fromLog = n => logs[n]?.events.find(e => e.name === "calibrated" && e.baseline)?.baseline;
  const pickBaseline = n => own[n]?.baseline ? [own[n].baseline, `session ${n}`]
    : fromLog(n) ? [fromLog(n), `session ${n}`]
    : shared?.baseline ? [shared.baseline, `shared (session ${shared.session})`]
    : own[3 - n]?.baseline ? [own[3 - n].baseline, `session ${3 - n}`]
    : fromLog(3 - n) ? [fromLog(3 - n), `session ${3 - n}`] : [null, null];
  const summary = { participant: pid, scoredAt: new Date().toISOString(), settings: SETTINGS, sessions: {} };
  const done = [];
  for (const n of [1, 2]) {
    const log = logs[n];
    if (!log) continue;
    const [baseline, calibratedFrom] = pickBaseline(n);
    const info = { condition: log.header?.condition, order: log.header?.order, startedAt: log.header?.startedAt, cameraCheck: cameraCheck(log), calibratedFrom };
    if (baseline) {
      const scored = scoreSession(log, baseline);
      if (scored) {
        const cols = ["participant", "session", "condition", "t", "present", "status", "health", ...["avg4", "held"].flatMap(p => FIELDS.map(k => `${p}_${k}`))];
        const meta = { participant: pid, session: n, condition: info.condition };
        const csv = [cols.join(","), ...scored.rows.map(row => cols.map(c => csvCell(meta[c] ?? row[c])).join(","))].join("\n") + "\n";
        await save(pid, `session${n}_scored.csv`, csv, "replace");
        Object.assign(info, scored.stats);
        done.push(`session ${n} (${info.condition}, ${scored.rows.length} s)`);
      } else info.note = "no timer start recorded: the session never began";
    } else info.note = "not scored yet: no calibration for this session";
    summary.sessions[n] = info;
  }
  await save(pid, "summary.json", JSON.stringify(summary, null, 2), "replace");
  return done.length ? `Scored ${done.join(" and ")}` : Object.keys(logs).length ? "Recorded; not scored (no calibration)" : "No sessions recorded yet";
}

export const saveCalibration = (pid, session, data) => save(pid, `calibration_session${session}.json`, JSON.stringify(data, null, 2));
export const saveParticipant = (pid, data) => save(pid, "participant.json", JSON.stringify(data, null, 2), "replace");
export async function loadParticipant(pid) {
  const r = await load(pid, "participant.json");
  return r ? r.json() : null;
}

// ---- companion sessions (chrome.html) ----
// Each companion session's recording (companion_<date-time>_<mode>.jsonl) gets a small summary beside it
// (companion_<date-time>_<mode>.summary.json), rewritten every minute while it runs, which the dashboard reads.
// Score: the live posture score as a 10 s average (what the companion's rewards follow), 0-1, over time in view.
export const companionSummaryFile = file => file.replace(/\.jsonl$/, ".summary.json");
export const saveCompanionSummary = (pid, file, summary) => save(pid, companionSummaryFile(file), JSON.stringify(summary), "replace");
export function summarizeCompanion({ header, events, frames }, file = "") {
  const rows = frames.filter(r => r.status !== undefined);
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const share = (a, f) => a.length ? a.filter(f).length / a.length : null;
  const count = name => events.filter(e => e.name === name).length;
  const live = rows.filter(r => r.present === 1 && r.live_score !== "" && r.live_score != null).map(r => +r.live_score);
  const held = rows.filter(r => r.status === "held" && r.held_score !== "" && r.held_score != null).map(r => +r.held_score);
  const minutes = [];
  for (const r of rows) {
    const m = minutes[Math.max(0, Math.floor((r.t - 0.001) / 60))] ??= { n: 0, present: 0, sum: 0, k: 0 };
    m.n++;
    if (r.present === 1) m.present++;
    if (r.present === 1 && r.live_score !== "" && r.live_score != null) { m.sum += +r.live_score; m.k++; }
  }
  const seconds = Math.max(rows.at(-1)?.t ?? 0, events.at(-1)?.t ?? 0);
  return {
    participant: header?.participant, file, mode: header?.mode, startedAt: header?.startedAt,
    seconds: Math.round(seconds), ended: events.some(e => e.name === "session_end"), breakEveryMin: header?.breakEveryMin ?? null,
    presentShare: share(rows, r => r.present === 1),
    meanScore: mean(live), goodShare: share(live, v => v >= (header?.goodAbove ?? 90) / 100), poorShare: share(live, v => v < (header?.poorBelow ?? 75) / 100),
    meanHeldScore: mean(held),
    joySeconds: rows.filter(r => r.joy > 0).length, distressSeconds: rows.filter(r => r.distress > 0).length,
    breaks: { reminders: count("break_reminder"), started: count("break_started"), done: count("break_done"), snoozed: count("break_snoozed"), skipped: count("break_skipped") },
    minutes: Array.from(minutes, m => m ? { score: m.k ? +(m.sum / m.k).toFixed(4) : null, present: +(m.present / m.n).toFixed(3) } : { score: null, present: 0 }),
    breakEvents: events.filter(e => e.name.startsWith("break_")).map(e => ({ t: Math.round(e.t), name: e.name.slice(6) })),
    updatedAt: new Date().toISOString(),
  };
}
