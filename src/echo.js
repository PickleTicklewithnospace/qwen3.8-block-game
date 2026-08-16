// Holographic rotation echo: when the active piece rotates, the renderer
// flashes the PRE-rotation footprint as a holo afterimage (the same shader
// as the ghost faces) that swells slightly and fades out. This module owns
// the envelope math so the timing/easing is pure, unit-tested and
// mutation-guarded; the renderer (src/renderer3d.js) owns the pool.

// Afterimage lifetime in tick-time seconds (brief: a rotation flicker must
// read as a shimmer, not a smeared double).
export const ECHO_LIFE = 0.34;

// Minimum tick-time gap between two echoes (rotation flicker must not stack
// a wall of afterimages; the piece itself only moves one state per key).
export const ECHO_THROTTLE = 0.1;

// Fractional size swell across the life (the holo dissipates outward).
export const ECHO_GROWTH = 0.14;

// Fade envelope over k = t / ECHO_LIFE: full at k=0, gone at k>=1, eased
// OUT (pow 0.6) so the afterimage holds its shape a beat, then dissolves
// fast. NaN is treated as "just spawned" (full brightness); +Infinity
// falls through to the k>=1 hard zero — the pool hides the slot there.
export function echoFade(k) {
  if (Number.isNaN(k) || k <= 0) return 1;
  if (k >= 1) return 0;
  return Math.pow(1 - k, 0.6);
}

// Swell: starts at scale 1 and eases to 1 + ECHO_GROWTH by the end (linear
// in k — the dissolve carries the easing).
export function echoScale(k) {
  if (Number.isNaN(k) || k <= 0) return 1;
  if (k >= 1) return 1 + ECHO_GROWTH;
  return 1 + ECHO_GROWTH * k;
}