// The posture visuals the app can show. Each one takes a container and implements:
//   setTarget(state)  step(dt, time)  render()  renderLcd(renderer)  dispose()
// and exposes `lcdCamera` (the external screen's view). Modules load on first use, so only the chosen one costs anything.
import * as THREE from "three";

// EMA visuals (src/ema.js) are by Jihoon Park, from jihoonpark-mde/ema-visualization.
const ema = surface => () => import("./ema.js").then(m => class extends m.EmaVisual {
  constructor(container, opts) { super(container, { ...opts, surface }); }
});
export const VISUALS = {
  "ema-liquid": { label: "EMA: liquid metaball", load: ema("liquid") },
  "ema-contour": { label: "EMA: contour metaball", load: ema("contour") },
  "ema-dandelion": { label: "EMA: dandelion", load: ema("dandelion") },
  "ema-branching": { label: "EMA: branching dandelion", load: ema("branching") },
  blob: { label: "Jello blob", load: () => import("./blob.js").then(m => m.JelloBlob) },
};
export const DEFAULT_VISUAL = "ema-liquid";

const BLACK = new THREE.Color(0x000000);

// LCD frames are drawn on black (suits the panel and compresses better) without the floor,
// which would otherwise read as a grey disc.
export function renderOnBlack(renderer, scene, camera, ground) {
  const bg = scene.background, fog = scene.fog?.color.getHex();
  scene.background = BLACK;
  scene.fog?.color.copy(BLACK);
  ground.visible = false;
  renderer.render(scene, camera);
  scene.background = bg;
  scene.fog?.color.setHex(fog);
  ground.visible = true;
}

// Frees a visual's WebGL context; browsers cap how many can be alive at once.
export function disposeRenderer(renderer) {
  renderer.dispose();
  renderer.forceContextLoss();
  renderer.domElement.remove();
}
