// Pure sky-meteor kinematics + brightness envelope for the renderer's
// shooting-star FX. The renderer owns the pixels (head/tail quads, shed
// sparks); this module owns where a meteor is at a given time and how
// bright it is, so the flight math is unit-testable and mutation-guarded.
//
// A meteor spec is { x0, y0, vx, vy, z, t0, life, tail }: it travels a
// straight world-space line from (x0, y0, z) for `life` seconds. The
// brightness envelope fades in over the first FADE_IN fraction and out over
// the last part of the life (smoothstep, so the head never pops on/off).
// `tail` is the trail length in world units (renderer-side only).

export const FADE_IN = 0.15; // fraction of the life spent fading in
export const FADE_OUT_START = 0.7; // fade-out begins this far into the life

function smooth(a, b, v) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Brightness envelope 0..1 over the normalized life u.
export function meteorFade(u) {
  if (u < 0 || u > 1) return 0;
  return smooth(0, FADE_IN, u) * (1 - smooth(FADE_OUT_START, 1, u));
}

// Meteor state at absolute time t: null outside the flight (before t0 or
// after t0 + life); otherwise the world position, the normalized life u and
// the envelope alpha.
export function meteorState(m, t) {
  const dt = t - m.t0;
  if (dt < 0 || dt > m.life) return null;
  const u = dt / m.life;
  return {
    x: m.x0 + m.vx * dt,
    y: m.y0 + m.vy * dt,
    u,
    alpha: meteorFade(u),
  };
}

// Rotation about Z that points a trail quad's +X axis (its bright texture
// end) along the meteor's velocity, so the bright end leads at the head and
// the tail trails behind — works for either entry side without mirroring.
export function meteorTailAngle(vx, vy) {
  return Math.atan2(vy, vx);
}

// A random-but-bounded auto-spawn spec: a side entry from left or right of
// the sky band (above the frame top at y ~20.2), falling diagonally across
// it. The path stays in front of the aurora plane (z -45) and behind the
// board, so the frosted panel occludes the exit naturally.
export function meteorSpawnSpec(t) {
  const side = Math.random() < 0.5 ? -1 : 1;
  return {
    x0: side * (11 + Math.random() * 3),
    y0: 20 + Math.random() * 7,
    vx: -side * (15 + Math.random() * 9),
    vy: -(4 + Math.random() * 6),
    z: -30,
    t0: t,
    life: 0.9 + Math.random() * 0.5,
    tail: 4.5 + Math.random() * 2.5,
  };
}