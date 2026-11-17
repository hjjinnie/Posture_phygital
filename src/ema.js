// EMA (Embodied Mindful Aesthetics) visuals: the liquid metaball (Liquid, Contour lines) and the posture dandelion
// (Single, Branching), by Jihoon Park, ported from jihoonpark-mde/ema-visualization (ema_live.html @ 4300b0e).
//
// Their rendering, motion and desk-time model are used as written, inside createEma(). Posture Buddy's changes, all
// marked "Posture Buddy:": canvases and sizes come from the visual; framing fits the shorter side, so a tall (portrait)
// screen like the Pi's doesn't crop the sides; state can be shared, so a second renderer (the external screen) draws
// the same model. The visual takes Posture Buddy's target (severities 0..1) and turns it into EMA's 0..100 scores the
// same way their bridge (ema_live.js) does.
import * as THREE from "three";

const VS = `attribute vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `precision highp float;
#define MAXN 25
uniform vec2  uRes;
uniform vec3  uRo;
uniform vec3  uTa;
uniform vec3  uC;          // form centre (world)
uniform vec4  uBalls[MAXN];// [0] = banked core, rest = today's metaballs (xyz local pos, w radius)
uniform int   uN;
uniform vec4  uBound;      // bounding sphere for the form
uniform float uRunit;
uniform float uRc;         // core radius
uniform float uExt;        // current form extent (for gradient)
uniform float uTrunk;      // smoothed deviations 0 (ideal) .. 1 (worst)
uniform float uHead;
uniform float uSag;
uniform float uTilt;       // signed radians, + = toward user's right
uniform float uBright;
uniform float uLineHW;
uniform float uTime;
uniform float uMode;       // 0 mono, 1 solid, 2 gradient
uniform vec3  uColA;
uniform vec3  uColB;
uniform float uSurface;    // 0 = contour lines, 1 = liquid
uniform float uShear;      // how strongly the form leans/pours with side balance
uniform float uFocal;      // camera focal length (1.9 = full-week framing; higher = closer)
uniform float uFrost;      // liquid mode: shoulder posture deviation → frosted, milky liquid

uniform float SP;          // contour spacing (world units)

float smin(float a, float b, float k){
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h*h*k*0.25;
}
float sdEllipsoid(vec3 p, vec3 r){
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / k1;
}

float map(vec3 p){
  vec3 q = p - uC;
  // side balance: lean the form itself a little (contours carry the full tilt)
  float fa = uTilt*0.35;
  float c = cos(fa), s = sin(fa);
  q.xy = mat2(c, s, -s, c) * q.xy;
  // liquid mode: the mass pours toward the leaning side (a shear, so even a sphere visibly leans)
  float shk = uShear * tan(uTilt);
  q.x -= shk * q.y;
  // trunk slump: sag + spread at the base
  q.y /= uSag;
  float spread = 1.0 + uTrunk*0.8*smoothstep(0.35*uRc, -0.6*uRc, q.y);
  q.xz /= spread;
  // forward head: pinched waist, squeezed up and down
  float band  = 0.5*uRc + 0.06;
  float waist = 1.0 - 0.5*uHead*exp(-(q.y*q.y)/(band*band));
  q.xz /= waist;
  q.y  /= (1.0 + 0.18*uHead);
  // melting: part of the body's volume flows down into the puddle, so the body shrinks as the puddle grows
  float pm = smoothstep(0.35, 0.95, uTrunk);
  float keep = 1.0 - 0.35*pm;
  q /= keep;

  float k = uRunit * mix(1.8, 0.5, uHead);
  float d = length(q) - uBalls[0].w;
  for (int i = 1; i < MAXN; i++){
    if (i >= uN) break;
    vec4 b = uBalls[i];
    if (b.w < 0.0005) continue;
    d = smin(d, length(q - b.xyz) - b.w, k);
  }
  d *= uSag * waist * keep * 0.9 / sqrt(1.0 + shk*shk);
  // looser skin when surface tension drops
  // (contour mode only: on a reflective liquid surface this ripple reads as crumpled foil)
  d += (1.0 - uSurface)*0.2*uRunit*uHead*sin(26.0*q.x + uTime*0.12)*sin(26.0*q.y + 1.3)*sin(26.0*q.z);

  // the melted volume: a rounded liquid lens on the floor, blended into the body as one surface
  if (pm > 0.001){
    float R = max(uRc, 0.12);
    // uneven, slowly creeping outline instead of a perfect disc
    float ang = atan(p.z, p.x);
    float wob = 1.0 + 0.07*sin(3.0*ang + uTime*0.15) + 0.04*sin(5.0*ang - uTime*0.1 + 1.7);
    float pr = R * (0.6 + 1.5*pm) * wob;
    float ph = R * 0.5 * pm + 0.02;
    // centre sits below the floor, so the visible cap meets the floor at a shallow angle (thin edge, no rim)
    d = smin(d, sdEllipsoid(p - vec3(0.0, -0.55*ph, 0.0), vec3(pr, ph, pr)), 1.4*R*pm);
  }
  // liquid rests on the floor
  return max(d, -p.y);
}

vec3 calcNormal(vec3 p){
  const vec2 e = vec2(1.0, -1.0)*0.0012;
  return normalize(e.xyy*map(p + e.xyy) + e.yyx*map(p + e.yyx) +
                   e.yxy*map(p + e.yxy) + e.xxx*map(p + e.xxx));
}

vec3 ink(float t){
  if (uMode < 0.5) return vec3(0.92, 0.95, 1.0);
  if (uMode < 1.5) return uColA;
  return mix(uColA, uColB, t);
}

