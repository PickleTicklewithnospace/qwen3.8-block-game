// Pure core of the redline alarm: as the settled stack climbs toward the
// top of the well the stage turns crimson and pulses like a heartbeat
// (the renderer owns the pixels; this module owns the level and the pulse
// math).
//
// `dangerOf(board)` maps the topmost occupied row to a 0..1 alarm level:
// 0 while the stack top is at or below DANGER_SAFE_ROW, 1 once it reaches
// DANGER_FULL_ROW (or any hidden row — a tower in the spawn zone is
// lock-out territory), linear in between. An empty well reads 0.
//
// `dangerBeat(t)` is the heartbeat envelope: 0..1 over DANGER_PERIOD
// seconds, a soft single thump per period (the renderer multiplies it
// into the tint strength). `dangerPulse(t, level)` is the resulting
// brightness multiplier (1 + AMP * beat * level); level 0 is the exact
// identity (1) so a calm stage is bit-identical to the pre-alarm grade.

export const DANGER_SAFE_ROW = 13; // stack top at/under this row: alarm off
export const DANGER_FULL_ROW = 7; // stack top at/above this row: alarm full
export const DANGER_PERIOD = 1.1; // seconds per heartbeat
export const DANGER_PULSE_AMP = 0.5; // brightness gain at the beat peak

// Topmost (smallest y) occupied row of the board, or -1 when the well is
// empty. Board y=0 is the top (hidden spawn rows first).
export function stackTopRow(board) {
  for (let y = 0; y < board.length; y++) {
    for (let x = 0; x < board[y].length; x++) {
      if (board[y][x] !== null) return y;
    }
  }
  return -1;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// 0..1 alarm level for the settled stack. Hidden-row stacks (topRow below
// the visible field) are lock-out imminent and read full alarm; an empty
// well reads 0.
export function dangerOf(board) {
  const top = stackTopRow(board);
  if (top < 0) return 0;
  if (top < DANGER_SAFE_ROW) {
    // top <= DANGER_FULL_ROW (or in a hidden row) saturates to full.
    if (top <= DANGER_FULL_ROW) return 1;
    return clamp01((DANGER_SAFE_ROW - top) / (DANGER_SAFE_ROW - DANGER_FULL_ROW));
  }
  return 0;
}

// Heartbeat envelope: 0..1, one soft thump per DANGER_PERIOD. t = 0 starts
// at the trough (the alarm ramps in before the first beat); non-finite t
// reads as "no beat".
export function dangerBeat(t) {
  if (!Number.isFinite(t)) return 0;
  const ph = (t % DANGER_PERIOD) / DANGER_PERIOD;
  return Math.pow(0.5 + 0.5 * Math.sin(ph * Math.PI * 2 - Math.PI / 2), 3);
}

// Brightness multiplier for the alarm tint at time t for alarm level
// (0..1). Level 0 is the exact identity (1) at every t; non-finite level
// reads as 0.
export function dangerPulse(t, level) {
  const l = Number.isFinite(level) ? clamp01(level) : 0;
  return 1 + dangerBeat(t) * DANGER_PULSE_AMP * l;
}