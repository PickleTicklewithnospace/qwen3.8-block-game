// Pure core of the stardust wake: the active piece sheds piece-colored
// stardust as it descends (the renderer's per-frame FX).
//
// The renderer accumulates the piece's rendered DOWNWARD motion (world
// units; board +y is down, world +y is up, so a falling piece's target
// world y DROPS) between frames. For every WAKE_STEP of banked descent
// it sheds one mote; upward motion (a wall kick) drains the bank
// WAKE_DRAIN units per unit so a piece that nudges up can't bank dust
// it never earned. A hard drop sheds no dust: the fresh spawn that
// follows always jumps the target back UP, which drains the bank.

export const WAKE_STEP = 0.3; // world units of fall per mote
export const WAKE_DRAIN = 2; // upward motion drains this many units per unit
export const WAKE_CAP = 64; // runaway guard on motes per frame

/**
 * Advance the wake bank by one frame's target delta WITHOUT spending it:
 * downward motion adds to the bank, upward motion drains it WAKE_DRAIN
 * units per unit (floored at 0). The renderer banks silently while the
 * piece is hidden (or the stage is dark) and spends the whole bank the
 * moment the piece is visible — a stardust burst as it materializes into
 * the field. Non-finite dy is treated as no motion; a non-finite acc is
 * reset to 0.
 */
export function wakeBank(acc, dy) {
  if (!Number.isFinite(dy)) dy = 0;
  if (!Number.isFinite(acc)) acc = 0;
  if (dy > 0) acc += dy;
  else if (dy < 0) acc = Math.max(0, acc + dy * WAKE_DRAIN);
  return acc;
}

/**
 * Advance the wake accumulator by one frame's target delta and return
 * { acc, n }: the new bank plus how many motes to shed (one per
 * WAKE_STEP of banked descent, capped at WAKE_CAP per frame).
 * dy > 0 means the piece moved DOWN (its target world y dropped).
 */
export function wakeStep(acc, dy) {
  acc = wakeBank(acc, dy);
  let n = 0;
  while (acc >= WAKE_STEP && n < WAKE_CAP) {
    acc -= WAKE_STEP;
    n += 1;
  }
  return { acc, n };
}