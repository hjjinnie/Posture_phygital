// Posture pipeline: pose features in, what the artifact shows out. Deterministic in the timestamps it's given, so the
// live app and the re-scoring of a recorded session (study.js) produce the same numbers.
//
//   every frame:   is this moment ignorable? (out of view, stretching, reaching, moving quickly, or settling back)
//                  otherwise: One Euro filter -> calibrated posture state (scorePosture)
//   every second:  if the last 4 s were clean and steady, their average is the "held" posture -> display health
//
// The artifact itself follows the live posture (liveTarget), so it responds at once; the held posture, ignored moments
// and display health below are the study's analysis, recorded every second.
//
// Ignored moments (and SETTLE seconds after them) never change anything: the artifact keeps showing the last held
// posture and its health freezes.
//
// Display health (0 = worst, 1 = best):
//   poor posture   falls linearly with time, faster the worse the posture
//   good posture   a quick jump when posture turns good, then rises linearly, faster the better the posture
// What the artifact shows is posture x time: a held poor posture shows at once at half strength, then more strongly as
// health drops (a poor posture held for 5 minutes shows more than the same posture held for 1), fading as health
// comes back.
import { FeatureFilter, scorePosture } from "./posture.js";

export const SETTINGS = {
  avgSeconds: 4,          // a posture counts once it has been steady this long, as its average over this window
  holdBand: 0.2,          // "steady": the posture score stays within this range over the window
  cleanShare: 0.75,       // ...and this share of the window's frames are clean (not ignored)
  settleSeconds: 2,       // after an ignored moment, also ignore this long while the person settles back
  absentSeconds: 1,       // no usable pose this long = out of view
  minConfidence: 0.5,     // ears and shoulders must be this visible
  moveSpeed: 0.6,         // head/shoulders moving faster than this many shoulder-widths per second = quick movement
  scaleSpeed: 0.35,       // shoulder width changing faster than this share per second = lunging toward/away
  wristAboveHead: 0.25,   // wrist this many shoulder-widths above the ears = stretching
  wristOutside: 0.5,      // wrist this many shoulder-widths beyond a shoulder, near shoulder height = reaching
  goodScore: 0.85,        // held score at or above = good posture, below = poor posture
  declineSeconds: 300,    // the worst posture takes health from 1 to 0 in this long (half as bad: twice as long)
  improveJump: 0.3,       // when posture turns good, health quickly gains this share of what it's missing...
  improveJumpSeconds: 2,  // ...over this long
  improveSeconds: 180,    // then perfect posture takes health from 0 to 1 in this long (barely good: much slower)
  startHealth: 1,
  showNow: 0.5,           // target(): a held poor posture shows at once at this share of its strength, then grows
  liveHealthSeconds: 45,  // liveTarget(): the slow wellness channel is a 45 s average of the live score
};

// The posture-state fields that are averaged, held and recorded.
export const FIELDS = ["score", "trunk", "lateral", "head", "headRoll", "shoulderTilt", "protraction", "elevL", "elevR",
  "sevTrunk", "sevStack", "sevLateral", "sevHead", "sevShoulders"];
const pick = s => ({
  score: s.score, trunk: s.trunk, lateral: s.lateral, head: s.head, headRoll: s.headRoll, shoulderTilt: s.shoulderTilt,
  protraction: s.protraction, elevL: s.elevL, elevR: s.elevR,
  sevTrunk: s.sev.trunk, sevStack: s.sev.stack, sevLateral: s.sev.lateral, sevHead: s.sev.head, sevShoulders: s.sev.shoulders,
});
const mean = list => Object.fromEntries(FIELDS.map(k => [k, list.reduce((a, v) => a + v[k], 0) / list.length]));
const IGNORED = { absent: "out of view", arms: "stretching or reaching", moving: "moving quickly", settling: "settling back", unsteady: "posture still changing" };

