// A procedural flower that mirrors the sitter's posture.
//   stem      = spine     (forward/back slump, sideways lean)
//   top of stem + bloom = neck + head (forward head droops the bloom, head roll tilts it)
//   two leaves = shoulders (protraction swings them forward, elevation lifts them, tilt is asymmetric)
//   pot       = seat / weight distribution (tilts toward the loaded side)
//   petal openness + colour = slow wellbeing (sustained posture, not the last second)
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const lerp = THREE.MathUtils.lerp;
const smooth = (a, b, x) => THREE.MathUtils.smoothstep(x, a, b);
const D2R = Math.PI / 180;
const SRGB = THREE.SRGBColorSpace;

// Critically damped spring: smooth, organic motion that also hides residual tracking jitter.
class Spring {
  constructor(x = 0, stiffness = 30) { this.x = x; this.v = 0; this.target = x; this.k = stiffness; }
  step(dt) {
    const c = 2 * Math.sqrt(this.k);
    this.v += (this.k * (this.target - this.x) - c * this.v) * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

const STEM_SEGS = 12, STEM_LEN = 2.3, TUBE_SEGS = 64, TUBE_RAD = 10, POT_TOP = 0.62;

function petalGeometry(w, h, cup, flare) {
  const g = new THREE.PlaneGeometry(w, h, 6, 12);
  g.translate(0, h / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const v = p.getY(i) / h, x = p.getX(i);
    const nx = x * Math.max(0, Math.sin(Math.PI * (0.14 + 0.86 * v))) ** 0.8;   // narrow base, pointed tip
    p.setX(i, nx);
    p.setZ(i, -cup * (nx / w) ** 2 * h + flare * v * v * h);        // cupped across, flared at the tip
  }
  g.computeVertexNormals();
  return g;
}

function leafGeometry() {
  const w = 0.3, h = 0.95;
  const g = new THREE.PlaneGeometry(w, h, 6, 14);
  g.translate(0, h / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const v = p.getY(i) / h, x = p.getX(i);
    const nx = x * Math.max(0, Math.sin(Math.PI * Math.min(1, v * 1.05))) ** 0.7;
    p.setX(i, nx);
    p.setZ(i, Math.abs(nx) * 0.45 - v * v * 0.18);                  // folded midrib, gentle arch
  }
  g.computeVertexNormals();
  return g;
}

export class Flower {
  constructor(container) {
    this.container = container;
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 1.5));   // DPR 2 doubled frame cost (16 vs 7 ms) on an Intel MBP
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(r.domElement);

    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0x12171c);
    scene.fog = new THREE.Fog(0x12171c, 9, 22);

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.position.set(4.1, 3.7, 4.1);   // 45° so forward (+z) and sideways (+x) bends both read
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.target.set(0, 1.75, 0);
    this.controls.enableDamping = true;
    this.controls.minDistance = 3; this.controls.maxDistance = 14;

    scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x2a2018, 0.9));
    const sun = new THREE.DirectionalLight(0xfff1dd, 2.4);
    sun.position.set(3, 7, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 4, bottom: -2 });
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.8);
    rim.position.set(-4, 3, -3);
    scene.add(rim);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(12, 48), new THREE.MeshStandardMaterial({ color: 0x1c242b, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Pot (the seat). Everything else hangs off it so a pot tilt carries the plant.
    this.pot = new THREE.Group();
    scene.add(this.pot);
    const terracotta = new THREE.MeshStandardMaterial({ color: 0xb4583a, roughness: 0.85 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.34, 0.56, 40), terracotta);
    body.position.y = 0.28;
    const lip = new THREE.Mesh(new THREE.TorusGeometry(0.49, 0.05, 12, 40), terracotta);
    lip.rotation.x = Math.PI / 2; lip.position.y = 0.57;
    const soil = new THREE.Mesh(new THREE.CircleGeometry(0.46, 32), new THREE.MeshStandardMaterial({ color: 0x3a2a20, roughness: 1 }));
    soil.rotation.x = -Math.PI / 2; soil.position.y = 0.55;
    for (const m of [body, lip]) { m.castShadow = true; m.receiveShadow = true; }
    this.pot.add(body, lip, soil);

    // Stem: a tapered tube whose vertices are rewritten every frame.
    this.stemMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
    const stemGeo = new THREE.BufferGeometry();
    const nV = (TUBE_SEGS + 1) * (TUBE_RAD + 1), idx = [];
    for (let i = 0; i < TUBE_SEGS; i++) for (let j = 0; j < TUBE_RAD; j++) {
      const a = i * (TUBE_RAD + 1) + j, b = a + TUBE_RAD + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    stemGeo.setIndex(idx);
    stemGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(nV * 3), 3));
    this.stem = new THREE.Mesh(stemGeo, this.stemMat);
    this.stem.castShadow = true;
    this.stem.frustumCulled = false;
    this.pot.add(this.stem);
    this.ctrl = Array.from({ length: STEM_SEGS + 1 }, () => new THREE.Vector3());
    this.curve = new THREE.CatmullRomCurve3(this.ctrl, false, "centripetal");

    // Bloom
    this.head = new THREE.Group();
    this.pot.add(this.head);
    this.headInner = new THREE.Group();          // carries head roll
    this.head.add(this.headInner);
    const disc = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 16), new THREE.MeshStandardMaterial({ color: 0xe0a326, roughness: 0.9 }));
    disc.scale.y = 0.55; disc.position.y = 0.05; disc.castShadow = true;
    this.headInner.add(disc);
    this.petalOuterMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.55 });
    this.petalInnerMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.5 });
    this.petals = [];
    const ring = (n, geo, mat, radius, phase, inner) => {
      for (let k = 0; k < n; k++) {
        const pivot = new THREE.Group();
        pivot.rotation.y = (k / n) * Math.PI * 2 + phase;
        const hinge = new THREE.Group();
        hinge.position.set(0, 0.03, radius);
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = true;
        hinge.add(m); pivot.add(hinge); this.headInner.add(pivot);
        this.petals.push({ hinge, inner, jitter: Math.sin(k * 12.9898) * 0.08 });
      }
    };
    ring(12, petalGeometry(0.36, 0.8, 0.35, 0.12), this.petalOuterMat, 0.11, 0, false);
    ring(8, petalGeometry(0.26, 0.55, 0.5, 0.05), this.petalInnerMat, 0.07, 0.3, true);

    // Leaves (shoulders)
    this.leafMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.6 });
    this.leafMount = new THREE.Group();
    this.pot.add(this.leafMount);
    const lg = leafGeometry();
    this.leaves = [-1, 1].map(side => {
      const pivot = new THREE.Group();
      const blade = new THREE.Mesh(lg, this.leafMat);
      blade.castShadow = true;
      pivot.add(blade);
      this.leafMount.add(pivot);
      return { side, pivot, blade };
    });

    const S = (x, k) => new Spring(x, k);
    this.s = {
      trunk: S(0, 18), lateral: S(0, 18), head: S(0, 22), headRoll: S(0, 22), shoulderTilt: S(0, 22),
      protraction: S(0, 22), elevL: S(0, 30), elevR: S(0, 30), health: S(0.85, 2), bloom: S(0.05, 1.5),
      presence: S(1, 6),
    };
    this.s.bloom.target = 1;

    this.colors = {
      outer: [new THREE.Color().setHSL(0.95, 0.72, 0.64, SRGB), new THREE.Color().setHSL(0.07, 0.32, 0.30, SRGB)],
      inner: [new THREE.Color().setHSL(0.97, 0.80, 0.74, SRGB), new THREE.Color().setHSL(0.08, 0.30, 0.36, SRGB)],
      stem:  [new THREE.Color().setHSL(0.31, 0.50, 0.36, SRGB), new THREE.Color().setHSL(0.12, 0.32, 0.28, SRGB)],
      leaf:  [new THREE.Color().setHSL(0.30, 0.55, 0.40, SRGB), new THREE.Color().setHSL(0.11, 0.35, 0.30, SRGB)],
    };
    this._tmp = { v: new THREE.Vector3(), q: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0) };

    addEventListener("resize", () => this.resize());
    this.resize();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // s: signed trunk/lateral in [-1,1], head/protraction/elev in [0,1], headRoll/shoulderTilt in degrees,
  // wellbeing in [0,1], confidence in [0,1].
  setTarget(s) {
    const t = this.s;
    t.trunk.target = s.trunk; t.lateral.target = s.lateral; t.head.target = s.head;
    t.headRoll.target = THREE.MathUtils.clamp(s.headRoll, -35, 35);
    t.shoulderTilt.target = THREE.MathUtils.clamp(s.shoulderTilt, -20, 20);
    t.protraction.target = s.protraction; t.elevL.target = s.elevL; t.elevR.target = s.elevR;
    t.health.target = s.wellbeing;
    t.presence.target = s.confidence > 0.5 ? 1 : 0;
  }

  frame(dt, time) {
    dt = Math.min(dt, 1 / 30);
    const v = Object.fromEntries(Object.entries(this.s).map(([k, sp]) => [k, sp.step(dt)]));
    const wilt = 1 - smooth(0.25, 0.78, v.health);
    const sway = 0.025 * (0.4 + wilt) * Math.sin(time * 0.9);

    this.pot.rotation.z = -v.lateral * 0.13;

    // Spine: integrate per-segment bend angles into control points.
    // Trunk bend builds a C-curve in the lower 65%; the neck bends the top 35%.
    const trunkPitch = v.trunk * 0.95 + wilt * 0.35, neckPitch = v.head * 1.25 + wilt * 0.45;
    const roll = v.lateral * 0.75;
    let pitch = 0, rl = 0;
    const P = this.ctrl;
    P[0].set(0, POT_TOP - 0.05, 0);
    const trunkSegs = Math.round(STEM_SEGS * 0.65);
    const trunkNorm = (trunkSegs * (trunkSegs + 1)) / 2, neckSegs = STEM_SEGS - trunkSegs;
    for (let k = 0; k < STEM_SEGS; k++) {
      pitch += k < trunkSegs ? trunkPitch * (k + 1) / trunkNorm : neckPitch / neckSegs;
      pitch += sway * 0.15;
      rl += roll / STEM_SEGS + 0.01 * Math.sin(time * 0.7 + k * 0.4);
      const seg = STEM_LEN / STEM_SEGS;
      P[k + 1].set(Math.sin(rl), Math.cos(rl) * Math.cos(pitch), Math.cos(rl) * Math.sin(pitch)).multiplyScalar(seg).add(P[k]);
    }
    this.#writeStem();

    const { v: tmp, q, up } = this._tmp;

    // Bloom sits on the tip, aligned with the stem; head roll rotates it about the viewing axis.
    this.head.position.copy(P[STEM_SEGS]);
    this.head.quaternion.setFromUnitVectors(up, this.curve.getTangentAt(1, tmp));
    this.headInner.rotation.set(0, 0, -v.headRoll * D2R * 0.9);
    const open = v.bloom;
    for (const p of this.petals) {
      const healthy = p.inner ? lerp(0.25, 0.75, open) : lerp(0.3, 1.0, open);
      const wilted = p.inner ? 1.7 : 2.15;
      p.hinge.rotation.x = lerp(healthy, wilted, wilt) + p.jitter + 0.03 * Math.sin(time * 1.3 + p.jitter * 40);
      p.hinge.scale.setScalar(1 - 0.18 * wilt);
    }

    // Shoulders: leaves mount at the stem's "shoulder" height.
    const u = 0.52;
    this.leafMount.position.copy(this.curve.getPointAt(u, tmp));
    this.leafMount.quaternion.setFromUnitVectors(up, this.curve.getTangentAt(u, tmp));
    for (const L of this.leaves) {
      const elev = L.side > 0 ? v.elevR : v.elevL;
      const tiltDroop = L.side * v.shoulderTilt * D2R * 1.2;    // the lower shoulder's leaf droops
      const spread = 1.05 - 0.75 * elev + 0.85 * wilt + tiltDroop + 0.04 * elev * Math.sin(time * 28);
      // XYZ Euler: spread out to the side first, then swing around the stem toward the viewer.
      L.pivot.rotation.set(0, -L.side * v.protraction * 1.1, -L.side * spread);
      L.blade.rotation.y = L.side * v.protraction * 0.9;          // blade cups inward as it swings forward
    }

    // Colour: healthy -> wilted, dimmed slightly when nobody is in view.
    const dim = lerp(0.45, 1, v.presence);
    const mix = (pair, mat) => { mat.color.copy(pair[0]).lerp(pair[1], wilt).multiplyScalar(dim); };
    mix(this.colors.outer, this.petalOuterMat);
    mix(this.colors.inner, this.petalInnerMat);
    mix(this.colors.stem, this.stemMat);
    mix(this.colors.leaf, this.leafMat);
    // A little self-illumination so petals read as petals even when seen edge-on or from below.
    for (const m of [this.petalOuterMat, this.petalInnerMat]) m.emissive.copy(m.color).multiplyScalar(0.22);

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.values = v;
  }

  #writeStem() {
    const curve = this.curve;
    curve.updateArcLengths();
    const frames = curve.computeFrenetFrames(TUBE_SEGS, false);
    const pos = this.stem.geometry.attributes.position;
    const pt = this._tmp.v;
    let n = 0;
    for (let i = 0; i <= TUBE_SEGS; i++) {
      const s = i / TUBE_SEGS;
      curve.getPointAt(s, pt);
      const r = lerp(0.075, 0.032, s);
      const N = frames.normals[i], B = frames.binormals[i];
      for (let j = 0; j <= TUBE_RAD; j++) {
        const a = (j / TUBE_RAD) * Math.PI * 2, c = Math.cos(a) * r, si = Math.sin(a) * r;
        pos.setXYZ(n++, pt.x + c * N.x + si * B.x, pt.y + c * N.y + si * B.y, pt.z + c * N.z + si * B.z);
      }
    }
    pos.needsUpdate = true;
    this.stem.geometry.computeVertexNormals();
  }
}
