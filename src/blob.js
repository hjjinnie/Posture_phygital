// Jello blob prototype: same setTarget() contract as src/flower.js, different body.
//
//   spine of 5 spheres      = trunk + neck (collapsed to one point = perfect sphere, curled = bean, tapered + rolled = leaning pear)
//   top sphere + face       = head (forward head swells and droops it, head roll tilts the face)
//   8 droplets              = shoulders (tension buds them off the surface; relaxing pulls them back in)
//   colour                  = which posture is active right now, muddied by sustained poor posture (wellbeing)
//   gloss, clarity, height  = wellbeing (cloudy, dull, sagging and sinking when it has been bad for a while)
// It floats: nothing is anchored to the ground; posture deforms it around its centre of mass.
//
// Rendered by raymarching a signed-distance field inside a proxy box, so pieces can split off and
// re-merge with gooey necks. Total jelly volume is kept constant: droplets that leave shrink the body.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { renderOnBlack, disposeRenderer } from "./visuals.js";

const lerp = THREE.MathUtils.lerp, clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => THREE.MathUtils.smoothstep(x, a, b);
const D2R = Math.PI / 180;

// Critically damped: posture inputs (hides tracking jitter).
class Spring {
  constructor(x = 0, k = 30) { this.x = x; this.v = 0; this.target = x; this.k = k; }
  step(dt) { this.v += (this.k * (this.target - this.x) - 2 * Math.sqrt(this.k) * this.v) * dt; this.x += this.v * dt; return this.x; }
}
// Under-damped: the jelly itself overshoots and wobbles.
class Jiggle {
  constructor(x = 0, k = 80, zeta = 0.35) { this.x = x; this.v = 0; this.target = x; this.k = k; this.c = 2 * zeta * Math.sqrt(k); }
  step(dt) { this.v += (this.k * (this.target - this.x) - this.c * this.v) * dt; this.x += this.v * dt; return this.x; }
}
class Jiggle3 {
  constructor(k = 80, zeta = 0.35) { this.x = new THREE.Vector3(); this.v = new THREE.Vector3(); this.target = new THREE.Vector3(); this.k = k; this.c = 2 * zeta * Math.sqrt(k); this._a = new THREE.Vector3(); }
  step(dt) {
    const a = this._a.subVectors(this.target, this.x).multiplyScalar(this.k).addScaledVector(this.v, -this.c);
    this.v.addScaledVector(a, dt); this.x.addScaledVector(this.v, dt);
  }
}

const NS = 5, SEGS = NS - 1;
const L_REST = 0, R_REST = 0.62, HOVER = 1.35;
const BOX_MIN = new THREE.Vector3(-2.3, -0.02, -2.3), BOX_MAX = new THREE.Vector3(2.3, 3.3, 2.3);

// [side (+1 = right), azimuth from the side axis toward the front, upward component,
//  tension threshold, radius, travel beyond the surface, anchor spine node]
// Few, small, deliberately uneven. Each is either in or out; the gooey neck only shows while it moves.
const DROPS = [
  [ 1,  0.35,  0.55, 0.15, 0.115, 0.38, 3],
  [ 1, -0.40,  1.00, 0.45, 0.075, 0.62, 3],
  [ 1,  1.10, -0.10, 0.70, 0.060, 0.50, 2],
  [-1,  0.60,  0.30, 0.20, 0.100, 0.46, 3],
  [-1, -0.20,  0.85, 0.50, 0.065, 0.35, 3],
  [-1,  1.25,  0.45, 0.75, 0.085, 0.70, 2],
];

// State colours (sRGB hex; THREE.Color converts to linear).
export const PALETTE = {
  calm:    { hex: 0x5fd6b4, name: "mint" },
  slump:   { hex: 0x4a52d8, name: "indigo" },
  recline: { hex: 0x58b7f0, name: "sky blue" },
  head:    { hex: 0xf5a540, name: "amber" },
  lean:    { hex: 0xf2d45c, name: "lemon" },
  tense:   { hex: 0xff6f91, name: "hot pink" },
  murky:   { hex: 0x7d735e, name: "murky olive" },
};
const C = Object.fromEntries(Object.entries(PALETTE).map(([k, p]) => [k, new THREE.Color(p.hex)]));
const ND = DROPS.length;

// Volume of the round-cone chain for a radius profile, as a R^2 + b R^3 (so R can be solved for).
function volumeCoeffs(prof, seg) {
  let a = 0;
  for (let k = 0; k < SEGS; k++) a += (Math.PI / 3) * seg * (prof[k] ** 2 + prof[k] * prof[k + 1] + prof[k + 1] ** 2);
  return [a, (2 / 3) * Math.PI * (prof[0] ** 3 + prof[SEGS] ** 3)];
}
function solveR(a, b, V) {
  let R = 0.6;
  for (let i = 0; i < 10; i++) R -= (a * R * R + b * R ** 3 - V) / (2 * a * R + 3 * b * R * R);
  return R;
}
const REST_PROFILE = [1, 1, 1, 1, 1];   // perfect posture = perfect sphere
const V_REST = (() => { const [a, b] = volumeCoeffs(REST_PROFILE, L_REST / SEGS); return a * R_REST ** 2 + b * R_REST ** 3; })();