// ---------- liquid surface ----------
// Ambient studio around the form: a dim graded room, an overhead softbox, a cool strip light on the left,
// a warm strip on the right and a soft horizon band. The background itself stays black (Pepper's ghost);
// this light only shows up through reflection and refraction.
vec3 env(vec3 d){
  vec3 c = mix(vec3(0.07, 0.08, 0.10), vec3(0.42, 0.46, 0.52), smoothstep(-0.4, 1.0, d.y));     // graded room
  c += vec3(0.45, 0.48, 0.52) * exp(-abs(d.y - 0.02) * 9.0);                                    // horizon glow
  vec3 top = normalize(vec3(0.0, 1.0, 0.35));
  c += vec3(1.0) * 2.2 * smoothstep(0.80, 0.94, dot(d, top));                                    // softbox
  c += vec3(0.55, 0.78, 1.0) * 1.8 * smoothstep(0.62, 0.84, -d.x) * smoothstep(0.85, 0.35, abs(d.y - 0.15)); // cool strip L
  c += vec3(1.0, 0.80, 0.58) * 1.5 * smoothstep(0.66, 0.86, d.x)  * smoothstep(0.80, 0.30, abs(d.y - 0.05)); // warm strip R
  c += vec3(0.75, 0.80, 0.90) * 0.9 * smoothstep(0.75, 0.95, -d.z) * smoothstep(0.7, 0.2, abs(d.y - 0.3));   // back fill
  return c;
}

// Thin-film interference (soap bubble / oil slick): colour depends on film thickness and viewing angle.
vec3 thinFilm(float cosi, float film){
  float d = film * (1.0 + 0.6 * (1.0 - cosi));
  return 0.5 + 0.5 * cos(6.28318 * (d + vec3(0.0, 0.33, 0.67)));
}

vec3 shadeLiquid(vec3 p, vec3 rd, vec3 n, float tg){
  const float IOR = 1.33;                       // water
  float cosi = max(dot(-rd, n), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);
  vec3 refl = env(reflect(rd, n));

  // refract in, march through the liquid to where the ray leaves, refract out
  vec3 ri = refract(rd, n, 1.0 / IOR);
  vec3 q = p - n * 0.006;
  float t = 0.0;
  for (int i = 0; i < 56; i++){
    float d = -map(q + ri * t);
    if (d < 0.0012) break;
    t += max(d * 0.7, 0.004);
    if (t > 4.0) break;
  }
  vec3 pe = q + ri * t;
  vec3 ne = calcNormal(pe);
  vec3 ro2 = refract(ri, -ne, IOR);
  if (dot(ro2, ro2) < 1e-4) ro2 = reflect(ri, -ne);   // total internal reflection
  vec3 tint = ink(tg);
  // Clear liquid: mostly what is behind it (black background, floor rings) bent by refraction,
  // plus a little of the room light. Thickness tints it slightly (stronger in Solid/Gradient colour).
  vec3 trans = env(ro2) * 0.32 * exp(-(1.0 - tint) * t * 0.8);

  // iridescence: a slowly drifting film thickness tints the reflections
  float film = 1.1 + 0.35*sin(3.1*p.x + uTime*0.25)*sin(2.7*p.y - uTime*0.18) + 0.25*sin(4.3*p.z + 1.3);
  vec3 iri = thinFilm(cosi, film);
  float iriAmt = 0.8 * (1.0 - 0.75*uFrost);
  refl *= mix(vec3(1.0), iri * 1.7, iriAmt);

  // shoulder posture: frosting. Light scatters in the body and on the skin: milky, soft highlights
  // thicker parts scatter more, thin edges stay see-through, so it reads as frosted glass, not stone
  float cloud = 0.65 + 0.35 * sin(5.0*p.x + uTime*0.2) * sin(4.0*p.y + 0.7) * sin(5.5*p.z - uTime*0.15); // uneven milkiness
  float scatter = (1.0 - exp(-t * 2.2)) * cloud;
  vec3 milky = (env(normalize(n + vec3(0.0, 0.8, 0.0))) * 0.13 + vec3(0.03)) * mix(vec3(1.0), tint, 0.5) * scatter;
  vec3 glow = vec3(0.75, 0.82, 0.95) * pow(1.0 - cosi, 1.6) * 0.45;   // light passing through the thin edges
  trans = mix(trans, trans * 0.4 + milky + glow * mix(vec3(1.0), tint, 0.5), uFrost);
  refl  = mix(refl, env(n) * 0.2, 0.7 * uFrost);

  vec3 col = mix(trans, refl, fres);
  col += iri * fres * 0.25 * iriAmt;                                           // coloured sheen at grazing angles
  vec3 key = normalize(vec3(-0.4, 0.9, 0.5));
  float specPow = mix(160.0, 14.0, uFrost);
  col += vec3(1.0) * pow(max(dot(reflect(rd, n), key), 0.0), specPow) * mix(1.4, 0.3, uFrost);
  col += tint * 0.05 * pow(1.0 - cosi, 2.0);                                   // keeps the edge readable on black
  return 1.0 - exp(-col * 1.25);                                               // soft tone map: highlights glow, don't clip
}

