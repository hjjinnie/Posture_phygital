# Posture metrics

Each bar is a severity from 0 to 100, measured against your calibrated "sitting tall" posture.
It stays at 0 inside a small tolerance and reaches 100 at a clearly bad position (`TOLERANCE` in `src/posture.js`).
Everything is measured from ears and shoulders, which a laptop camera sees reliably.
Distances are divided by shoulder width, so sitting closer to or further from the camera doesn't change them.

## Trunk slump
Upper body collapsing forward, or reclining too far back. Stands in for "spine perpendicular to thighs".

Thighs are out of frame, so the angle isn't measured directly. When you slump, your shoulders sink in the image and come toward the camera (look wider):
`trunk = shoulder drop + 1.5 × shoulder-width growth`.
Signed: forward is positive, leaning back is negative. Flower: the stem bends into a C-curve.

Caveat: leaning in with a straight back looks similar from the front.

## Ear–shoulder–hip
Whether ears, shoulders and hips stack in one vertical line seen from the side.

From the front that line points into the lens and the hips are out of frame, so it's inferred:
`0.5 × trunk + 0.7 × forward head`. A side camera would measure it properly.

## Side balance
Weight shifted to one side: leaning on an elbow, crossed legs, sagging toward an armrest.

60% shoulder-line tilt vs. calibration (8° = 1 unit), 40% sideways shift of the shoulder midpoint (¼ shoulder width = 1 unit).
Signed and mirrored (L/R). Flower: the stem leans and the pot tips. The most reliable signal from the front: a 6° tilted test photo read back as 6°.

Caveat: true weight distribution needs a seat pressure sensor; the camera sees the posture that goes with it.

## Forward head
"Tech neck": head sliding forward and down. Clinically measured as the craniovertebral angle from the side (below ~50° is commonly treated as forward head).

Three signals:
1. Neck ratio: ear height above shoulders ÷ shoulder width. The neck seems to disappear as the head drops. Upright ≈ 0.49, hunched ≈ 0.14, noise ±0.003.
2. Head size relative to shoulders: the head looks bigger as it moves ahead of the shoulders.
3. MediaPipe's 3D estimate of ear depth vs. shoulder depth.

Flower: the top of the stem nods and the bloom droops; head roll tilts the bloom.

Caveat: a deliberate nod toward the keyboard also counts; the slow health average absorbs short glances.

## Shoulders
Two things:
- Rounded forward (protraction): 3D shoulder-to-shoulder distance shrinks.
- Raised (not relaxed): each shoulder's rise, minus any rise of the whole head, so sitting up taller doesn't count.

The bar shows whichever is worse ("fwd" or "up"). Flower: leaves swing forward, or lift and tremble; one raised shoulder lifts one leaf.

Caveat: the noisiest signal (3D shoulder width wobbles ±1.5% at rest), so its tolerance is wider.

## Overall
Posture score = 100 − weighted severities: trunk 25%, forward head 25%, side balance 20%, ear–shoulder–hip 15%, shoulders 15%.
Flower health is that score averaged over ~45 s; it opens or wilts the petals.