const vert = /* glsl */`
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const frag = /* glsl */`
#define NS ${NS}
#define ND ${ND}
uniform vec4 uSpine[NS];
uniform vec3 uSpineCol[NS];
uniform vec4 uDrop[ND];
uniform vec4 uTail[ND];
uniform vec3 uDropCol;
uniform vec3 uCenter;
uniform float uTime, uLump, uSquash, uGloss, uClear, uK, uDim;
uniform float uPix;   // angular size of one pixel, for edge coverage
uniform vec3 uFaceC, uFaceR, uFaceU, uFaceF;
uniform float uFaceS, uFaceRad, uEye, uSmile, uBlush, uMouthR;
uniform vec3 uEyeL, uEyeR, uEyeRad, uHiL, uHiR;
uniform float uHiRad;
uniform vec3 uMouth[5];
uniform vec3 uBoxMin, uBoxMax, uSun, uRim;
uniform mat4 uProj;
varying vec3 vWorld;

#include <common>

float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }

// Inigo Quilez's round cone (sphere r1 at a swept to sphere r2 at b).
float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2) {
  vec3 ba = b - a; float l2 = dot(ba, ba); float rr = r1 - r2;
  if (l2 < rr * rr + 1e-5) return min(length(p - a) - r1, length(p - b) - r2);
  float a2 = l2 - rr * rr; float il2 = 1.0 / l2;
  vec3 pa = p - a; float y = dot(pa, ba); float z = y - l2;
  vec3 xv = pa * l2 - ba * y; float x2 = dot(xv, xv);
  float y2 = y * y * l2; float z2 = z * z * l2;
  float k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
  if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
float sdEllipsoid(vec3 p, vec3 r) { float k0 = length(p / r); float k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / (k1 + 1e-6); }

float sdBody(vec3 p) {
  float d = sdRoundCone(p, uSpine[0].xyz, uSpine[1].xyz, uSpine[0].w, uSpine[1].w);
  for (int i = 1; i < NS - 1; i++) d = smin(d, sdRoundCone(p, uSpine[i].xyz, uSpine[i + 1].xyz, uSpine[i].w, uSpine[i + 1].w), 0.06);
  d += uLump * sin(p.x * 9.0 + uTime * 1.7) * sin(p.y * 8.0 - uTime * 1.3) * sin(p.z * 10.0 + uTime * 1.1);
  return d;
}
float sdDrops(vec3 p) {
  float d = 1e5;
  for (int i = 0; i < ND; i++) if (uDrop[i].w > 0.001) d = min(d, sdRoundCone(p, uDrop[i].xyz, uTail[i].xyz, uDrop[i].w, uTail[i].w));
  return d;
}
// Squash about the centre with constant volume: shorter and wider.
vec3 unsquash(vec3 p) { float s = sqrt(uSquash); vec3 d = p - uCenter; return uCenter + vec3(d.x * s, d.y / uSquash, d.z * s); }
float smax(float a, float b, float k) { return -smin(-a, -b, k); }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) { vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - r; }
// Eyes are real beads set into the surface (oriented to the face), the mouth a groove carved into it.
float sdEye(vec3 p, vec3 c) { vec3 q = p - c; return sdEllipsoid(vec3(dot(q, uFaceR), dot(q, uFaceU), dot(q, uFaceF)), uEyeRad); }
float sdEyes(vec3 p) { return min(sdEye(p, uEyeL), sdEye(p, uEyeR)); }
float sdMouth(vec3 p) { float d = 1e5; for (int i = 0; i < 4; i++) d = min(d, sdCapsule(p, uMouth[i], uMouth[i + 1], uMouthR)); return d; }
float sdHi(vec3 p) { return min(length(p - uHiL), length(p - uHiR)) - uHiRad; }   // white sparkle in each eye
bool nearFace(vec3 p) { return length(p - uFaceC) < uFaceRad * 1.6; }
float sdScene(vec3 p) {
  vec3 q = unsquash(p);
  float d = smin(sdBody(q), sdDrops(q), uK) * uSquash / (1.15 + uLump * 12.0);   // conservative under squash + lumps
  if (nearFace(p)) {
    d = smax(d, -sdMouth(p), 0.006);
    d = smin(d, sdEyes(p), 0.006);
    d = min(d, sdHi(p));
  }
  return d;
}
vec3 calcNormal(vec3 p) {
  const vec2 e = vec2(1.0, -1.0) * 0.0015;
  return normalize(e.xyy * sdScene(p + e.xyy) + e.yyx * sdScene(p + e.yyx) + e.yxy * sdScene(p + e.yxy) + e.xxx * sdScene(p + e.xxx));
}
// Spine colours blended by proximity; droplets take their own colour through the gooey neck.
vec3 albedo(vec3 p, out float dropMix) {
  vec3 q = unsquash(p);
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = 0; i < NS - 1; i++) {
    vec3 a = uSpine[i].xyz, ba = uSpine[i + 1].xyz - a;
    float t = clamp(dot(q - a, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
    float d = length(q - a - ba * t) - mix(uSpine[i].w, uSpine[i + 1].w, t);
    float w = exp(-8.0 * d);
    acc += w * mix(uSpineCol[i], uSpineCol[i + 1], t); ws += w;
  }
  dropMix = smoothstep(-uK, uK, sdBody(q) - sdDrops(q));
  return mix(acc / ws, uDropCol, dropMix);
}

void main() {
  vec3 ro = cameraPosition, rd = normalize(vWorld - ro);
  vec3 inv = 1.0 / rd, t0 = (uBoxMin - ro) * inv, t1 = (uBoxMax - ro) * inv;
  vec3 tmn = min(t0, t1), tmx = max(t0, t1);
  float tn = max(max(tmn.x, tmn.y), tmn.z), tf = min(min(tmx.x, tmx.y), tmx.z);
  float t = max(tn, 0.0);
  bool hit = false;
  // Track the ray's closest approach in pixel units: rays that pass within a pixel of the surface
  // get partial coverage, which anti-aliases the silhouette without supersampling.
  float bestR = 1e9, bestT = t;
  for (int i = 0; i < 110; i++) {
    float d = sdScene(ro + rd * t);
    float r = d / (uPix * t);
    if (r < bestR) { bestR = r; bestT = t; }
    if (d < 0.0006 * t) { hit = true; break; }
    t += d;
    if (t > tf) break;
  }
  float cover = 1.0;
  if (!hit) {
    cover = 1.0 - smoothstep(0.0, 1.0, bestR);
    if (cover < 0.01) discard;
    t = bestT;
  }

  vec3 p = ro + rd * t, n = calcNormal(p), v = -rd;
  float dropMix;
  vec3 col = albedo(p, dropMix);

  // Thin parts let light through: sample the field just inside the surface.
  float thin = 0.0;
  for (int i = 1; i <= 4; i++) { float h = 0.1 * float(i); thin += clamp(h + sdScene(p - n * h) * 1.6, 0.0, h) / h; }
  thin *= 0.25;

  // Ambient occlusion from the field: creases, the underside and where droplets meet the body darken.
  float occ = 0.0, ow = 1.0;
  for (int i = 1; i <= 2; i++) { float h = 0.1 * float(i); occ += ow * (h - sdScene(p + n * h)); ow *= 0.6; }
  float ao = clamp(1.0 - 2.0 * occ, 0.35, 1.0);

  // Less light wrap than before, so the side away from the sun reads as a real form shadow.
  float diff = clamp((dot(n, uSun) + 0.15) / 1.15, 0.0, 1.0);
  float hemi = 0.5 + 0.5 * n.y;
  float back = pow(clamp(dot(v, -uSun) * 0.5 + 0.5, 0.0, 1.0), 2.0);
  vec3 lit = col * ((0.13 + 0.25 * hemi) * ao + 0.85 * diff * mix(0.75, 1.0, ao));
  vec3 glow = pow(col, vec3(0.8)) * (0.3 + 1.1 * thin) * (0.7 + 0.6 * back) * mix(0.6, 1.0, ao);
  lit = mix(lit, lit * 0.5 + glow, 0.6 * uClear);
  lit += col * 0.3 * max(dot(n, uRim), 0.0);

  // Face. Blush is a soft flush under the jelly; the mouth groove is shaded darker inside.
  bool nf = nearFace(p);
  float eyeD = nf ? sdEyes(p) : 1.0, mouthD = nf ? sdMouth(p) : 1.0, hiD = nf ? sdHi(p) : 1.0;
  float isEye = 1.0 - smoothstep(0.0, 0.008, eyeD);
  float isHi = 1.0 - smoothstep(0.0, 0.003, hiD);
  float groove = 1.0 - smoothstep(0.0, 0.006, mouthD);
  vec3 fq = p - uFaceC;
  vec2 f = vec2(dot(fq, uFaceR), dot(fq, uFaceU)) / uFaceS;
  float faceSide = smoothstep(0.1, 0.4, dot(n, uFaceF)) * step(length(fq), uFaceRad * 1.6) * (1.0 - dropMix);
  float blush = 0.0;
  for (int s = -1; s <= 1; s += 2) blush = max(blush, 1.0 - smoothstep(0.02, 0.075, length((f - vec2(float(s) * 0.31, -0.06)) * vec2(1.0, 1.7))));
  lit = mix(lit, vec3(1.0, 0.42, 0.55) * 0.75, blush * uBlush * 0.55 * faceSide);
  lit = mix(lit, vec3(0.03, 0.015, 0.03), groove * 0.92);

  // Satin skin.
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 h = normalize(uSun + v);
  float nh = max(dot(n, h), 0.0);
  float sp = pow(nh, mix(6.0, 18.0, uGloss)) * 0.09;    // a faint, broad sheen: soft-touch, not wet
  vec3 r = reflect(rd, n);
  vec3 sky = mix(vec3(0.05, 0.06, 0.07), vec3(0.75, 0.85, 1.0), smoothstep(-0.2, 0.8, r.y));
  lit += sp * uGloss + fres * (sky * 0.06 * uGloss + col * 0.18);
  // Eyes: dark glossy beads lit by the same lights, so their highlights move as it turns.
  vec3 eyeLit = vec3(0.03, 0.015, 0.03) * (0.6 + 0.4 * diff) + pow(nh, 60.0) * 0.12;
  lit = mix(lit, eyeLit, isEye);
  lit = mix(lit, vec3(0.95), isHi);
  lit *= uDim;

  gl_FragColor = vec4(lit, cover);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  vec4 clip = uProj * viewMatrix * vec4(p, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
}`;

// CPU copy of the shader's distance field (same blends, minus the tiny lumps), used to seat the face on the surface.
function sdRoundCone(p, a, b, r1, r2) {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z, l2 = bax * bax + bay * bay + baz * baz, rr = r1 - r2;
  const pax = p.x - a.x, pay = p.y - a.y, paz = p.z - a.z;
  if (l2 < rr * rr + 1e-5) return Math.min(Math.hypot(pax, pay, paz) - r1, Math.hypot(p.x - b.x, p.y - b.y, p.z - b.z) - r2);
  const a2 = l2 - rr * rr, il2 = 1 / l2, y = pax * bax + pay * bay + paz * baz, z = y - l2;
  const xx = pax * l2 - bax * y, xy = pay * l2 - bay * y, xz = paz * l2 - baz * y, x2 = xx * xx + xy * xy + xz * xz;
  const y2 = y * y * l2, z2 = z * z * l2, k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
const sminJS = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
function bodySDF(p, u) {
  const sp = u.uSpine.value, dr = u.uDrop.value, tl = u.uTail.value;
  let d = sdRoundCone(p, sp[0], sp[1], sp[0].w, sp[1].w);
  for (let i = 1; i < sp.length - 1; i++) d = sminJS(d, sdRoundCone(p, sp[i], sp[i + 1], sp[i].w, sp[i + 1].w), 0.06);
  let dd = Infinity;
  for (let i = 0; i < dr.length; i++) if (dr[i].w > 0.001) dd = Math.min(dd, sdRoundCone(p, dr[i], tl[i], dr[i].w, tl[i].w));
  return sminJS(d, dd, u.uK.value);
}

function shadowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,1)"); grad.addColorStop(0.5, "rgba(0,0,0,0.55)"); grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class JelloBlob {
  // maxPixels caps the drawing buffer: raymarching cost scales with pixel count (measured on Intel UHD 630:
  // ~10–14 ms at 0.3 MP, 20+ ms at 0.7 MP), and the anti-aliased edge hides the slight upscale.
  constructor(container, { pixelRatio = Math.min(devicePixelRatio, 1.5), maxPixels = 300_000 } = {}) {
    this.container = container;
    this.pixelRatio = pixelRatio;
    this.maxPixels = maxPixels;
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(pixelRatio);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(r.domElement);

    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0x12171c);
    scene.fog = new THREE.Fog(0x12171c, 9, 22);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.position.set(0, 2.0, 5.4);     // straight in front: it faces you like a mirror (your right = screen right)
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.target.set(0, 1.25, 0);
    this.controls.enableDamping = true;
    this.controls.minDistance = 2.5; this.controls.maxDistance = 12;

    scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x2a2018, 0.9));
    const ground = new THREE.Mesh(new THREE.CircleGeometry(12, 48), new THREE.MeshStandardMaterial({ color: 0x1c242b, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    this.ground = ground;
    const sun = new THREE.DirectionalLight(0xfff1dd, 2.4); sun.position.set(3, 7, 4); scene.add(sun);

    const shTex = shadowTexture();
    const shadow = () => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false, opacity: 0.5 }));
      m.rotation.x = -Math.PI / 2; m.position.y = 0.003; m.renderOrder = 1; scene.add(m); return m;
    };
    this.bodyShadow = shadow();
    this.dropShadows = DROPS.map(shadow);

    const v4 = n => Array.from({ length: n }, () => new THREE.Vector4());
    const v3 = n => Array.from({ length: n }, () => new THREE.Vector3());
    this.u = {
      uSpine: { value: v4(NS) }, uSpineCol: { value: v3(NS) }, uDrop: { value: v4(ND) }, uTail: { value: v4(ND) },
      uDropCol: { value: new THREE.Vector3() }, uCenter: { value: new THREE.Vector3() },
      uTime: { value: 0 }, uPix: { value: 0.003 }, uLump: { value: 0 }, uSquash: { value: 1 }, uGloss: { value: 1 }, uClear: { value: 1 }, uK: { value: 0.2 }, uDim: { value: 1 },
      uFaceC: { value: new THREE.Vector3() }, uFaceR: { value: new THREE.Vector3() }, uFaceU: { value: new THREE.Vector3() }, uFaceF: { value: new THREE.Vector3() },
      uFaceS: { value: 1 }, uFaceRad: { value: 0.6 }, uEye: { value: 1 }, uSmile: { value: 1 }, uBlush: { value: 1 },
      uEyeL: { value: new THREE.Vector3() }, uEyeR: { value: new THREE.Vector3() }, uEyeRad: { value: new THREE.Vector3() },
      uMouth: { value: v3(5) }, uMouthR: { value: 0.01 },
      uHiL: { value: new THREE.Vector3() }, uHiR: { value: new THREE.Vector3() }, uHiRad: { value: 0.01 },
      uBoxMin: { value: BOX_MIN }, uBoxMax: { value: BOX_MAX },
      uSun: { value: new THREE.Vector3(3, 7, 4).normalize() }, uRim: { value: new THREE.Vector3(-4, 3, -3).normalize() },
      uProj: { value: this.camera.projectionMatrix },
    };
    const size = new THREE.Vector3().subVectors(BOX_MAX, BOX_MIN), mid = new THREE.Vector3().addVectors(BOX_MAX, BOX_MIN).multiplyScalar(0.5);
    const box = new THREE.BoxGeometry(size.x, size.y, size.z).translate(mid.x, mid.y, mid.z);
    // Transparent only so the anti-aliased silhouette (alpha < 1 at the edge) blends over the background.
    this.mesh = new THREE.Mesh(box, new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: this.u, side: THREE.BackSide, transparent: true }));
    this.mesh.renderOrder = 0;
    scene.add(this.mesh);

    const S = (x, k) => new Spring(x, k);
    this.s = {
      trunk: S(0, 18), lateral: S(0, 18), head: S(0, 22), headRoll: S(0, 22), shoulderTilt: S(0, 22),
      protraction: S(0, 22), elevL: S(0, 30), elevR: S(0, 30), health: S(0.85, 2), presence: S(1, 6),
    };
    // Higher up the spine = softer = more follow-through.
    this.nodes = Array.from({ length: NS }, (_, i) => new Jiggle3(lerp(220, 70, i / SEGS), 0.32));
    this.radii = Array.from({ length: NS }, () => new Jiggle(R_REST, 90, 0.3));
    this.drops = DROPS.map(() => ({ det: new Jiggle(0, 40, 0.42), phase: 0, pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), init: false }));
    this.time = 0;
    this._t = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), e: new THREE.Vector3(), f: new THREE.Vector3(), Y: new THREE.Vector3(0, 1, 0), col: new THREE.Color(), mix: new THREE.Color() };
    this.values = {};
    this.#solve(0);
    for (const n of this.nodes) n.x.copy(n.target);

    // 320x240 LCD view, straight on like the main view, framed for the full range of shapes.
    this.lcdCamera = new THREE.PerspectiveCamera(35, 320 / 240, 0.1, 100);
    this.lcdCamera.position.set(0, 1.9, 5.0);
    this.lcdCamera.lookAt(0, 1.3, 0);
    this.screenZoom = 2;   // closest framing on a bigger external screen (display.js auto-frames out to fit droplets)

    this._onResize = () => this.resize();
    addEventListener("resize", this._onResize);
    this.resize();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setPixelRatio(Math.min(this.pixelRatio, Math.sqrt(this.maxPixels / (w * h))));
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setTarget(s) {
    const t = this.s;
    t.trunk.target = s.trunk; t.lateral.target = s.lateral; t.head.target = s.head;
    t.headRoll.target = clamp(s.headRoll, -35, 35);
    t.shoulderTilt.target = clamp(s.shoulderTilt, -20, 20);
    t.protraction.target = s.protraction; t.elevL.target = s.elevL; t.elevR.target = s.elevR;
    t.health.target = s.wellbeing;
    t.presence.target = s.confidence > 0.5 ? 1 : 0;
  }

  // Advance physics only (no render). Fixed sub-steps keep the under-damped springs stable.
  step(dt, time) {
    dt = Math.min(dt, 1 / 20);
    const n = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / n;
    for (let i = 0; i < n; i++) {
      for (const sp of Object.values(this.s)) sp.step(h);
      this.#solve(time - dt + (i + 1) * h, h);
    }
  }

  frame(dt, time) {
    this.step(dt, time);
    this.render();
  }

  render() {
    this.controls.update();
    this.#setPixel(this.camera, this.renderer.domElement.height);
    this.renderer.render(this.scene, this.camera);
  }

  // The shader writes depth with uProj and sizes its edge blur by uPix, so both follow the drawing camera.
  renderLcd(renderer) {
    this.u.uProj.value = this.lcdCamera.projectionMatrix;
    this.#setPixel(this.lcdCamera, renderer.domElement.height);
    renderOnBlack(renderer, this.scene, this.lcdCamera, this.ground);
    this.u.uProj.value = this.camera.projectionMatrix;
  }

  // For framing (display.js): half-angle tangents, across and up, that everything the raymarcher can draw spans as
  // seen from `camera`. The shape lies within the spine, droplet and tail spheres, squashed about the centre as the
  // shader does, plus the smooth blend between them (≤ uK/4) and the surface ripples (≤ uLump).
  screenBounds(camera) {
    const u = this.u, c = u.uCenter.value, sq = u.uSquash.value, s = Math.sqrt(sq), stretch = Math.max(1 / s, sq);
    const pad = u.uK.value / 4 + u.uLump.value + 0.02, m = camera.matrixWorldInverse, p = this._bp ??= new THREE.Vector3();
    let x = 0, y = 0;
    for (const list of [u.uSpine.value, u.uDrop.value, u.uTail.value]) for (const v of list) {
      if (v.w <= 0.001) continue;
      p.set(c.x + (v.x - c.x) / s, c.y + (v.y - c.y) * sq, c.z + (v.z - c.z) / s).applyMatrix4(m);
      const r = v.w * stretch + pad, depth = Math.max(-p.z - r, 0.05);
      x = Math.max(x, (Math.abs(p.x) + r) / depth);
      y = Math.max(y, (Math.abs(p.y) + r) / depth);
    }
    return { x, y };
  }

  #setPixel(camera, heightPx) {
    this.u.uPix.value = 2 * Math.tan(camera.fov * D2R / 2) / heightPx;
  }

  // For still snapshots: jump the posture inputs to their targets, then let the jelly settle.
  settle(time = 2, seconds = 2.5) {
    for (const sp of Object.values(this.s)) { sp.x = sp.target; sp.v = 0; }
    const h = 1 / 120;
    for (let t = time - seconds; t < time; t += h) this.#solve(t, h);
    this.render();
  }

  #solve(time, h = 0) {
    const v = Object.fromEntries(Object.entries(this.s).map(([k, sp]) => [k, sp.x]));
    const u = this.u, { a: tmp, b: dir, Y } = this._t;
    const wilt = 1 - smooth(0.25, 0.78, v.health);
    const lean = v.lateral, curl = v.trunk, head = v.head, A = Math.abs(lean);
    const presence = clamp(v.presence, 0, 1);
    const awake = smooth(0.2, 0.8, presence);

    // ---- shoulders -> droplets (computed first: they take volume away from the body) ----
    const tensionSide = side => clamp(Math.max(v.protraction, side > 0 ? v.elevR : v.elevL) + 0.3 * smooth(0.5, 1, wilt), 0, 1);
    let dropVol = 0;
    for (let i = 0; i < ND; i++) {
      const [side, , , th, r] = DROPS[i], d = this.drops[i];
      d.det.target = smooth(th, th + 0.06, tensionSide(side));
      if (h) d.det.step(h);
      dropVol += clamp(d.det.x, 0, 1) * (4 / 3) * Math.PI * r ** 3;
    }

    // ---- body: radius profile + length, then solve the radius that keeps volume constant ----
    const stretch = clamp(Math.abs(curl) * 0.95 + A * 0.6 + head * 0.35, 0, 1.2);
    const L = L_REST + 1.0 * stretch - 0.12 * wilt;
    const prof = REST_PROFILE.map((p, i) => Math.max(0.3, p * (1 + 0.5 * A * (1 - 2 * i / SEGS))));
    prof[SEGS] *= 1 + 0.25 * head; prof[SEGS - 1] *= 1 + 0.08 * head;
    const [ca, cb] = volumeCoeffs(prof, L / SEGS);
    const breath = 1 + lerp(0.035, 0.016, awake) * Math.sin(time * lerp(0.9, 1.8, awake));
    const R = solveR(ca, cb, Math.max(0.35, V_REST - dropVol));
    for (let i = 0; i < NS; i++) { this.radii[i].target = R * prof[i] * breath; if (h) this.radii[i].step(h); }
    const rad = this.radii.map(j => j.x);

    // ---- spine: forward C-curve (slump), neck droop (forward head), sideways roll that curls over (lean) ----
    const curlTot = curl * 2.2 + wilt * 0.3, neck = head * 1.0 + wilt * 0.35, rollTot = lean * 1.3;
    const seg = L / SEGS;
    let pitch = 0, rl = 0;
    const N = this.nodes;
    N[0].target.set(0, 0, 0);
    for (let k = 0; k < SEGS; k++) {
      const w = (k + 1) / 10;
      pitch += curlTot * w + (k === SEGS - 1 ? neck : k === SEGS - 2 ? neck * 0.3 : 0);
      rl += rollTot * w + (k === SEGS - 1 ? v.shoulderTilt * D2R * 0.4 : 0);
      dir.set(Math.sin(rl), Math.cos(rl) * Math.cos(pitch), Math.cos(rl) * Math.sin(pitch));
      N[k + 1].target.copy(N[k].target).addScaledVector(dir, seg);
      const wob = 0.012 * k * awake * smooth(0, 0.3, stretch);   // idle wobble once it's out of sphere shape
      N[k + 1].target.x += wob * Math.sin(time * 2.1 + k);
      N[k + 1].target.z += wob * Math.cos(time * 1.7 + k);
    }
    const topDir = this._t.c.copy(dir);
    // Float: put the centre of mass (volume-weighted) at the hover point, which bobs and sinks as it wilts or sleeps.
    const hover = HOVER - 0.4 * wilt - 0.15 * (1 - presence) + 0.07 * Math.sin(time * 1.3) * lerp(0.4, 1, awake);
    let wsum = 0; tmp.set(0, 0, 0);
    for (let k = 0; k < NS; k++) { const w = rad[k] ** 3; tmp.addScaledVector(N[k].target, w); wsum += w; }
    tmp.multiplyScalar(-1 / wsum).add(dir.set(0, hover, 0));
    for (let k = 0; k < NS; k++) N[k].target.add(tmp);
    const center = u.uCenter.value.set(0, hover, 0);
    N[0].x.copy(N[0].target);
    for (let k = 1; k < NS; k++) if (h) N[k].step(h);
    for (let k = 0; k < NS; k++) u.uSpine.value[k].set(N[k].x.x, N[k].x.y, N[k].x.z, rad[k]);

    // ---- droplets: positions, gentle orbit, velocity-stretched tails ----
    const tension = Math.max(tensionSide(1), tensionSide(-1));
    for (let i = 0; i < ND; i++) {
      const [side, az, up, , r, dist, anchor] = DROPS[i], d = this.drops[i];
      const det = Math.max(0, d.det.x), elev = side > 0 ? v.elevR : v.elevL;
      if (h) d.phase += h * side * (0.1 + 0.05 * (i % 3)) * smooth(0.3, 1, det) * (0.5 + tension);
      dir.set(side * Math.cos(az), up + 0.8 * elev, Math.sin(az) + 0.6 * v.protraction).normalize().applyAxisAngle(Y, d.phase);
      const ra = rad[anchor];
      d.prev.copy(d.pos);
      d.pos.copy(N[anchor].x).addScaledVector(dir, ra * 0.45 + det * (ra * 0.6 + dist));
      d.pos.y += (0.03 + 0.01 * (i % 3)) * det * Math.sin(time * (1.3 + 0.37 * i) + i * 1.7);
      d.pos.y = Math.max(d.pos.y, r * 0.9);
      d.pos.clamp(BOX_MIN, BOX_MAX);
      if (h && d.init) { tmp.subVectors(d.pos, d.prev).divideScalar(h); d.vel.lerp(tmp, 1 - Math.exp(-h * 10)); }
      d.init = true;
      const rr = r * (0.7 + 0.3 * clamp(det, 0, 1));
      tmp.copy(d.vel).multiplyScalar(-0.04);
      const maxTail = 0.08 * clamp(det, 0, 1);
      if (tmp.length() > maxTail) tmp.setLength(maxTail);
      u.uDrop.value[i].set(d.pos.x, d.pos.y, d.pos.z, rr);
      u.uTail.value[i].set(d.pos.x + tmp.x, d.pos.y + tmp.y, d.pos.z + tmp.z, rr * 0.35);
    }

    // ---- colour by state ----
    const weights = [[C.slump, Math.max(0, curl)], [C.recline, Math.max(0, -curl)], [C.head, head], [C.lean, A], [C.tense, Math.max(v.protraction, v.elevL, v.elevR)]];
    const { col: base, mix } = this._t;
    mix.setRGB(0, 0, 0);
    let total = 0, peak = 0;
    for (const [c, w] of weights) { mix.r += c.r * w; mix.g += c.g * w; mix.b += c.b * w; total += w; peak = Math.max(peak, w); }
    base.copy(C.calm);
    if (total > 1e-3) base.lerp(mix.multiplyScalar(1 / total), smooth(0, 0.7, peak));
    base.lerp(C.murky, wilt * 0.6);   // keeps a hint of its state colour so it reads as unwell, not as a stone
    for (let i = 0; i < NS; i++) {
      const s = i / SEGS;   // deeper at the bottom, lighter at the top; the pooled bulb gets deeper still
      const k = lerp(0.8 - 0.25 * A, 1.12 + 0.12 * A, s);
      u.uSpineCol.value[i].set(base.r * k, base.g * k, base.b * k);
    }
    tmp.set(base.r, base.g, base.b).multiplyScalar(1.08);   // same jelly as the body, a touch lighter
    u.uDropCol.value.copy(tmp);
    this.values.color = "#" + base.getHexString(THREE.SRGBColorSpace);

    // ---- wellbeing: squash, gloss, clarity, lumps ----
    const sq = 1 - 0.26 * wilt;
    u.uSquash.value = sq;
    u.uGloss.value = lerp(1, 0.2, wilt);
    u.uClear.value = lerp(1, 0.25, wilt);
    u.uLump.value = 0.004 + 0.012 * tension + 0.006 * wilt;
    u.uK.value = 0.24;
    u.uTime.value = time;
    u.uDim.value = lerp(0.5, 1, presence);

    // ---- face on the top lobe ----
    const top = N[SEGS].x, sx = 1 / Math.sqrt(sq);
    // The face only follows half the droop so it stays visible when curled over.
    const fp = clamp(pitch * 0.3, -0.4, 0.35);
    const F = u.uFaceF.value.set(0, -Math.sin(fp), Math.cos(fp));
    // Keep F (half droop) and make "up" perpendicular to it, so the face never turns away from you.
    // Up leans only partly with the body, so a leaning blob tilts its face a little instead of lying on its side.
    const U = u.uFaceU.value.copy(Y).lerp(topDir, 0.3);
    U.addScaledVector(F, -U.dot(F)).normalize();
    const Rt = u.uFaceR.value.crossVectors(U, F).normalize();
    const roll = -v.headRoll * D2R * 0.9;
    Rt.applyAxisAngle(F, roll); U.applyAxisAngle(F, roll);
    // Face sits between the centre and the top lobe, so it stays on the front whatever shape the body takes.
    // Leaning tips the top lobe sideways (its surface turns away from you), so the face moves lower and
    // toward the middle as the lean grows; otherwise the mouth slides off the side.
    tmp.lerpVectors(center, top, lerp(0.55, 0.3, smooth(0, 0.8, A)));
    tmp.x = lerp(center.x, tmp.x, 1 - 0.7 * smooth(0, 0.8, A));
    const faceRad = (rad[2] + rad[3] + rad[4]) / 3;
    u.uFaceS.value = faceRad / 0.55;
    u.uFaceRad.value = faceRad;
    const ph = time % 3.7, blink = ph < 0.14 ? Math.abs(ph - 0.07) / 0.07 : 1;
    u.uEye.value = awake * lerp(1, 0.45, wilt) * blink;
    const strain = Math.max(Math.abs(curl), head, A * 0.8, tension);
    u.uSmile.value = clamp(1 - 1.7 * strain - 1.6 * wilt, -1, 1);
    u.uBlush.value = (1 - wilt) * (1 - 0.5 * tension) * awake;

    // 3D features: find where each one meets the body surface (march along the face direction), then place it there.
    const S = u.uFaceS.value, faceUnsq = this._t.d.copy(tmp);
    const toWorld = (p, out) => out.set(p.x * sx, center.y + (p.y - center.y) * sq, p.z * sx);
    const onSurface = (x, y, out) => {
      const o = this._t.e.copy(faceUnsq).addScaledVector(Rt, x * S).addScaledVector(U, y * S);
      let lo = -0.3, hi = faceRad * 2.5;
      for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (bodySDF(this._t.f.copy(o).addScaledVector(F, m), u) < 0) lo = m; else hi = m; }
      return toWorld(o.addScaledVector(F, lo), out);
    };
    // The shader only draws features within ~1.6 face radii of uFaceC, so anchor it on the front surface
    // rather than inside the body; deep inside, a stretched or leaning body put the features out of range.
    onSurface(0, 0, u.uFaceC.value).addScaledVector(U, -0.04 * faceRad);
    const eyeOpen = u.uEye.value;
    u.uEyeRad.value.set(0.052 * S, Math.max(0.075 * eyeOpen, 0.007) * S, 0.03 * S);
    onSurface(-0.18, 0.05, u.uEyeL.value).addScaledVector(F, -0.012 * S);
    onSurface(0.18, 0.05, u.uEyeR.value).addScaledVector(F, -0.012 * S);
    // Sparkle: a small white bead on the upper right of each eye; shrinks away as the eyes close.
    for (const [eye, hi] of [[u.uEyeL.value, u.uHiL.value], [u.uEyeR.value, u.uHiR.value]])
      hi.copy(eye).addScaledVector(Rt, 0.016 * S).addScaledVector(U, 0.028 * S * eyeOpen).addScaledVector(F, 0.024 * S);
    u.uHiRad.value = Math.max(1e-4, 0.017 * S * smooth(0.45, 0.75, eyeOpen));
    const smile = u.uSmile.value;
    for (let i = 0; i < 5; i++) {
      const x = lerp(-0.065, 0.065, i / 4);
      onSurface(x, -0.12 - smile * 0.035 * (1 - (x / 0.065) ** 2), u.uMouth.value[i]);
    }
    u.uMouthR.value = 0.009 * S;

    // ---- soft shadows on the floor below (bigger and fainter the higher it floats) ----
    let cx = 0, cz = 0, lowest = Infinity;
    for (let k = 0; k < NS; k++) { cx += N[k].x.x; cz += N[k].x.z; lowest = Math.min(lowest, N[k].x.y - rad[k]); }
    const sr = (Math.max(...rad) * 2 * sx + 0.5 * Math.max(0, lowest)) * 1.3;
    this.bodyShadow.position.set((cx / NS) * sx, 0.003, (cz / NS) * sx);
    this.bodyShadow.scale.set(sr * 1.1, sr, 1);
    this.bodyShadow.material.opacity = 0.8 * Math.exp(-0.9 * Math.max(0, lowest)) * lerp(0.6, 1, presence);
    for (let i = 0; i < ND; i++) {
      const p = u.uDrop.value[i], m = this.dropShadows[i], det = clamp(this.drops[i].det.x, 0, 1);
      m.position.set(p.x * sx, 0.004, p.z * sx);
      m.scale.setScalar(p.w * 3);
      m.material.opacity = 0.35 * smooth(0.5, 1, det) * Math.exp(-p.y * 1.2);
    }

    Object.assign(this.values, { wilt, tension, R, L });
  }

  dispose() {
    removeEventListener("resize", this._onResize);
    this.controls.dispose();
    disposeRenderer(this.renderer);
  }
}