void main(){
  vec2 uv = (2.0*gl_FragCoord.xy - uRes) / min(uRes.x, uRes.y);   // Posture Buddy: fit the shorter side (portrait screens)
  vec3 ww = normalize(uTa - uRo);
  vec3 uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0)));
  vec3 vv = cross(uu, ww);
  vec3 rd = normalize(uv.x*uu + uv.y*vv + uFocal*ww);
  vec3 ro = uRo;

  vec3 cn = vec3(sin(uTilt), cos(uTilt), 0.0);
  vec3 col = vec3(0.0);
  float tFirst = 1e9;

  // bounding sphere
  vec3 oc = ro - uBound.xyz;
  float bb = dot(oc, rd);
  float cc = dot(oc, oc) - uBound.w*uBound.w;
  float disc = bb*bb - cc;
  if (disc > 0.0){
    float sq = sqrt(disc);
    float t = max(-bb - sq, 0.0), tEnd = -bb + sq;
    int hits = 0;
    bool armed = true;
    for (int i = 0; i < 240; i++){
      if (t > tEnd) break;
      vec3 p = ro + rd*t;
      float d = map(p);
      float ad = abs(d);
      if (ad > 0.005) armed = true;
      if (ad < 0.0012 && armed){
        vec3 n = calcNormal(p);
        if (uSurface > 0.5){
          float tgl = clamp(0.5 + (p.y - uC.y) / (2.0 * uExt), 0.0, 1.0);
          col += shadeLiquid(p, rd, n, tgl);
          tFirst = t;
          break;
        }
        float h  = dot(p - uC, cn) / SP;
        float li = floor(h + 0.5);
        float g  = abs(h - li);
        float line = 1.0 - smoothstep(uLineHW, uLineHW*2.2, g);
        line *= mix(0.3, 1.0, 1.0 - pow(abs(dot(n, cn)), 6.0));
        float rim = pow(1.0 - abs(dot(n, -rd)), 3.0);
        float tg = clamp(0.5 + li*SP/(2.0*uExt), 0.0, 1.0);
        float w = (hits == 0) ? 1.0 : 0.38;
        col += w * (line + 0.10*rim) * ink(tg);
        if (hits == 0) tFirst = t;
        hits++;
        armed = false;
        if (hits >= 3) break;
        t += 0.02;
        continue;
      }
      t += max(ad*0.7, 0.0015);
    }
  }


  col *= uBright;
  gl_FragColor = vec4(min(col, 1.0), 1.0);
}`;

// One EMA instance: the desk-time model, motion smoothing and both renderers (metaball on glCanvas, dandelion on
// pcCanvas). With `shared`, it draws another instance's model instead of keeping its own.
function createEma({ glCanvas, pcCanvas, view, shared = null }) {
  const BALL_SECONDS  = 20 * 60;      // one metaball per 20 min at the desk
  const MAX_PER_DAY   = 24;           // 8 h cap
  const DAY           = 86400;
  const WEEK          = 7 * DAY;
  const WORK_START    = 5 * 3600;     // clock 0 = Monday 04:00 → 09:00
  const R_MAX         = 0.72;         // radius of a full week (7 × 24 + 1 units)
  const R_UNIT        = R_MAX / Math.cbrt(7 * MAX_PER_DAY + 1);
  const MISSED_KEEP   = 0.75;         // missed workday → keep 75% of banked volume
  // Motion (real seconds, independent of the time-simulator speed). The shape starts moving as soon as
  // a score changes, but glides there slowly with an eased start and stop, so ML noise never shows as shiver.
  const MOTION = {
    inputTau:  1.2,    // low-pass on incoming scores: removes frame-to-frame ML noise
    deadband:  0.035,  // changes smaller than ~2 score points do not retarget the shape…
    creep:     25,     // …they only drift in very slowly
    metaball:  4.2,    // glide time for metaball geometry: starts in ≈1 s, half way ≈5 s, settled ≈14 s
    dandelion: 3.0,    // glide time for the dandelion: starts in ≈0.7 s, half way ≈4 s, settled ≈11 s
    calm:      1,      // Motion slider: 0.5 (more responsive) … 2 (calmer)
  };
  const IDEAL = 90, WORST = 30;
  const MAX_TILT      = 50 * Math.PI / 180;
  const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  const dev   = s => Math.min(1, Math.max(0, (IDEAL - s) / (IDEAL - WORST)));
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const ss    = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  // =====================================================================
  //  State
  // =====================================================================
  const input = shared ? shared.input : { trunk:95, stack:95, side:95, lean:0, head:95, shoulder:95, present:true };
  const sm = shared ? shared.sm : { trunk:0, head:0, shoulder:0, tilt:0, stack:0 };  // smoothed deviations (stack: dandelion only)
  const S = shared ? shared.S : {
    clock: WORK_START, speed: 60,
    bank: 1, bankShown: 1,           // banked volume in ball units (day 1 starts with one)
    balls: [], todayCount: 0, presentToday: 0, nextBallIn: BALL_SECONDS,
  };
  let demo = false;

  // 24 scatter slots, evenly spread on a sphere, ordered so consecutive balls land apart
  const SLOTS = (() => {
    const n = 24, ga = Math.PI * (3 - Math.sqrt(5)), pts = [];
    let x = 11; const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < n; i++){
      const y = 1 - (i + 0.5) / n * 2, r = Math.sqrt(1 - y*y), th = ga * i;
      pts.push({ dir:[Math.cos(th)*r, y, Math.sin(th)*r], dist:0.28 + 0.32*rnd(), rate:0.8 + 0.4*rnd(), phase:rnd()*6.283 });
    }
    return pts.map((_, i) => pts[(i * 7) % n]);
  })();

  function spawnBall(){
    if (S.todayCount >= MAX_PER_DAY) return;
    const slot = SLOTS[S.todayCount % SLOTS.length];
    S.balls.push({ ...slot, g:0, grow:0, banking:false });
    S.todayCount++;
  }

  function closeDay(weekday){
    if (S.todayCount > 0){
      for (const b of S.balls) b.banking = true;          // today's volume fuses into tomorrow's core
    } else if (weekday < 5 && S.presentToday <= 0){
      S.bank = Math.max(1, S.bank * MISSED_KEEP);          // missed workday: shrink gradually
    }
    S.todayCount = 0; S.presentToday = 0; S.nextBallIn = BALL_SECONDS;
  }

  function resetWeek(){
    Plant.startBlow();                                     // dandelion: last week's seeds blow away
    S.bank = S.bankShown = 1;
    S.balls = []; S.todayCount = 0; S.presentToday = 0; S.nextBallIn = BALL_SECONDS;
  }

  function tickSim(dt, away){
    // presence → metaballs
    if (input.present && !away){
      let t = dt;
      while (t > 0){
        if (S.todayCount >= MAX_PER_DAY){ S.presentToday += t; break; }
        const s = Math.min(t, S.nextBallIn);
        S.nextBallIn -= s; S.presentToday += s; t -= s;
        if (S.nextBallIn <= 1e-6){ spawnBall(); S.nextBallIn = BALL_SECONDS; }
      }
    }
  }

  // ---- Motion: score → filtered → deadbanded target → eased glide (critically damped, no overshoot) ----
  const MO_KEYS = ['trunk','stack','head','shoulder','tilt'];
  const mo = shared ? shared.mo : {};
  if (!shared) for (const k of MO_KEYS) mo[k] = { f:0, t:0, x:0, v:0 };       // filtered, target, shown value, velocity
  // lean direction blends smoothly through the centre, so a noisy lean near 0 cannot flip the tilt side
  const rawDev = k => k === 'tilt' ? dev(input.side) * MAX_TILT * clamp(input.lean / 0.15, -1, 1) : dev(input[k]);
  function glide(x, v, target, time, dt){
    const w = 2 / time, a = w * dt, e = 1 / (1 + a + 0.48*a*a + 0.235*a*a*a);
    const c = x - target, tmp = (v + w * c) * dt;
    return [target + (c + tmp) * e, (v - w * tmp) * e];
  }
  const glideTime = () => (view.surface >= 2 ? MOTION.dandelion : MOTION.metaball) * MOTION.calm;
  function motionTick(dt){
    if (dt <= 0) return;
    const time = glideTime();
    const a = 1 - Math.exp(-dt / (MOTION.inputTau * MOTION.calm));
    const creep = 1 - Math.exp(-dt / MOTION.creep);
    for (const k of MO_KEYS){
      const m = mo[k];
      m.f += (rawDev(k) - m.f) * a;
      const db = MOTION.deadband * (k === 'tilt' ? MAX_TILT : 1);
      if (Math.abs(m.f - m.t) > db) m.t = m.f; else m.t += (m.f - m.t) * creep;
      [m.x, m.v] = glide(m.x, m.v, m.t, time, dt);
      sm[k] = m.x;
    }
    // metaballs gather/scatter on the same eased glide (each ball a little faster or slower)
    const target = 1 - mo.stack.t;
    for (const b of S.balls){
      if (b.banking) continue;
      [b.g, b.gv] = glide(b.g, b.gv || 0, target, time / b.rate, dt);
      b.g = clamp(b.g, 0, 1);
    }
  }
  function settleMotion(){                                     // jump straight to the current scores (stills, presets)
    for (const k of MO_KEYS){ const m = mo[k]; m.f = m.t = m.x = rawDev(k); m.v = 0; sm[k] = m.x; }
    for (const b of S.balls){ if (!b.banking){ b.g = 1 - mo.stack.t; b.gv = 0; } }
  }

  function advance(dt, away = false){
    while (dt > 1e-9){
      const dayIdx = Math.floor(S.clock / DAY);
      const toNext = (dayIdx + 1) * DAY - S.clock;
      const step = Math.min(dt, toNext);
      tickSim(step, away);
      dt -= step;
      if (step >= toNext - 1e-9){
        S.clock = (dayIdx + 1) * DAY;
        closeDay(dayIdx % 7);
        if (Math.floor(S.clock / WEEK) !== Math.floor(dayIdx / 7)) resetWeek();
      } else {
        S.clock += step;
      }
    }
  }

  function nextWorkMorning(from){
    let d = Math.floor(from / DAY) + 1;
    while (d % 7 >= 5) d++;
    return d * DAY + WORK_START;
  }

  function realTick(dt){
    motionTick(dt);
    for (const b of S.balls) b.grow = Math.min(1, b.grow + dt / 3);
    for (let i = S.balls.length - 1; i >= 0; i--){
      const b = S.balls[i];
      if (!b.banking) continue;
      b.g = Math.min(1, b.g + dt / 4);
      if (b.g >= 1){ S.balls.splice(i, 1); S.bank += 1; S.bankShown += 1; }
    }
    S.bankShown += (S.bank - S.bankShown) * (1 - Math.exp(-dt / 2.5));
    Plant.tick(dt);
  }

  const canvas = glCanvas;
  const gl = canvas.getContext('webgl', { antialias:false, preserveDrawingBuffer:true });
  function compile(type, src){
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const U = {};
  for (const n of ['uRes','uRo','uTa','uC','uBalls','uN','uBound','uRunit','uRc','uExt','uTrunk','uHead','uSag',
                   'uTilt','uBright','uLineHW','uTime','uMode','uColA','uColB','SP','uSurface','uShear','uFocal','uFrost']) U[n] = gl.getUniformLocation(prog, n);

  const ballBuf = new Float32Array(25 * 4);

  function resize(){}   // Posture Buddy: the visual sets the canvas size

  const FIT = 0.75, FIT_EASE = 1.2;                  // Posture Buddy: auto-fit share of the screen, easing (s)
  const fit = { focal: null, y: null, t: null };     // per renderer, so each screen fits its own shape
  function draw(tReal){
    resize();
    // ---- layout the form ----
    let absorbed = 0;
    for (const b of S.balls) absorbed += ss(0.8, 1, b.g) * ss(0, 1, b.grow);
    const coreVol = S.bankShown + absorbed;
    const Rc = R_UNIT * Math.cbrt(coreVol) * (1 + 0.008*Math.sin(tReal*0.3));
    const dT = sm.trunk;
    const sag = 1 - 0.45 * dT;
    const cy = (1 - dT) * (Rc + 0.5) + dT * (Rc * 0.45);   // melting: the body settles into its puddle

    ballBuf.fill(0);
    ballBuf[3] = Rc;
    let ext = Rc, n = 1;
    for (const b of S.balls){
      if (n >= 25) break;
      const ab = ss(0.8, 1, b.g);
      const r = R_UNIT * Math.cbrt(Math.max(0, 1 - ab)) * ss(0, 1, b.grow);
      const far = Rc + R_UNIT + b.dist, near = Rc * 0.55;
      let d = far + (near - far) * ss(0, 0.95, b.g);
      d *= 1 + 0.015 * Math.sin(tReal * 0.3 + b.phase) * (1 - b.g);
      const ang = b.phase + tReal * 0.025 * (1 - b.g);
      const [x, y, z] = b.dir;
      const px = (x*Math.cos(ang) - z*Math.sin(ang)) * d;
      const pz = (x*Math.sin(ang) + z*Math.cos(ang)) * d;
      let py = y * d * 0.8;
      py = Math.max(py, r - cy / sag + 0.02);
      ballBuf.set([px, py, pz, r], n * 4);
      ext = Math.max(ext, Math.hypot(px, py, pz) + r);
      n++;
    }
    const puddleR = Math.max(Rc, 0.12) * 2.7;
    const boundR = Math.max(ext * 1.9 + 0.1, Math.hypot(cy, puddleR) + 0.15);

    // ---- Posture Buddy: auto-fit. Frame the form as it is now (not a full week's growth): aim at its middle and
    // zoom so it fills FIT of the screen, easing as it changes. Extents follow map() in the shader, generously.
    const pm = ss(0.35, 0.95, sm.trunk);
    const halfY = ext * sag * (1 + 0.18 * sm.head);
    const top = cy + halfY, bottom = pm > 0.001 ? 0 : Math.max(0, cy - halfY);
    const shift = halfY * (Math.abs(Math.sin(sm.tilt * 0.35)) + (view.surface ? 0.7 * Math.abs(Math.tan(sm.tilt)) : 0));
    const halfX = Math.max(ext * (1 + 0.8 * sm.trunk) + shift, pm > 0.001 ? Math.max(Rc, 0.12) * (0.6 + 1.5 * pm) * 1.12 : 0);
    const short = Math.min(canvas.width, canvas.height), roomX = canvas.width / short, roomY = canvas.height / short;
    const midY = (top + bottom) / 2, dist0 = Math.hypot(5.0, 0.8);
    const wantFocal = FIT * dist0 / Math.max(halfX / roomX, (top - bottom) / 2 / roomY, 0.05);
    const k = fit.t === null ? 1 : 1 - Math.exp(-Math.min(0.2, Math.max(0, tReal - fit.t)) / FIT_EASE);
    fit.focal = fit.focal === null ? wantFocal : fit.focal + (wantFocal - fit.focal) * k;
    fit.y = fit.y === null ? midY : fit.y + (midY - fit.y) * k;
    fit.t = tReal;
    const focal = Math.min(40, Math.max(0.5, fit.focal * view.focal / 1.9));

    // ---- camera ----
    const camA = view.spin ? Math.sin(tReal * 0.05) * 0.5 : 0;
    const dist = 5.0;
    const ro = [Math.sin(camA) * dist, fit.y + 0.8, Math.cos(camA) * dist];
    const H = Math.min(canvas.width, canvas.height);   // Posture Buddy: line width from the shorter side
    const pxWorld = dist * 2 / (focal * H);
    gl.uniform1f(U.uFocal, focal);
    const lineHW = Math.min(0.32, 0.75 * pxWorld / view.sp);
    gl.uniform1f(U.SP, view.sp);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform3f(U.uRo, ro[0], ro[1], ro[2]);
    gl.uniform3f(U.uTa, 0, fit.y, 0);
    gl.uniform3f(U.uC, 0, cy, 0);
    gl.uniform4fv(U.uBalls, ballBuf);
    gl.uniform1i(U.uN, n);
    gl.uniform4f(U.uBound, 0, cy, 0, boundR);
    gl.uniform1f(U.uRunit, R_UNIT);
    gl.uniform1f(U.uRc, Rc);
    gl.uniform1f(U.uExt, Math.max(ext, 0.15));
    gl.uniform1f(U.uTrunk, sm.trunk);
    gl.uniform1f(U.uHead, sm.head);
    gl.uniform1f(U.uSag, sag);
    gl.uniform1f(U.uTilt, sm.tilt);
    // shoulder posture: frosting in liquid mode, dimming in contour mode
    gl.uniform1f(U.uBright, view.surface ? 1 : 1 - 0.78 * sm.shoulder);
    gl.uniform1f(U.uFrost, view.surface ? sm.shoulder : 0);
    gl.uniform1f(U.uLineHW, lineHW);
    gl.uniform1f(U.uTime, tReal);
    gl.uniform1f(U.uMode, view.mode);
    gl.uniform3fv(U.uColA, view.colA);
    gl.uniform3fv(U.uColB, view.colB);
    gl.uniform1f(U.uSurface, view.surface);
    gl.uniform1f(U.uShear, view.surface ? 0.7 : 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const Plant = (() => {
    const pc = pcCanvas, ctx = pc.getContext('2d');
    const FULL_WEEK = 5 * MAX_PER_DAY + 1, BLOW_SECONDS = 7, DEG = Math.PI / 180;
    const V = {
      add:(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]], sub:(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],
      mul:(a,s)=>[a[0]*s,a[1]*s,a[2]*s], dot:(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],
      cross:(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],
      norm:a=>{const l=Math.hypot(a[0],a[1],a[2])||1;return [a[0]/l,a[1]/l,a[2]/l];},
      mix:(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t],
    };
    function hash(n){ n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15; return (n >>> 0) / 4294967296; }
    const rnd = (i, j) => hash(i * 977 + j * 7919 + 13);
    const frac = x => x - Math.floor(x);
    const UP = [0,1,0], DOWN = [0,-1,0];
    const BASE_AZ = 25 * DEG;
    const RIGHT0 = [Math.cos(BASE_AZ), 0, -Math.sin(BASE_AZ)];     // fixed world "screen right" for the lean
    const TOWARD0 = [Math.sin(BASE_AZ), 0, Math.cos(BASE_AZ)];     // toward the viewer
    const DROOP_DIR = V.norm([0.8, 0, -0.6]);
    const NOD_DIR = V.norm(V.add(V.mul(TOWARD0, 0.6), RIGHT0));
    const perp = a => { const u = V.norm(V.cross(a, Math.abs(a[1]) < 0.9 ? UP : [1,0,0])); return [u, V.cross(a, u)]; };
    const KIND = {
      stem:  { w:0.8,  a:0.34, c:0 },
      stalk: { w:0.6,  a:0.30, c:0.35 },
      beak:  { w:0.55, a:0.20, c:0.7 },
      pappus:{ w:0.45, a:0.15, c:1 },
    };
    let cam, offX = 0, px = 1, batches = new Map(), snap = true, blow = null;
    // Posture Buddy: auto-fit. Every projected point extends `box`; after each frame the zoom and centre ease toward
    // framing that box at PFIT of the screen (per renderer, so each screen fits its own shape).
    const PFIT = 0.8, PFIT_EASE = 1.2;
    let fitZ = 1, fitX = 0, fitY = 0, fitT = null, box = null;
    const grow = p => { if (box) { box[0] = Math.min(box[0], p[0]); box[1] = Math.max(box[1], p[0]); box[2] = Math.min(box[2], p[1]); box[3] = Math.max(box[3], p[1]); } };

    function units(){ let u = S.bankShown; for (const b of S.balls) u += ss(0, 1, b.grow); return u; }
    function resize(){}   // Posture Buddy: the visual sets the canvas size
    function makeCamera(az){
      const W = pc.width, H = pc.height, M = Math.min(W, H);   // Posture Buddy: scale from the shorter side
      const target = [0, 1.22, 0], D = 4.3, el = 12 * DEG, foc = 2.85 * view.focal / 1.9;
      const C = V.add(target, [Math.sin(az)*Math.cos(el)*D, Math.sin(el)*D, Math.cos(az)*Math.cos(el)*D]);
      const f = V.norm(V.sub(target, C)), r = V.norm(V.cross(f, UP)), u = V.cross(r, f);
      return { project(p){ const q = V.sub(p, C); const z = V.dot(q, f);
        return [W/2 + fitX + fitZ*foc*V.dot(q, r)/z*M/2, H/2 + fitY - fitZ*foc*V.dot(q, u)/z*M/2, z]; } };   // Posture Buddy: fitted
    }
    const depthA = z => clamp(1.25 - (z - 3.2) / 3.0, 0.45, 1);
    function bucket(key, make){ let b = batches.get(key); if (!b){ b = make(); batches.set(key, b); } return b; }
    function seg(kind, a, b, alpha){
      if (alpha <= 0.004) return;
      const p = cam.project(a), q = cam.project(b);
      grow(p); grow(q);
      const K = KIND[kind], lvl = Math.round(clamp(K.a * alpha * depthA((p[2] + q[2]) / 2), 0, 1) * 48);
      if (!lvl) return;
      bucket(kind + lvl, () => ({ kind, lvl, pts:[] })).pts.push(p[0], p[1], q[0], q[1]);
    }
    function dot(a, alpha, r){
      if (alpha <= 0.004) return;
      const p = cam.project(a), lvl = Math.round(clamp(0.7 * alpha * depthA(p[2]), 0, 1) * 48);
      grow(p);
      if (!lvl) return;
      bucket('dot' + r + '_' + lvl, () => ({ kind:'dot', r, lvl, pts:[] })).pts.push(p[0], p[1]);
    }
    function colorFor(c){
      if (view.mode === 0) return [0.91, 0.94, 1];
      if (view.mode === 1) return view.colA;
      return V.mix(view.colA, view.colB, c);                     // Bottom colour = stem, Top colour = seeds
    }
    const rgba = (c, a) => `rgba(${Math.round(c[0]*255)},${Math.round(c[1]*255)},${Math.round(c[2]*255)},${a})`;
    function flush(){
      ctx.lineCap = 'round';
      for (const b of batches.values()){
        const a = b.lvl / 48;
        if (b.kind === 'dot'){
          ctx.fillStyle = rgba(colorFor(1), a);
          const r = Math.max(0.5, b.r * px);
          ctx.beginPath();
          for (let i = 0; i < b.pts.length; i += 2){ ctx.moveTo(b.pts[i] + r, b.pts[i+1]); ctx.arc(b.pts[i], b.pts[i+1], r, 0, 6.2832); }
          ctx.fill();
        } else {
          const K = KIND[b.kind];
          ctx.strokeStyle = rgba(colorFor(K.c), a); ctx.lineWidth = Math.max(0.5, K.w * px);
          ctx.beginPath();
          for (let i = 0; i < b.pts.length; i += 4){ ctx.moveTo(b.pts[i], b.pts[i+1]); ctx.lineTo(b.pts[i+2], b.pts[i+3]); }
          ctx.stroke();
        }
      }
      batches = new Map();
    }
    function glow(p, R, alpha){
      const q = cam.project(p), r = R * px;
      const g = ctx.createRadialGradient(q[0], q[1], 0, q[0], q[1], r);
      const c = colorFor(0.6);
      g.addColorStop(0, rgba(c, 0.55 * alpha)); g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, 6.2832); ctx.fill();
    }

    // A globe of seeds (one dandelion head). Seed directions follow a fixed low-discrepancy sequence,
    // so new seeds never move the existing ones.
    function globe(c, axis, R, nF, key, o, t){
      const [hu, hv] = perp(axis);
      const n = Math.ceil(nF), full = Math.floor(nF);
      const cosMax = Math.cos(o.phiMax);
      const foldN = o.fold / 0.62, open = 0.95 * (1 - 0.7 * foldN);
      for (let i = 0; i < n; i++){
        const wi = i < full ? 1 : nF - full, w = wi * o.alpha;
        const u1 = frac(0.5 + i * 0.7548776662), u2 = frac(0.5 + i * 0.5698402910);
        const cphi = 1 - (1 - cosMax) * u1, sphi = Math.sqrt(Math.max(0, 1 - cphi*cphi)), th = 6.2832 * u2;
        let d = V.norm(V.add(V.add(V.mul(hu, sphi*Math.cos(th)), V.mul(hv, sphi*Math.sin(th))), V.mul(axis, cphi)));
        d = V.norm(V.mix(d, axis, o.fold));                       // shoulders: fold into a bud
        d = V.norm(V.mix(d, DOWN, 0.45 * o.sag));                  // trunk: seeds sag, the head hangs
        const h1 = rnd(key + i, 1), h2 = rnd(key + i, 2), h3 = rnd(key + i, 3), h4 = rnd(key + i, 4), h5 = rnd(key + i, 5), h6 = rnd(key + i, 6);
        const len = R * (0.92 + 0.12 * h1) * (1 - 0.15 * foldN) * (0.6 + 0.4 * wi);
        const base = V.add(c, V.mul(d, R * 0.13));
        let tip = V.add(c, V.mul(d, len)), pd = d;
        const a = ss(h2, h2 + 0.2, o.drift);                       // stack: this seed lets go and drifts
        if (a > 0){
          const bob = [Math.sin(t*0.22 + h3*6)*0.04, Math.sin(t*0.18 + h4*6)*0.05, Math.sin(t*0.2 + h5*6)*0.04];
          const off = V.add(V.add(V.mul(d, R*(0.35 + 1.5*h3)), V.mul(UP, R*(0.15 + 0.9*h4) + o.lift * (0.6 + 0.8*h3))),
                      V.add(V.add(V.mul(hu, (h5 - 0.5)*R*0.9), V.mul(hv, (h6 - 0.5)*R*0.9)), V.add(bob, V.mul(RIGHT0, o.wind * (0.5 + h6)))));
          tip = V.add(tip, V.mul(off, a));
          pd = V.norm(V.mix(d, UP, 0.55 * a));                     // drifting parachutes turn upward
        }
        if (a < 1) seg('beak', base, tip, w * (1 - a));
        if (a > 0) seg('beak', V.sub(tip, V.mul(pd, R * 0.4)), tip, w * a * 1.2);
        const [pu, pv] = perp(pd), plen = R * 0.36;
        for (let k = 0; k < o.fil; k++){
          const ang = k / o.fil * 6.2832 + i;
          const fd = V.norm(V.add(V.mul(pd, 0.6), V.mul(V.add(V.mul(pu, Math.cos(ang)), V.mul(pv, Math.sin(ang))), open)));
          seg('pappus', tip, V.add(tip, V.mul(fd, plen)), w);
        }
        dot(tip, w, o.dotR);
      }
    }

    // The whole plant for a given amount of growth U and posture state.
    function plant(U, p, t, branch, extra = {}){
      const g = Math.sqrt(clamp(U / FULL_WEEK, 0, 1));
      const L = (0.6 + 1.1 * g) * (1 - 0.12 * p.trunk);
      const R = 0.18 + 0.5 * g;
      const alpha = extra.alpha ?? 1;
      // stem: droop (trunk) hooks the top over; lean (side) curves the whole stem
      const sway = V.add(V.mul(RIGHT0, 0.02 * Math.sin(t * 0.22)), V.mul(TOWARD0, 0.014 * Math.sin(t * 0.17 + 1)));
      const bendVec = V.add(V.add(V.mul(DROOP_DIR, 190 * DEG * p.trunk), V.mul(RIGHT0, p.tilt)), sway);
      const bend = Math.hypot(...bendVec), bdir = bend > 1e-6 ? V.mul(bendVec, 1 / bend) : RIGHT0;
      const lean = Math.abs(p.tilt) / MAX_TILT;
      const pw = 1.35 + 2.2 * (p.trunk / (p.trunk + lean + 1e-6)) * Math.min(1, p.trunk * 1.5);
      const N = 40; let pos = [0,0,0], T = UP; const stem = [pos];
      for (let i = 1; i <= N; i++){
        const a = bend * Math.pow(i / N, pw);
        T = V.add(V.mul(UP, Math.cos(a)), V.mul(bdir, Math.sin(a))); pos = V.add(pos, V.mul(T, L / N)); stem.push(pos);
      }
      // head: forward head tips it forward on a short neck
      const nod = 85 * DEG * p.head;
      const fwd = V.norm(V.sub(NOD_DIR, V.mul(T, V.dot(NOD_DIR, T))));
      const axis = V.norm(V.add(V.mul(T, Math.cos(nod)), V.mul(fwd, Math.sin(nod))));
      const neck = V.add(pos, V.mul(V.norm(V.add(T, axis)), 0.12 * p.head * (R / 0.55)));
      const centre = V.add(neck, V.mul(axis, 0.05 * R / 0.55));
      if (!extra.noStem){
        // keep the plant in frame: drift halfway toward centring the head
        offX += ((pc.width / 2 - (cam.project(centre)[0] - offX)) * 0.5 - offX) * (snap ? 1 : 0.08);
        const s1 = V.norm(V.cross(T, [0,0,1])), s2 = V.norm(V.cross(T, s1));
        for (let k = 0; k < 5; k++){
          const ang = k / 5 * 6.2832, off = V.add(V.mul(s1, Math.cos(ang) * 0.012), V.mul(s2, Math.sin(ang) * 0.012));
          for (let i = 1; i < stem.length; i++){ const s = 1 - i / stem.length * 0.4;
            seg('stem', V.add(stem[i-1], V.mul(off, s)), V.add(stem[i], V.mul(off, s)), alpha); }
        }
        if (p.head > 0.01) seg('stem', pos, neck, alpha * 1.4);
        glow(centre, 6 + 4 * g, alpha);
      }
      const o = {
        phiMax: (165 - 95 * p.head) * DEG, fold: 0.62 * p.shoulder, sag: p.trunk,
        drift: extra.drift ?? p.stack, lift: extra.lift || 0, wind: extra.wind || 0, alpha,
      };
      if (!branch){
        globe(centre, axis, R, 20 + 5 * U, 0, { ...o, fil: 8, dotR: 0.9 }, t);
        return;
      }
      // branching: every 20-min cluster is its own stalk with a small seed head
      const K = Math.max(1, U), n = Math.ceil(K), full = Math.floor(K);
      const [hu, hv] = perp(axis), cosMax = Math.cos(o.phiMax);
      const Rb = R * 1.05, r0 = 0.09 + 0.15 * g;
      for (let i = 0; i < n; i++){
        const w = (i < full ? 1 : K - full);
        const u1 = frac(0.5 + i * 0.7548776662), u2 = frac(0.5 + i * 0.5698402910);
        const cphi = 1 - (1 - cosMax) * u1, sphi = Math.sqrt(Math.max(0, 1 - cphi*cphi)), th = 6.2832 * u2;
        let d = V.norm(V.add(V.add(V.mul(hu, sphi*Math.cos(th)), V.mul(hv, sphi*Math.sin(th))), V.mul(axis, cphi)));
        d = V.norm(V.mix(d, axis, o.fold));
        d = V.norm(V.mix(d, DOWN, 0.45 * o.sag));
        const len = Rb * (0.75 + 0.35 * rnd(5000 + i, 1)) * (1 - 0.2 * p.shoulder) * (0.5 + 0.5 * w);
        const sub = V.add(centre, V.mul(d, len));
        if (!extra.noStem) seg('stalk', centre, sub, alpha * w);
        globe(sub, d, r0 * (0.85 + 0.3 * rnd(5000 + i, 2)) * (0.4 + 0.6 * w), 12, 10000 + i * 64,
              { ...o, phiMax: 160 * DEG, fold: 0.4 * p.shoulder, alpha: alpha * w, fil: 5, dotR: 0.7 }, t);
      }
    }

    function draw(tReal){
      resize();
      px = Math.min(pc.width, pc.height) / 300;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, pc.width, pc.height);
      ctx.globalCompositeOperation = 'lighter';
      cam = makeCamera(BASE_AZ + (view.spin ? Math.sin(tReal * 0.05) * 0.5 : 0));
      const branch = view.surface === 3;
      const p = { trunk:sm.trunk, stack:sm.stack, head:sm.head, shoulder:sm.shoulder, tilt:sm.tilt };
      box = [Infinity, -Infinity, Infinity, -Infinity];
      plant(units(), p, tReal, branch);
      const b = box; box = null;
      if (b[1] > b[0] && b[3] > b[2]) {       // Posture Buddy: ease the framing toward this frame's plant
        const W = pc.width, H = pc.height, s = PFIT * Math.min(W / (b[1] - b[0]), H / (b[3] - b[2]));
        const wantX = -((b[0] + b[1]) / 2 - W / 2 - fitX) * s, wantY = -((b[2] + b[3]) / 2 - H / 2 - fitY) * s;
        const k = snap || fitT === null ? 1 : 1 - Math.exp(-Math.min(0.2, Math.max(0, tReal - fitT)) / PFIT_EASE);
        fitZ = clamp(fitZ + (fitZ * s - fitZ) * k, 0.2, 12); fitX += (wantX - fitX) * k; fitY += (wantY - fitY) * k;
        fitT = tReal;
      }
      snap = false;
      if (blow){
        const k = blow.t / BLOW_SECONDS;
        plant(blow.U, p, tReal, branch, { noStem:true, drift: ss(0, 0.35, k), lift: k * 2.2, wind: k * 1.6, alpha: 1 - ss(0.45, 1, k) });
      }
      flush();
    }
    return {
      draw, units,
      startBlow(){ blow = { U: units(), t: 0 }; },
      tick(dt){ if (blow){ blow.t += dt; if (blow.t > BLOW_SECONDS) blow = null; } },
      resnap(){ snap = true; fitT = null; },
    };
  })();

  // Posture Buddy: forget the eased framing, so the next frame frames the form at once (stills, presets).
  const refit = () => { fit.focal = fit.y = fit.t = null; Plant.resnap(); };
  return { input, sm, S, mo, view, advance, realTick, settleMotion, spawnBall, drawMetaball: draw, Plant, gl, refit };
}

// ---- Posture Buddy visual ----
const clamp01 = x => Math.min(1, Math.max(0, x));
const toScore = sev => Math.round(100 * (1 - clamp01(sev)));
// Posture Buddy target -> EMA scores (as in their bridge, ema_live.js).
export function toEma(s) {
  const trunk = Math.abs(s.trunk), side = Math.abs(s.lateral);
  return {
    trunk: toScore(trunk),
    stack: toScore(0.5 * trunk + 0.7 * s.head),        // posture.js: ear-shoulder-hip stack from trunk + head
    side: toScore(side),
    lean: Math.max(-1, Math.min(1, s.lateral)),
    head: toScore(s.head),
    shoulder: toScore(Math.max(s.protraction, (s.elevL + s.elevR) / 2)),
    present: s.confidence > 0.5,
  };
}

const SURFACE = { liquid: 1, contour: 0, dandelion: 2, branching: 3 };

export class EmaVisual {
  // surface: "liquid" | "contour" | "dandelion" | "branching"
  constructor(container, { surface = "liquid", maxPixels = 300_000 } = {}) {
    this.container = container;
    this.maxPixels = maxPixels;
    this.view = { mode: 0, colA: [1, 1, 1], colB: [0.31, 0.70, 1], led: false, spin: true, sp: 0.055, surface: SURFACE[surface], focal: 1.9 };
    this.plant = this.view.surface >= 2;
    const canvas = () => Object.assign(document.createElement("canvas"), { style: "position:absolute; inset:0; width:100%; height:100%; display:block; background:#000" });
    this.glCanvas = canvas(); this.pcCanvas = canvas();
    (this.plant ? this.glCanvas : this.pcCanvas).style.display = "none";
    container.append(this.glCanvas, this.pcCanvas);
    this.ema = createEma({ glCanvas: this.glCanvas, pcCanvas: this.pcCanvas, view: this.view });
    this.ema.S.speed = 1;          // the desk-time model runs in real time
    this.time = 0;
    // The external screen (display.js) adjusts this camera's aspect and field of view; EMA frames itself instead.
    this.lcdCamera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 10);
    this._onResize = () => this.resize();
    addEventListener("resize", this._onResize);
    this.resize();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    const q = Math.min(devicePixelRatio || 1, this.plant ? 2 : 1.5, Math.sqrt(this.maxPixels / (w * h)));
    for (const c of [this.glCanvas, this.pcCanvas]) { c.width = Math.round(w * q); c.height = Math.round(h * q); }
  }

  setTarget(s) { Object.assign(this.ema.input, toEma(s)); }

  step(dt, time) {
    dt = Math.min(dt, 0.1);
    this.ema.advance(dt * this.ema.S.speed);
    this.ema.realTick(dt);
    this.time = time;
  }

  #draw(e) { this.plant ? e.Plant.draw(this.time) : e.drawMetaball(this.time); }
  render() { this.#draw(this.ema); }

  // For stills (docs/shots.html): jump straight to the current scores.
  settle() {
    this.ema.settleMotion();
    for (const e of [this.ema, this.lcd?.e]) e?.refit();
    for (let i = 0; i < 3; i++) this.render();   // the dandelion frames from what it drew last frame
  }
  get renderer() { return { domElement: this.plant ? this.pcCanvas : this.glCanvas }; }

  // External screen: draw the same model at the screen's size, then hand the picture to display.js's renderer.
  renderLcd(renderer) {
    const w = renderer.domElement.width, h = renderer.domElement.height;
    if (!this.lcd) {
      const gl = document.createElement("canvas"), pc = document.createElement("canvas");
      const e = createEma({ glCanvas: gl, pcCanvas: pc, view: this.view, shared: this.ema });
      const src = this.plant ? pc : gl;
      const tex = new THREE.CanvasTexture(src);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
      this.lcd = { e, gl, pc, src, tex, mat, scene, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
    }
    const L = this.lcd;
    for (const c of [L.gl, L.pc]) if (c.width !== w || c.height !== h) { c.width = w; c.height = h; L.tex.dispose(); }
    this.#draw(L.e);
    L.tex.needsUpdate = true;
    renderer.render(L.scene, L.cam);
  }

  dispose() {
    removeEventListener("resize", this._onResize);
    for (const e of [this.ema, this.lcd?.e]) e?.gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.lcd?.tex.dispose(); this.lcd?.mat.dispose();
    this.glCanvas.remove(); this.pcCanvas.remove();
  }
}
