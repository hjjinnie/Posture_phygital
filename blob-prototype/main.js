import { Flower } from "../src/flower.js";
import { JelloBlob } from "../src/blob.js";

const $ = id => document.getElementById(id);
const BASE = { trunk: 0, lateral: 0, head: 0, headRoll: 0, shoulderTilt: 0, protraction: 0, elevL: 0, elevR: 0, wellbeing: 0.92, confidence: 1 };

const PRESETS = [
  { name: "Upright, relaxed", s: {}, flower: "Open pink bloom, straight stem", blob: "Perfect sphere, floating high; soft mint, smiles and blinks" },
  { name: "Slumped", s: { trunk: 0.9, head: 0.25 }, flower: "Stem bends into a C", blob: "Curls into a bean, turns indigo, looks down" },
  { name: "Reclined", s: { trunk: -0.75 }, flower: "Stem arches back", blob: "Arches back, turns sky blue" },
  { name: "Forward head", s: { head: 0.9, trunk: 0.15 }, flower: "Bloom nods forward", blob: "Top lobe swells and droops, turns amber" },
  { name: "Leaning right", s: { lateral: 0.85, shoulderTilt: 9 }, flower: "Stem and pot lean", blob: "Jelly pools into a bulb, neck tips over, lemon" },
  { name: "Leaning left", s: { lateral: -0.85, shoulderTilt: -9 }, flower: "Stem and pot lean", blob: "Mirror of leaning right" },
  { name: "Head tilted", s: { headRoll: 25 }, flower: "Bloom rolls", blob: "Face tilts; body stays put" },
  { name: "Shoulders shrugged", s: { elevL: 0.9, elevR: 0.9 }, flower: "Leaves lift and tremble", blob: "Droplets stretch off the top and drift up; hot pink, lumpy" },
  { name: "Shoulders rounded", s: { protraction: 0.9 }, flower: "Leaves swing forward", blob: "Droplets stretch out in front and slowly circle" },
  { name: "Left shoulder up", s: { elevL: 0.85, shoulderTilt: -7 }, flower: "One leaf lifts", blob: "Only the left side sheds droplets" },
  { name: "Poor posture for minutes", s: { trunk: 0.6, head: 0.5, protraction: 0.45, wellbeing: 0.1 }, flower: "Petals close and brown", blob: "Sinks low, sags, goes cloudy and dull, sheds droplets, frowns" },
  { name: "Nobody in view", s: { wellbeing: 0.75, confidence: 0 }, flower: "Dims", blob: "Dims, drifts lower, eyes closed, breathes slowly" },
];

const SLIDERS = [["trunk", -1, 1], ["lateral", -1, 1], ["head", 0, 1], ["headRoll", -30, 30], ["shoulderTilt", -15, 15],
  ["protraction", 0, 1], ["elevL", 0, 1], ["elevR", 0, 1], ["wellbeing", 0, 1], ["confidence", 0, 1]];

const flower = new Flower($("flowerStage"));
const blob = new JelloBlob($("blobStage"));
window.proto = { flower, blob };
let current = { ...BASE }, active = 0;

$("sliders").innerHTML = SLIDERS.map(([k, lo, hi]) =>
  `<label class="slider">${k}<input type="range" min="${lo}" max="${hi}" step="0.01" data-k="${k}"><span id="sv-${k}"></span></label>`).join("");
function syncSliders() {
  for (const [k] of SLIDERS) {
    $("sliders").querySelector(`[data-k=${k}]`).value = current[k];
    $(`sv-${k}`).textContent = (+current[k]).toFixed(2);
  }
}
$("sliders").addEventListener("input", e => {
  const k = e.target.dataset.k;
  current[k] = +e.target.value; $(`sv-${k}`).textContent = current[k].toFixed(2);
  active = -1; markPreset(); $("tour").checked = false;
});

$("presets").innerHTML = PRESETS.map((p, i) => `<button data-i="${i}">${p.name}</button>`).join("");
$("presets").addEventListener("click", e => { if (e.target.dataset.i) { $("tour").checked = false; choose(+e.target.dataset.i); } });
function markPreset() {
  $("presets").querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", i === active));
  const p = PRESETS[active];
  $("note").innerHTML = p ? `<b>Flower:</b> ${p.flower}<br><b>Blob:</b> ${p.blob}` : "<span style='color:var(--dim)'>Custom (sliders)</span>";
}
function choose(i) {
  active = i;
  current = { ...BASE, ...PRESETS[i].s };
  syncSliders(); markPreset();
  document.querySelector(".live").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
choose(0);

let tourAt = 0;
let last = performance.now(), fps = 60;
function loop(now) {
  const dt = (now - last) / 1000; last = now;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  if ($("tour").checked && now - tourAt > 4000) { tourAt = now; choose((active + 1) % PRESETS.length); }
  flower.setTarget(current); blob.setTarget(current);
  if (!$("pauseFlower").checked) flower.frame(dt, now / 1000);
  blob.frame(dt, now / 1000);
  const v = blob.values;
  $("blobInfo").innerHTML = `<span class="swatch" style="background:${v.color}"></span>${v.color} · wilt ${v.wilt.toFixed(2)} · tension ${v.tension.toFixed(2)}`;
  $("foot").textContent = `${fps.toFixed(0)} fps (both views${$("pauseFlower").checked ? ", flower paused" : ""})`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---- gallery: settle each state in hidden renderers and snapshot them ----
async function buildGallery() {
  const fl = new Flower($("offFlower")), bl = new JelloBlob($("offBlob"));
  const cards = [];
  for (const [i, p] of PRESETS.entries()) {
    const s = { ...BASE, ...p.s };
    fl.setTarget(s);
    for (const sp of Object.values(fl.s)) { sp.x = sp.target; sp.v = 0; }
    fl.frame(1 / 60, 2);
    const fImg = fl.renderer.domElement.toDataURL("image/jpeg", 0.9);
    bl.setTarget(s);
    bl.settle(2);
    const bImg = bl.renderer.domElement.toDataURL("image/jpeg", 0.9);
    cards.push(`<div class="card" data-i="${i}"><div class="t">${p.name}</div>
      <div class="pair"><img src="${fImg}" alt="Flower: ${p.flower}"><img src="${bImg}" alt="Blob: ${p.blob}"></div>
      <div class="cap"><div>${p.flower}</div><div><span class="swatch" style="background:${bl.values.color}"></span>${p.blob}</div></div></div>`);
    await new Promise(r => setTimeout(r, 0));   // not rAF: keeps going in a background tab
  }
  $("gallery").innerHTML = cards.join("");
  fl.renderer.dispose(); bl.dispose();
}
$("gallery").addEventListener("click", e => { const c = e.target.closest(".card"); if (c) { $("tour").checked = false; choose(+c.dataset.i); } });
buildGallery();
