// Thin wrapper around MediaPipe PoseLandmarker (VIDEO mode, single person).
import { FilesetResolver, PoseLandmarker, DrawingUtils } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/vision_bundle.mjs";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
const modelUrl = m => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/latest/pose_landmarker_${m}.task`;

export class PoseEngine {
  constructor() { this.landmarker = null; this.model = null; this.lastTs = 0; this.ms = 0; }

  async load(model = "heavy") {
    this.vision ??= await FilesetResolver.forVisionTasks(WASM);
    this.landmarker?.close();
    this.landmarker = await PoseLandmarker.createFromOptions(this.vision, {
      baseOptions: { modelAssetPath: modelUrl(model), delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    this.model = model;
  }

  // Returns { lm, world } for the first pose, or null.
  detect(source) {
    const ts = Math.max(performance.now(), this.lastTs + 1); // timestamps must strictly increase
    this.lastTs = ts;
    const t0 = performance.now();
    const r = this.landmarker.detectForVideo(source, ts);
    this.ms = performance.now() - t0;
    return r.landmarks[0] ? { lm: r.landmarks[0], world: r.worldLandmarks[0] } : null;
  }
}

export function drawSkeleton(ctx, lm) {
  const du = new DrawingUtils(ctx);
  du.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: "rgba(120,255,170,0.8)", lineWidth: 2 });
  du.drawLandmarks(lm, { radius: l => 1 + 3 * (l.visibility ?? 0), color: "rgba(255,120,200,0.9)", fillColor: "rgba(255,120,200,0.9)" });
}
