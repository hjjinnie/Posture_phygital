// Study data API for Posture Buddy (Cloudflare Pages Function + D1), the cloud twin of serve.py's /data/ endpoints:
//   POST /api/data/<participant>/<file>?mode=append|write|replace
//        append adds to the file; write starts it afresh, first keeping any existing file as <file>.<time>.bak;
//        replace starts it afresh without a backup (files the app regenerates, like the scored CSVs)
//   GET  /api/data/<participant>/<file>   the file, or 404
//   GET  /api/data/<participant>/         the participant's files: [{ name, bytes, updated }]
//   GET  /api/data/                       participants: [{ participant, files, updated }]
// Every request needs the header X-Study-Key equal to the STUDY_KEY secret, which is set in Cloudflare, never in code.
// Requests are accepted from this site and from the local app (http://localhost:<port>), so a session run locally
// (for the Pi screen) can save here too.
const PID = /^[A-Za-z0-9_-]{1,40}$/, FILE = /^[A-Za-z0-9_.-]{1,80}\.(?:jsonl|csv|json)$/;
const MAX_BODY = 32 << 20;
const CHUNK = 1_500_000;   // D1 keeps values under 2 MB, so bigger bodies are stored as several rows
const TYPES = { jsonl: "application/x-ndjson", csv: "text/csv", json: "application/json" };

let schema = null;
const ensureSchema = db => schema ??= db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, pid TEXT NOT NULL, file TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS chunks_file ON chunks (pid, file, id)"),
]).catch(e => { schema = null; throw e; });

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const self = new URL(request.url).origin;
  const ok = !origin || origin === self || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  return ok ? { "Access-Control-Allow-Origin": origin || self, "Access-Control-Allow-Headers": "X-Study-Key, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "86400", Vary: "Origin" } : null;
}

// Study keys are compared after the same clean-up on both sides (browser and Cloudflare), so invisible differences
// don't lock anyone out: Unicode normalised (NFKC), case ignored, zero-width characters dropped, any run of spaces
// (including non-breaking ones from copy-paste) counted as one space, and spaces at the ends trimmed.
const normalizeKey = k => String(k || "").normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
  .replace(/\s+/g, " ").trim().toLowerCase();
// Constant-time comparison, so response timing reveals nothing about the key.
function sameKey(a, b) {
  const x = new TextEncoder().encode(normalizeKey(a)), y = new TextEncoder().encode(normalizeKey(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function onRequest({ request, env, params }) {
  const cors = corsHeaders(request);
  const reply = (body, status = 200, headers = {}) => new Response(body, { status, headers: { ...(cors || {}), "Cache-Control": "no-store", ...headers } });
  if (!cors) return reply("origin not allowed", 403);
  if (request.method === "OPTIONS") return reply(null, 204);
  if (!env.STUDY_KEY) return reply("study storage isn't set up: no STUDY_KEY secret", 503);
  if (!env.DB) return reply("study storage isn't set up: no DB binding", 503);
  if (!sameKey(request.headers.get("X-Study-Key"), env.STUDY_KEY)) return reply("wrong or missing study key", 401);
  await ensureSchema(env.DB);

  const [pid, file, extra] = params.path || [];
  if (extra !== undefined || (pid && !PID.test(pid)) || (file && !FILE.test(file))) return reply("bad path", 400);
  const db = env.DB, json = o => reply(JSON.stringify(o), 200, { "Content-Type": "application/json" });

  if (request.method === "GET") {
    if (!pid) {
      const { results } = await db.prepare("SELECT pid AS participant, COUNT(DISTINCT file) AS files, MAX(at) AS updated FROM chunks GROUP BY pid ORDER BY pid").all();
      return json(results);
    }
    if (!file) {
      const { results } = await db.prepare("SELECT file AS name, SUM(LENGTH(body)) AS bytes, MAX(at) AS updated FROM chunks WHERE pid = ? GROUP BY file ORDER BY file").bind(pid).all();
      return json(results);
    }
    const { results } = await db.prepare("SELECT body FROM chunks WHERE pid = ? AND file = ? ORDER BY id").bind(pid, file).all();
    if (!results.length) return reply("not found", 404);
    return reply(results.map(r => r.body).join(""), 200, { "Content-Type": `${TYPES[file.split(".").pop()]}; charset=utf-8` });
  }

  if (request.method === "POST" && pid && file) {
    const mode = new URL(request.url).searchParams.get("mode") || "append";
    if (!["append", "write", "replace"].includes(mode)) return reply("bad mode", 400);
    const body = await request.text();
    if (body.length > MAX_BODY) return reply("too large", 413);
    const at = new Date().toISOString(), stmts = [];
    if (mode === "write") {
      const stamp = at.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      stmts.push(db.prepare("UPDATE chunks SET file = ? WHERE pid = ? AND file = ?").bind(`${file}.${stamp}.bak`, pid, file));
    } else if (mode === "replace") {
      stmts.push(db.prepare("DELETE FROM chunks WHERE pid = ? AND file = ?").bind(pid, file));
    }
    for (let i = 0; i < body.length || i === 0; i += CHUNK)
      stmts.push(db.prepare("INSERT INTO chunks (pid, file, body, at) VALUES (?, ?, ?, ?)").bind(pid, file, body.slice(i, i + CHUNK), at));
    await db.batch(stmts);   // all or nothing
    return reply(null, 204);
  }
  return reply("not allowed", 405);
}
