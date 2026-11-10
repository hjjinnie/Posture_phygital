// Runs MediaPipe PoseLandmarker off the page's main thread. Its GPU inference blocks the calling thread for
// ~30-50 ms per frame, which on the main thread held the 3D view and the external-screen stream back
// (measured: stream 16 → 27 fps and view 23 → 40 fps with inference out of the way).
// A classic worker (not a module): MediaPipe loads its WebAssembly glue with importScripts(), which only
// registers the glue's globals in a classic worker. So the library comes from its CommonJS bundle, evaluated at
// global scope into `exports` (the CDN serves .cjs with a type importScripts() refuses).
const BUNDLE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/vision_bundle.cjs";
self.exports = {};
let FilesetResolver, PoseLandmarker;
async function loadLibrary() {
  if (PoseLandmarker) return;
  (0, eval)(await (await fetch(BUNDLE)).text());
  ({ FilesetResolver, PoseLandmarker } = self.exports);
}

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
const modelUrl = m => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/latest/pose_landmarker_${m}.task`;

let vision, landmarker;

onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      await loadLibrary();
      vision ??= await FilesetResolver.forVisionTasks(WASM);
      landmarker?.close();
      landmarker = null;
      landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: modelUrl(data.model), delegate: "GPU" },
        canvas: new OffscreenCanvas(1, 1),
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      postMessage({ id: data.id });
    } else if (data.type === "detect") {
      const t0 = performance.now();
      const r = landmarker.detectForVideo(data.frame, data.ts);
      data.frame.close();
      postMessage({ id: data.id, ms: performance.now() - t0, lm: r.landmarks[0] ?? null, world: r.worldLandmarks[0] ?? null });
    }
  } catch (e) {
    data.frame?.close();
    postMessage({ id: data.id, error: String(e?.message ?? e) });
  }
};
