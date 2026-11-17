// Posture study dashboard (dashboard.html): every participant's sessions, read from the study data API
// (functions/api/data) with the study key. Scores are the study model's held posture score (0-100, 100 = the
// participant's calibrated posture), from each session's summary.json and scored CSV.
const q = new URLSearchParams(location.search);
const LOCAL = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
const API = q.has("api") ? q.get("api") : LOCAL ? "https://posture-buddy.pages.dev" : "";
const KEY_STORE = "posture-buddy.study.key";   // shared with the app's study panel
const $ = id => document.getElementById(id);
const SVGNS = "http://www.w3.org/2000/svg";
const COLOR = { passive: "var(--passive)", active: "var(--active)" };
const pct = x => x == null ? "–" : `${Math.round(x * 100)}%`;
const score = x => x == null ? "–" : Math.round(x * 100);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let key = "";
try { key = localStorage.getItem(KEY_STORE) || ""; } catch {}
$("key").value = key;

async function api(path, as = "json") {
  const r = await fetch(`${API}/api/data/${path}`, { headers: { "X-Study-Key": key }, cache: "no-store" });
  if (r.status === 401) throw new Error("wrong or missing study key");
  if (r.status === 503) throw new Error("study storage isn't set up yet");
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return as === "json" ? r.json() : r.text();
}

// ---- data ----
// For each participant: order, and per session (by condition) the summary stats.
async function loadAll() {
  const list = await api("");
  const people = await Promise.all(list.map(async ({ participant }) => {
    const [info, summary] = await Promise.all([api(`${participant}/participant.json`), api(`${participant}/summary.json`)]);
    const sessions = {};
    for (const [n, s] of Object.entries(summary?.sessions ?? {})) {
      sessions[s.condition] = {
        n: +n, condition: s.condition, scored: s.seconds != null, startedAt: s.startedAt,
        score: s.meanHeldScore, poor: s.secondsHeld ? s.secondsHeldPoor / s.secondsHeld : null,
        ignored: s.seconds ? (s.seconds - s.secondsHeld) / s.seconds : null, present: s.presentShare,
        seconds: s.seconds, ignoredBy: s.secondsIgnored, meanHealth: s.meanHealth, finalHealth: s.finalHealth,
        cameraCheck: s.cameraCheck, note: s.note,
      };
    }
    return { pid: participant, order: info?.order ?? "?", calibratedIn: summary?.calibration?.session, sessions };
  }));
  return people.sort((a, b) => a.pid.localeCompare(b.pid, undefined, { numeric: true }));
}

