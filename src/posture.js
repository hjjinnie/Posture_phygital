// Landmarks -> frontal-camera features -> calibrated posture state.
//
// Coordinates are mirrored so +x is the person's right (screen right in a mirror view),
// and image y points down. All distances are normalised by shoulder width so the
// numbers don't change when you sit closer to or further from the camera.

const EAR_L = 7, EAR_R = 8, SH_L = 11, SH_R = 12;
const DEG = 180 / Math.PI;

export function extractFeatures(lm, world, W, H) {
  const P = i => ({ x: (1 - lm[i].x) * W, y: lm[i].y * H, v: lm[i].visibility ?? 1 });
  const lE = P(EAR_L), rE = P(EAR_R), lS = P(SH_L), rS = P(SH_R);
  const wl = world[SH_L], wr = world[SH_R];
  return {
    conf: Math.min(lE.v, rE.v, lS.v, rS.v),
    S: Math.hypot(rS.x - lS.x, rS.y - lS.y),           // shoulder width, px
    E: Math.hypot(rE.x - lE.x, rE.y - lE.y),           // ear-to-ear, px (head scale)
    shX: (lS.x + rS.x) / 2, shY: (lS.y + rS.y) / 2,
    earX: (lE.x + rE.x) / 2, earY: (lE.y + rE.y) / 2,
    lShY: lS.y, rShY: rS.y,
    shTilt: Math.atan2(rS.y - lS.y, rS.x - lS.x) * DEG, // + = right shoulder lower
    headRoll: Math.atan2(rE.y - lE.y, rE.x - lE.x) * DEG, // + = head tipped to the right
    // World landmarks are metric, hip-centred, -z toward camera.
    wz: (world[EAR_L].z + world[EAR_R].z - wl.z - wr.z) / 2, // ears ahead of shoulders (<0)
    Sw: Math.hypot(wr.x - wl.x, wr.y - wl.y, wr.z - wl.z),   // 3D shoulder width, m
  };
}

// One Euro filter (Casiez et al. 2012): heavy smoothing when still, low lag when moving.
class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1) { Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: 0 }); }
  static alpha(cutoff, dt) { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); }
  filter(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

export class FeatureFilter {
  constructor(minCutoff = 0.8, beta = 0.05) { this.f = {}; this.minCutoff = minCutoff; this.beta = beta; }
  apply(feat, t) {
    const out = {};
    for (const k in feat) out[k] = (this.f[k] ??= new OneEuro(this.minCutoff, this.beta)).filter(feat[k], t);
    return out;
  }
}

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp01 = x => Math.min(1, Math.max(0, x));

// Deviation (in the raw units below) that starts to count, and that counts as fully bad.
export const TOLERANCE = {
  trunk:      [0.05, 0.30],
  head:       [0.06, 0.35],
  lateral:    [0.15, 0.90],
  protraction:[0.06, 0.25],   // 3D shoulder span is the noisiest signal (±1.5% at rest, measured)
  elevation:  [0.03, 0.15],
};
const WEIGHTS = { trunk: 0.25, stack: 0.15, lateral: 0.2, head: 0.25, shoulders: 0.15 };

export const median = arr => {
  const out = {};
  for (const k of Object.keys(arr[0])) { const v = arr.map(a => a[k]).sort((a, b) => a - b); out[k] = v[v.length >> 1]; }
  return out;
};

// f and base are feature objects (base = median of a calibration window with good posture).
export function scorePosture(f, base) {
  const S0 = base.S;
  const N = (f.shY - f.earY) / f.S, N0 = (base.shY - base.earY) / base.S;
  const raw = {
    fNeck: (N0 - N) / N0,                              // neck "disappears" as head drops/juts
    fRatio: (f.E / f.S) / (base.E / base.S) - 1,         // head grows relative to shoulders
    fShScale: f.S / S0 - 1,                              // shoulders nearer the camera
    dShY: (f.shY - base.shY) / S0,                       // torso sinks
    dEarY: (f.earY - base.earY) / S0,
    dWz: f.wz - base.wz,                                 // <0: head moved ahead of shoulders (m)
    fSw: 1 - f.Sw / base.Sw,                             // 3D shoulder span narrows
  };
  const trunk = 1.0 * raw.dShY + 1.5 * raw.fShScale;   // signed: + slumped/leaning in, - reclined
  const head = 0.6 * raw.fNeck + 1.2 * Math.max(0, raw.fRatio) + 2.5 * Math.max(0, -raw.dWz);
  const lateral = 0.6 * (f.shTilt - base.shTilt) / 8 + 0.4 * ((f.shX - base.shX) / S0) / 0.25; // + = toward right
  const protraction = Math.max(0, 2 * raw.fSw);
  // Shoulder rise not explained by the whole head rising (sitting taller).
  const headRise = Math.min(0, raw.dEarY);
  const elevL = Math.max(0, -(f.lShY - base.lShY) / S0 + headRise);
  const elevR = Math.max(0, -(f.rShY - base.rShY) / S0 + headRise);

  const sev = {
    trunk: smoothstep(...TOLERANCE.trunk, Math.abs(trunk)),
    head: smoothstep(...TOLERANCE.head, head),
    lateral: smoothstep(...TOLERANCE.lateral, Math.abs(lateral)),
    protraction: smoothstep(...TOLERANCE.protraction, protraction),
    elevL: smoothstep(...TOLERANCE.elevation, elevL),
    elevR: smoothstep(...TOLERANCE.elevation, elevR),
  };
  sev.shoulders = Math.max(sev.protraction, (sev.elevL + sev.elevR) / 2);
  // Ear-shoulder-hip stack: hips are out of frame on a laptop camera, so infer it from head + trunk.
  sev.stack = clamp01(0.5 * sev.trunk + 0.7 * sev.head);

  const bad = Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * sev[k], 0);
  return {
    raw, sev,
    score: 1 - bad,
    trunk: Math.sign(trunk) * sev.trunk,           // signed severity
    lateral: Math.sign(lateral) * sev.lateral,     // signed severity
    head: sev.head,
    headRoll: f.headRoll - base.headRoll,          // degrees
    shoulderTilt: f.shTilt - base.shTilt,          // degrees
    protraction: sev.protraction,
    elevL: sev.elevL, elevR: sev.elevR,
  };
}

// Slow "health" of the flower: an exponential average of the score, so brief movements don't punish.
export class Wellbeing {
  constructor(tau = 45, start = 0.85) { this.tau = tau; this.value = start; }
  update(score, dt) { this.value += (1 - Math.exp(-dt / this.tau)) * (score - this.value); return this.value; }
}
