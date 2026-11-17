// Study mode: two 22-minute sessions per participant, one with the artifact passive (alive but not reacting) and one
// active (mirroring posture), in counterbalanced order.
//
// Every session records the tracked body landmarks (no video) to data/<participant>/session<N>.jsonl through the
// local server (serve.py). Scores are never taken from the live run: each session is re-scored from its recording
// against the participant's one calibration (taken before their active session), with the same pipeline the live
// display uses. So a passive first session, which has no calibration, is scored as soon as session 2 is calibrated.
//
// Files per participant (data/<participant>/):
//   session<N>.jsonl        header, events and ~15 landmark frames per second
//   calibration.json        the baseline used to score both sessions
//   session<N>_scored.csv   one row per second of the 22 minutes: presence, status (held, or why it was ignored),
//                           display health, 4 s average and held posture metrics
//   summary.json            per-session totals, plus each session's camera check, to spot a changed setup
import { extractFeatures, median } from "./posture.js";
import { PosturePipeline, SETTINGS, FIELDS } from "./pipeline.js";

export const STUDY = { sessionMinutes: 22, cameraCheckSeconds: 5 };
export const ORDERS = { A: ["passive", "active"], B: ["active", "passive"] };   // A: passive first
export const conditionFor = (order, session) => ORDERS[order][session - 1];
export const suggestedOrder = pid => (parseInt(pid.replace(/\D/g, ""), 10) || 0) % 2 === 1 ? "A" : "B";   // P01 = A, P02 = B

const dataUrl = (pid, file) => `data/${encodeURIComponent(pid)}/${file}`;
// mode: append; write (an existing file is kept as a .bak first: raw recordings, calibration); replace (derived files)
async function save(pid, file, body, mode = "write") {
  const r = await fetch(`${dataUrl(pid, file)}?mode=${mode}`, { method: "POST", body });
  if (!r.ok) throw new Error(`saving ${file}: HTTP ${r.status}`);
}
async function load(pid, file) {
  const r = await fetch(dataUrl(pid, file), { cache: "no-store" });
  return r.ok ? r : null;
}

// ---- recording ----
const r5 = x => Math.round(x * 1e5) / 1e5, r3 = x => Math.round(x * 1e3) / 1e3;

export class Recorder {
  constructor(pid, file) { Object.assign(this, { pid, file, lines: [], written: 0, error: null, timer: null, flushing: false }); }
  async open(header) {
    await save(this.pid, this.file, JSON.stringify({ type: "header", ...header }) + "\n", "write");
    this.timer = setInterval(() => this.flush(), 1000);
  }
  event(t, name, extra = {}) { this.lines.push(JSON.stringify({ type: "event", t: r3(t), name, ...extra })); }
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
    catch (e) { this.lines.unshift(...batch); this.error = e.message; }   // keep it and retry next second
    finally { this.flushing = false; }
  }
  async close() {
    clearInterval(this.timer);
    for (let i = 0; i < 20 && (this.lines.length || this.flushing); i++) { await this.flush(); if (this.lines.length) await new Promise(r => setTimeout(r, 250)); }
    if (this.lines.length) throw new Error(`could not save the last ${this.lines.length} records: ${this.error}`);
  }
}

// ---- re-scoring ----
function parseLog(text) {
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

// Re-scores every recorded session of a participant against their calibration and writes the CSVs and summary.
// Returns a short description of what was written.
export async function rescoreParticipant(pid) {
  const cal = await load(pid, "calibration.json");
  const calibration = cal ? await cal.json() : null;
  const summary = { participant: pid, scoredAt: new Date().toISOString(), calibration: calibration && { session: calibration.session, at: calibration.at, model: calibration.model }, settings: SETTINGS, sessions: {} };
  const done = [];
  for (const n of [1, 2]) {
    const r = await load(pid, `session${n}.jsonl`);
    if (!r) continue;
    const log = parseLog(await r.text());
    const info = { condition: log.header?.condition, order: log.header?.order, startedAt: log.header?.startedAt, cameraCheck: cameraCheck(log) };
    if (calibration) {
      const scored = scoreSession(log, calibration.baseline);
      if (scored) {
        const cols = ["participant", "session", "condition", "t", "present", "status", "health", ...["avg4", "held"].flatMap(p => FIELDS.map(k => `${p}_${k}`))];
        const meta = { participant: pid, session: n, condition: info.condition };
        const csv = [cols.join(","), ...scored.rows.map(row => cols.map(c => csvCell(meta[c] ?? row[c])).join(","))].join("\n") + "\n";
        await save(pid, `session${n}_scored.csv`, csv, "replace");
        Object.assign(info, scored.stats);
        done.push(`session ${n} (${info.condition}, ${scored.rows.length} s)`);
      } else info.note = "no timer start recorded: the session never began";
    } else info.note = "not scored yet: no calibration for this participant";
    summary.sessions[n] = info;
  }
  await save(pid, "summary.json", JSON.stringify(summary, null, 2), "replace");
  return done.length ? `Scored ${done.join(" and ")}` : calibration ? "No sessions recorded yet" : "Recorded; will be scored after calibration";
}

export async function loadCalibration(pid) {
  const r = await load(pid, "calibration.json");
  return r ? r.json() : null;
}
export const saveCalibration = (pid, data) => save(pid, "calibration.json", JSON.stringify(data, null, 2));
export const saveParticipant = (pid, data) => save(pid, "participant.json", JSON.stringify(data, null, 2), "replace");
export async function loadParticipant(pid) {
  const r = await load(pid, "participant.json");
  return r ? r.json() : null;
}
