// MediaPipe PoseLandmarker (VIDEO mode, single person), run in a worker (pose-worker.js) so the page stays smooth.
import { PoseLandmarker, DrawingUtils } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/vision_bundle.mjs";

export class PoseEngine {
  constructor() {
    this.worker = new Worker(new URL("./pose-worker.js", import.meta.url));
    this.calls = new Map();
    this.nextId = 1;
    this.worker.onmessage = ({ data }) => {
      const c = this.calls.get(data.id);
      this.calls.delete(data.id);
      data.error ? c?.reject(new Error(data.error)) : c?.resolve(data);
    };
    // A crash inside the worker would otherwise leave callers waiting forever.
    this.worker.onerror = e => {
      for (const c of this.calls.values()) c.reject(new Error(e.message || "pose worker failed"));
      this.calls.clear();
    };
    this.ready = false; this.model = null; this.lastTs = 0; this.ms = 0;
  }

  #call(msg, transfer, timeoutMs = 0) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs && setTimeout(() => {
        this.calls.delete(id);
        reject(new Error("pose model didn't answer"));
      }, timeoutMs);
      const done = f => v => { clearTimeout(timer); f(v); };
      this.calls.set(id, { resolve: done(resolve), reject: done(reject) });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  async load(model = "heavy") {
    this.ready = false;
    await this.#call({ type: "load", model });
    this.model = model;
    this.ready = true;
  }

  // Resolves to { lm, world } for the first pose, or null. `source` is a video, image or canvas.
  async detect(source) {
    const ts = Math.max(performance.now(), this.lastTs + 1); // timestamps must strictly increase
    this.lastTs = ts;
    const frame = await createImageBitmap(source);
    const r = await this.#call({ type: "detect", frame, ts }, [frame], 15000);   // ~30-150 ms normally; the first can be slow
    this.ms = r.ms;
    return r.lm ? { lm: r.lm, world: r.world } : null;
  }
}

export function drawSkeleton(ctx, lm) {
  const du = new DrawingUtils(ctx);
  du.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: "rgba(120,255,170,0.8)", lineWidth: 2 });
  du.drawLandmarks(lm, { radius: l => 1 + 3 * (l.visibility ?? 0), color: "rgba(255,120,200,0.9)", fillColor: "rgba(255,120,200,0.9)" });
}