// ---- tooltip ----
function tooltip(container) {
  const tip = Object.assign(document.createElement("div"), { className: "tip" });
  container.append(tip);
  return {
    show(html, x, y) {
      tip.innerHTML = html; tip.style.display = "block";
      const w = container.clientWidth, tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(0, x + 12), w - tw)}px`; tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
    },
    hide() { tip.style.display = "none"; },
  };
}
const el = (name, attrs = {}, parent) => {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.append(e);
  return e;
};

// ---- overview tiles ----
function renderTiles(people) {
  const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const p = people.map(x => x.sessions.passive?.score).filter(x => x != null);
  const a = people.map(x => x.sessions.active?.score).filter(x => x != null);
  const paired = people.filter(x => x.sessions.passive?.score != null && x.sessions.active?.score != null);
  const diff = mean(paired.map(x => x.sessions.active.score - x.sessions.passive.score));
  const scored = people.reduce((n, x) => n + Object.values(x.sessions).filter(s => s.scored).length, 0);
  const tile = (label, value, note = "") => `<div class="card tile"><div class="label">${label}</div><div class="value">${value}</div><div class="note">${note}</div></div>`;
  $("tiles").innerHTML =
    tile("Participants", people.length, `${paired.length} with both sessions scored`) +
    tile("Sessions scored", scored) +
    tile("Mean score, passive", score(mean(p)), `${p.length} sessions`) +
    tile("Mean score, active", score(mean(a)), `${a.length} sessions`) +
    tile("Active − passive", diff == null ? "–" : `${diff >= 0 ? "+" : "−"}${Math.abs(Math.round(diff * 100))}`, "mean within participant, points");
}

// ---- dumbbell: passive vs active mean score per participant ----
function renderDumbbell(people) {
  const box = $("dumbbell");
  box.replaceChildren();
  const rows = people.filter(x => x.sessions.passive?.score != null || x.sessions.active?.score != null);
  if (!rows.length) { box.innerHTML = `<p class="muted">No scored sessions yet.</p>`; return; }
  const all = rows.flatMap(x => [x.sessions.passive?.score, x.sessions.active?.score]).filter(v => v != null);
  const lo = Math.min(0.5, Math.floor(Math.min(...all) * 10) / 10), hi = 1;
  const W = 1000, L = 90, R = 24, RH = 30, T = 8, H = T + rows.length * RH + 28;
  const X = v => L + (v - lo) / (hi - lo) * (W - L - R);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Mean posture score per participant, passive vs active" }, box);
  for (let v = Math.ceil(lo * 10) / 10; v <= hi + 1e-9; v += 0.1) {
    el("line", { x1: X(v), x2: X(v), y1: T, y2: H - 22, stroke: "var(--grid)", "stroke-width": 1 }, svg);
    el("text", { x: X(v), y: H - 6, "text-anchor": "middle" }, svg).textContent = Math.round(v * 100);
  }
  const tip = tooltip(box);
  rows.forEach((p, i) => {
    const y = T + i * RH + RH / 2, ps = p.sessions.passive?.score, as = p.sessions.active?.score;
    el("text", { x: L - 12, y: y + 4, "text-anchor": "end", class: "label-strong" }, svg).textContent = p.pid;
    if (ps != null && as != null) el("line", { x1: X(ps), x2: X(as), y1: y, y2: y, stroke: "var(--text-muted)", "stroke-width": 2, "stroke-linecap": "round" }, svg);
    for (const cond of ["passive", "active"]) {
      const s = p.sessions[cond];
      if (s?.score == null) continue;
      const dot = el("circle", { cx: X(s.score), cy: y, r: 6, fill: COLOR[cond], stroke: "var(--surface-1)", "stroke-width": 2 }, svg);
      const hit = el("circle", { cx: X(s.score), cy: y, r: 14, fill: "transparent", style: "cursor:pointer" }, svg);
      hit.addEventListener("mousemove", e => {
        const r = box.getBoundingClientRect();
        tip.show(`<b>${esc(p.pid)}</b> · ${cond} (session ${s.n})<br><span class="k">Mean score</span> ${score(s.score)} · <span class="k">poor posture</span> ${pct(s.poor)}<br><span class="k">ignored</span> ${pct(s.ignored)} · <span class="k">in view</span> ${pct(s.present)}`, e.clientX - r.left, e.clientY - r.top);
        dot.setAttribute("r", 7);
      });
      hit.addEventListener("mouseleave", () => { tip.hide(); dot.setAttribute("r", 6); });
      hit.addEventListener("click", () => showDetail(p));
    }
  });
}

// ---- table (also the accessible view of the chart) ----
function renderTable(people) {
  const status = p => {
    const s = Object.values(p.sessions);
    if (!s.length) return "no sessions";
    if (!p.calibratedIn) return `session ${s.map(x => x.n).join(", ")} recorded; awaiting calibration`;
    return s.length === 2 ? "both sessions scored" : `session ${s[0].n} scored`;
  };
  const cell = (s, f) => s ? f(s) : "–";
  $("table").innerHTML = `<thead><tr><th>Participant</th><th>Order</th><th>Passive score</th><th>Passive poor</th>
    <th>Active score</th><th>Active poor</th><th>Active − passive</th><th>Status</th></tr></thead><tbody>` +
    people.map(p => {
      const ps = p.sessions.passive, as = p.sessions.active;
      const d = ps?.score != null && as?.score != null ? Math.round((as.score - ps.score) * 100) : null;
      return `<tr data-pid="${esc(p.pid)}"><td>${esc(p.pid)}</td><td>${p.order === "A" ? "A: passive → active" : p.order === "B" ? "B: active → passive" : "?"}</td>
        <td>${cell(ps, s => score(s.score))}</td><td>${cell(ps, s => pct(s.poor))}</td>
        <td>${cell(as, s => score(s.score))}</td><td>${cell(as, s => pct(s.poor))}</td>
        <td>${d == null ? "–" : (d >= 0 ? "+" : "−") + Math.abs(d)}</td><td class="muted">${status(p)}</td></tr>`;
    }).join("") + `</tbody>`;
  $("table").querySelectorAll("tbody tr").forEach(tr => tr.onclick = () => showDetail(people.find(p => p.pid === tr.dataset.pid)));
}

// ---- detail: one participant, any metric over time for each session ----
function parseCsv(text) {
  const [head, ...lines] = text.trim().split("\n");
  const cols = head.split(",");
  return lines.map(l => { const v = l.split(","); return Object.fromEntries(cols.map((c, i) => [c, v[i]])); });
}

// Metrics in the scored CSVs. kind: "pct" (0..1 shown as 0-100) or "deg" (signed degrees).
const METRICS = {
  score:        { label: "Posture score", kind: "pct", note: "100 = their calibrated posture; higher is better" },
  sevTrunk:     { label: "Trunk slump", kind: "pct", note: "0 = as calibrated, 100 = clearly slumped or reclined; lower is better" },
  sevStack:     { label: "Ear–shoulder–hip stack", kind: "pct", note: "0 = as calibrated, 100 = clearly out of line; lower is better" },
  sevLateral:   { label: "Side balance", kind: "pct", note: "0 = as calibrated, 100 = clearly leaning to one side; lower is better" },
  sevHead:      { label: "Forward head", kind: "pct", note: "0 = as calibrated, 100 = clearly forward; lower is better" },
  sevShoulders: { label: "Shoulders", kind: "pct", note: "0 = as calibrated, 100 = clearly rounded forward or raised; lower is better" },
  health:       { label: "Display health", kind: "pct", noSource: true, note: "the study model's display health (linear decline, recovery); higher is better" },
  headRoll:     { label: "Head tilt", kind: "deg", note: "degrees from calibration; + = tipped to the participant's right" },
  shoulderTilt: { label: "Shoulder tilt", kind: "deg", note: "degrees from calibration; + = right shoulder lower" },
};
const DIMENSIONS = ["sevTrunk", "sevStack", "sevLateral", "sevHead", "sevShoulders"];
const view = { p: null, sessions: [], metric: "score", source: "held", bin: 15, all: false };
$("metric").innerHTML = Object.entries(METRICS).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join("");

// Mean of a metric per time bin. Held: only seconds the study model counted; 4 s average: every second in view.
function series(metric, source, bin) {
  const m = METRICS[metric];
  return view.sessions.map(s => {
    const col = m.noSource ? metric : `${source}_${metric}`, out = [];
    for (const r of s.rows) {
      const b = Math.floor((+r.t - 1) / bin);
      out[b] ??= { sum: 0, n: 0 };
      const ok = m.noSource ? true : source === "held" ? r.status === "held" : r.present === "1";
      if (ok && r[col] !== "" && r[col] != null) { out[b].sum += +r[col]; out[b].n++; }
    }
    return { cond: s.cond, n: s.n, points: Array.from(out, (x, i) => ({ min: (i * bin + bin / 2) / 60, v: x && x.n ? x.sum / x.n : null })) };
  });
}

async function showDetail(p) {
  $("detail").hidden = false;
  $("table").querySelectorAll("tbody tr").forEach(tr => tr.classList.toggle("sel", tr.dataset.pid === p.pid));
  $("detailTitle").textContent = `${p.pid} · order ${p.order === "A" ? "A (passive → active)" : p.order === "B" ? "B (active → passive)" : "?"}`;
  $("timeline").innerHTML = `<p class="muted">Loading…</p>`;
  view.p = p; view.sessions = [];
  for (const cond of ["passive", "active"]) {
    const s = p.sessions[cond];
    if (!s?.scored) continue;
    const text = await api(`${p.pid}/session${s.n}_scored.csv`, "text").catch(() => null);
    if (text) view.sessions.push({ cond, n: s.n, rows: parseCsv(text) });
  }
  renderDetailCharts();
  renderSessionCards(p);
  $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDetailCharts() {
  const m = METRICS[view.metric];
  $("source").disabled = view.all ? false : !!m.noSource;
  $("metric").disabled = view.all;
  const gaps = view.source === "held" ? "Gaps are moments the study model ignored (out of view, stretching or reaching, moving quickly, settling back)." : "Gaps are moments nobody was in view.";
  const res = view.bin >= 60 ? "1 min" : `${view.bin} s`;
  $("timeline").hidden = view.all; $("multiples").hidden = !view.all;
  if (view.all) {
    $("metricNote").textContent = `Each posture dimension, 0 = as calibrated, 100 = clearly off; lower is better. Averaged over ${res}. ${gaps}`;
    $("multiples").replaceChildren(...DIMENSIONS.map(k => {
      const cell = Object.assign(document.createElement("div"), { className: "chart" });
      cell.innerHTML = `<div class="mtitle">${METRICS[k].label}</div>`;
      drawLine(cell, series(k, view.source, view.bin), k, view.bin, { height: 190, compact: true });
      return cell;
    }));
  } else {
    $("metricNote").textContent = `${m.label}: ${m.note}. Averaged over ${res}. ${m.noSource ? "" : gaps}`;
    $("timeline").replaceChildren();
    drawLine($("timeline"), series(view.metric, view.source, view.bin), view.metric, view.bin, { height: 300 });
  }
}

// One line chart: both sessions over the 22 minutes, with a crosshair tooltip.
function drawLine(box, data, metric, bin, { height, compact = false }) {
  const m = METRICS[metric];
  if (!data.length) { box.insertAdjacentHTML("beforeend", `<p class="muted">No scored sessions for this participant yet.</p>`); return; }
  const vals = data.flatMap(s => s.points.map(p => p.v)).filter(v => v != null);
  if (!vals.length) { box.insertAdjacentHTML("beforeend", `<p class="muted">No data for this metric.</p>`); return; }
  let lo, hi, step;
  if (m.kind === "deg") {
    const a = Math.max(10, Math.ceil(Math.max(...vals.map(Math.abs)) / 5) * 5);
    lo = -a; hi = a; step = a / 2;
  } else if (metric === "score" || metric === "health") {
    lo = Math.min(metric === "health" ? 0 : 0.5, Math.floor(Math.min(...vals) * 10) / 10); hi = 1; step = (hi - lo) > 0.6 ? 0.2 : 0.1;
  } else {
    lo = 0; hi = Math.max(0.3, Math.ceil(Math.max(...vals) * 10) / 10); step = hi > 0.6 ? 0.2 : 0.1;
  }
  const fmt = v => m.kind === "deg" ? `${v > 0 ? "+" : ""}${Math.round(v)}°` : `${Math.round(v * 100)}`;
  const maxMin = Math.max(22, ...data.flatMap(s => s.points.map(p => p.min)));
  const W = compact ? 520 : 1000, H = height, L = compact ? 40 : 40, R = compact ? 12 : 70, T = 10, B = 28;   // small charts drawn at their real size, so text stays legible
  const X = mm => L + mm / maxMin * (W - L - R), Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${m.label} over each session` }, box);
  for (let v = lo; v <= hi + 1e-9; v += step) {
    el("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: v === 0 && m.kind === "deg" ? "var(--text-muted)" : "var(--grid)", "stroke-width": 1 }, svg);
    el("text", { x: L - 8, y: Y(v) + 4, "text-anchor": "end" }, svg).textContent = fmt(v);
  }
  for (let mm = 0; mm <= maxMin; mm += compact ? 4 : 2) el("text", { x: X(mm), y: H - 6, "text-anchor": "middle" }, svg).textContent = `${mm} min`;
  for (const s of data) {
    let d = "", pen = false;
    for (const p of s.points) {
      if (p.v == null) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${X(p.min).toFixed(1)},${Y(p.v).toFixed(1)}`; pen = true;
    }
    el("path", { d, fill: "none", stroke: COLOR[s.cond], "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    const last = [...s.points].reverse().find(p => p.v != null);
    if (last && !compact) el("text", { x: X(last.min) + 8, y: Y(last.v) + 4, class: "label-strong" }, svg).textContent = s.cond;   // direct label
  }
  const cross = el("line", { y1: T, y2: H - B, stroke: "var(--text-muted)", "stroke-width": 1, visibility: "hidden" }, svg);
  const marks = data.map(s => el("circle", { r: 5, fill: COLOR[s.cond], stroke: "var(--surface-1)", "stroke-width": 2, visibility: "hidden" }, svg));
  const hit = el("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" }, svg);
  const tip = tooltip(box);
  hit.addEventListener("mousemove", e => {
    const r = svg.getBoundingClientRect(), mx = (e.clientX - r.left) / r.width * W;
    const i = Math.max(0, Math.round(((mx - L) / (W - L - R) * maxMin * 60 - bin / 2) / bin));
    const mm = (i * bin + bin / 2) / 60;
    cross.setAttribute("x1", X(mm)); cross.setAttribute("x2", X(mm)); cross.setAttribute("visibility", "visible");
    let html = `<b>${m.label} · ${Math.floor(mm)}:${String(Math.round((mm % 1) * 60)).padStart(2, "0")}</b>`;
    data.forEach((s, k) => {
      const p = s.points[i];
      if (p?.v != null) { marks[k].setAttribute("cx", X(p.min)); marks[k].setAttribute("cy", Y(p.v)); marks[k].setAttribute("visibility", "visible"); }
      else marks[k].setAttribute("visibility", "hidden");
      html += `<br><span class="k">${s.cond} (session ${s.n})</span> ${p?.v != null ? fmt(p.v) : "–"}`;
    });
    const br = box.getBoundingClientRect();
    tip.show(html, e.clientX - br.left, e.clientY - br.top);
  });
  hit.addEventListener("mouseleave", () => { tip.hide(); cross.setAttribute("visibility", "hidden"); marks.forEach(c => c.setAttribute("visibility", "hidden")); });
}

$("metric").onchange = e => { view.metric = e.target.value; renderDetailCharts(); };
$("source").onchange = e => { view.source = e.target.value; renderDetailCharts(); };
$("bin").onchange = e => { view.bin = +e.target.value; renderDetailCharts(); };
$("allMetrics").onchange = e => { view.all = e.target.checked; renderDetailCharts(); };

function renderSessionCards(p) {
  const card = cond => {
    const s = p.sessions[cond];
    if (!s) return `<div class="card"><h3><i style="background:${COLOR[cond]}"></i>${cond}</h3><p class="muted">Not recorded yet.</p></div>`;
    const ig = s.ignoredBy || {}, mins = x => x == null ? "–" : `${(x / 60).toFixed(1)} min`;
    const cc = s.cameraCheck;
    return `<div class="card"><h3><i style="background:${COLOR[cond]}"></i>${cond} · session ${s.n}</h3>
      ${s.scored ? `<div class="kv">
        <span>Mean score</span><span>${score(s.score)}</span>
        <span>Poor posture (of held time)</span><span>${pct(s.poor)}</span>
        <span>In view</span><span>${pct(s.present)}</span>
        <span>Ignored: out of view</span><span>${mins(ig.outOfView)}</span>
        <span>Ignored: stretching or reaching</span><span>${mins(ig.stretchingOrReaching)}</span>
        <span>Ignored: moving quickly</span><span>${mins(ig.movingQuickly)}</span>
        <span>Display health, mean / end</span><span>${score(s.meanHealth)} / ${score(s.finalHealth)}</span>
        <span>Camera check: shoulder width</span><span>${cc ? `${Math.round(cc.shoulderWidthPx)} px` : "–"}</span>
      </div>` : `<p class="muted">${esc(s.note || "Not scored yet.")}</p>`}
      ${s.startedAt ? `<p class="sub" style="margin-top:8px">Started ${new Date(s.startedAt).toLocaleString()}</p>` : ""}</div>`;
  };
  $("sessionCards").innerHTML = card("passive") + card("active");
}

// ---- load ----
async function refresh() {
  if (!key) { $("status").innerHTML = `<span class="error">Enter the study key.</span>`; return; }
  $("status").textContent = "Loading…";
  try {
    const people = await loadAll();
    renderTiles(people); renderDumbbell(people); renderTable(people);
    $("status").textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    $("status").innerHTML = `<span class="error">${esc(e.message)}</span>`;
  }
}
$("key").onchange = () => { key = $("key").value.trim(); try { localStorage.setItem(KEY_STORE, key); } catch {} refresh(); };
$("refresh").onclick = refresh;
refresh();