export class PosturePipeline {
  // baseline: calibration features (posture.js median of extractFeatures). onSecond(row) is called once a second.
  constructor(baseline, { settings = {}, onSecond = null } = {}) {
    this.cfg = { ...SETTINGS, ...settings };
    this.baseline = baseline;
    this.onSecond = onSecond;
    this.filter = new FeatureFilter();
    this.frames = [];          // [{t, v|null, why}] over the last avgSeconds; v only for clean frames
    this.t0 = null; this.nextTick = null; this.lastSeen = null;
    this.prev = null; this.speed = 0; this.scaleRate = 0; this.quietUntil = -Infinity;
    this.inst = null; this.avg = null; this.held = null;
    this.health = this.cfg.startHealth;
    this.good = null;          // {jumpLeft, jumpStep} while a good posture is current
    this.poorShape = null;     // the last held poor posture: what the artifact shows, scaled by lost health
    this.status = "starting";
    this.present = false;
    this.live = null; this.liveT = null; this.liveSeen = false;
    this.liveHealth = this.cfg.startHealth;   // slow average of the live score (the blob's wilt), as before the study model
  }

  // Why this frame should be ignored, or null if it can be scored. raw = extractFeatures(...) output.
  #ignorable(t, raw) {
    const c = this.cfg;
    if (!raw || raw.conf < c.minConfidence) { this.prev = null; return "absent"; }
    // Speed of the head and shoulders, in shoulder-widths per second, lightly smoothed.
    if (this.prev) {
      const dt = Math.max(1e-3, t - this.prev.t), S = raw.S;
      const d = Math.hypot(raw.shX - this.prev.shX, raw.shY - this.prev.shY) + Math.hypot(raw.earX - this.prev.earX, raw.earY - this.prev.earY);
      const k = Math.min(1, dt / 0.3);
      this.speed += k * (d / 2 / S / dt - this.speed);
      this.scaleRate += k * (Math.abs(raw.S - this.prev.S) / S / dt - this.scaleRate);
    }
    this.prev = { t, shX: raw.shX, shY: raw.shY, earX: raw.earX, earY: raw.earY, S: raw.S };
    const S = raw.S, head = raw.earY - c.wristAboveHead * S;
    for (const [x, y, v] of [[raw.wrLX, raw.wrLY, raw.wrLV], [raw.wrRX, raw.wrRY, raw.wrRV]]) {
      if (!(v > 0.5)) continue;
      const outside = Math.abs(x - raw.shX) - S / 2;   // beyond the nearer shoulder
      if (y < head || (outside > c.wristOutside * S && y < raw.shY + 0.5 * S)) return "arms";
    }
    if (this.speed > c.moveSpeed || this.scaleRate > c.scaleSpeed) return "moving";
    return null;
  }

  // Feed every pose result: raw = extractFeatures(...) output, or null when nobody was found. t in seconds.
  push(t, raw) {
    const c = this.cfg;
    if (this.t0 === null) { this.t0 = t; this.nextTick = t + 1; }
    let why = this.#ignorable(t, raw);
    if (why) this.quietUntil = t + c.settleSeconds;
    else if (t < this.quietUntil) why = "settling";
    if (why !== "absent") this.lastSeen = t;
    let v = null;
    if (raw && raw.conf >= c.minConfidence) {
      // Live posture (filtered only): what the artifact shows, so it responds at once.
      this.live = pick(scorePosture(this.filter.apply(raw, t), this.baseline));
      if (this.liveT !== null) this.liveHealth += (1 - Math.exp(-(t - this.liveT) / c.liveHealthSeconds)) * (this.live.score - this.liveHealth);
      this.liveT = t;
      if (!why) v = this.inst = this.live;
    }
    this.liveSeen = why !== "absent";
    this.frames.push({ t, v, why });
    while (this.frames.length && this.frames[0].t <= t - c.avgSeconds) this.frames.shift();
    const clean = this.frames.filter(f => f.v);
    this.avg = clean.length ? mean(clean.map(f => f.v)) : null;
    while (t >= this.nextTick) { this.#second(this.nextTick); this.nextTick += 1; }
    return this;
  }

  #second(ts) {
    const c = this.cfg;
    const win = this.frames.filter(f => f.t > ts - c.avgSeconds && f.t <= ts);
    const clean = win.filter(f => f.v);
    this.present = this.lastSeen !== null && ts - this.lastSeen <= c.absentSeconds;
    const scores = clean.map(f => f.v.score);
    const steady = scores.length && Math.max(...scores) - Math.min(...scores) <= c.holdBand;
    const latest = win.at(-1)?.why;
    if (!this.present) this.status = "absent";
    else if (win.length && clean.length >= c.cleanShare * win.length && steady) {
      this.held = mean(clean.map(f => f.v)); this.status = "held";
    } else this.status = latest && latest !== "absent" ? latest : clean.length ? "unsteady" : "settling";

    if (this.status === "held") {
      const s = this.held.score;
      if (s < c.goodScore) {
        this.poorShape = this.held;
        this.health -= (c.goodScore - s) / c.goodScore / c.declineSeconds;
        this.good = null;
      } else {
        if (!this.good) {   // posture just turned good: a quick jump, spread over a couple of seconds
          const jump = c.improveJump * (1 - this.health);
          this.good = { jumpLeft: jump, jumpStep: jump / c.improveJumpSeconds };
        }
        const step = Math.min(this.good.jumpLeft, this.good.jumpStep);
        this.good.jumpLeft -= step;
        this.health += step + (s - c.goodScore) / (1 - c.goodScore) / c.improveSeconds;
      }
      this.health = Math.min(1, Math.max(0, this.health));
    }
    this.onSecond?.(this.row(ts));
  }

  get statusText() { return this.status === "held" ? "held" : this.status === "starting" ? "starting" : `ignored: ${IGNORED[this.status]}`; }

  // One record per second: what the study CSV stores.
  row(ts) {
    const r = { t: +(ts - this.t0).toFixed(3), present: this.present ? 1 : 0, status: this.status, health: this.health };
    for (const [prefix, src] of [["avg4", this.present ? this.avg : null], ["held", this.held]])
      for (const k of FIELDS) r[`${prefix}_${k}`] = src ? src[k] : "";
    return r;
  }

  // What the artifact shows in active mode: the live posture (filtered only), so it responds at once, as before the
  // study model; the slow wellness channel is a 45 s average of the live score. The study's held posture, ignored
  // moments and display health are still computed and recorded (row()), they just don't drive the artifact.
  liveTarget() {
    const l = this.live;
    const shape = l ? { trunk: l.trunk, lateral: l.lateral, head: l.head, headRoll: l.headRoll, shoulderTilt: l.shoulderTilt,
      protraction: l.protraction, elevL: l.elevL, elevR: l.elevR }
      : { trunk: 0, lateral: 0, head: 0, headRoll: 0, shoulderTilt: 0, protraction: 0, elevL: 0, elevR: 0 };
    return { ...shape, wellbeing: this.liveHealth, confidence: this.liveSeen && l ? 1 : 0 };
  }

  // The study model's view (held posture x time), kept for analysis and as an option. Two parts, the stronger wins:
  //   now:     the current held poor posture at showNow of its strength (immediate feedback)
  //   so far:  the last poor posture's shape scaled so its worst aspect equals the health lost (grows with time, and
  //            fades as good posture restores health)
  // Angles (head roll, shoulder tilt) are never exaggerated beyond what was held.
  target() {
    const c = this.cfg, KEYS = ["trunk", "lateral", "head", "protraction", "elevL", "elevR"];
    const shape = { trunk: 0, lateral: 0, head: 0, headRoll: 0, shoulderTilt: 0, protraction: 0, elevL: 0, elevR: 0 };
    const add = (p, k, a) => {
      for (const key of KEYS) if (Math.abs(p[key] * k) > Math.abs(shape[key])) shape[key] = p[key] * k;
      for (const key of ["headRoll", "shoulderTilt"]) if (Math.abs(p[key] * a) > Math.abs(shape[key])) shape[key] = p[key] * a;
    };
    const now = this.held && this.held.score < c.goodScore ? this.held : null;
    if (now) add(now, c.showNow, c.showNow);
    const p = this.poorShape, lost = 1 - this.health;
    const peak = p ? Math.max(...KEYS.map(key => Math.abs(p[key]))) : 0;
    if (peak > 1e-3 && lost > 0) { const k = lost / peak; add(p, k, Math.min(k, 1)); }
    return { ...shape, wellbeing: this.health, confidence: this.present ? 1 : 0 };
  }
}
