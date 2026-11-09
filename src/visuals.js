// The posture visuals the app can show. Each one takes a container and implements:
//   setTarget(state)  step(dt, time)  render()  renderLcd(renderer)  dispose()
// and exposes `scene`, `camera`, `renderer`. Modules load on first use, so only the chosen one costs anything.
import * as THREE from "three";

export const VISUALS = {
  flower: { label: "Flower", load: () => import("./flower.js").then(m => m.Flower) },
  blob: { label: "Jello blob", load: () => import("./blob.js").then(m => m.JelloBlob) },
};

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
