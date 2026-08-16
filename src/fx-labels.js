// Pure label logic for the 3D popup banners: given what just happened on a
// lock (lines cleared, running combo, level before/after the lock), decide
// which banner to show. The renderer owns the pixels; this module owns the
// wording, the tier (which drives size/color/lifetime on screen) and the
// priority order.
//
// Priority: TETRIS > streak ignition > level-up > long combo > triple >
// double. Singles and no-clear locks show nothing — they get the lock-
// impact splash instead, and a banner on every single clear would be noise,
// not signal.
//
// `combo` is the number of consecutive clear-locks INCLUDING this one
// (the first clear of a streak is combo 1, the second combo 2, ...).
// `level`/`prevLevel` are the engine level after/before the lock.

export const POPUP_TIERS = ['tetris', 'streak', 'level', 'combo', 'triple', 'double'];

export const COMBO_BANNER_MIN = 3; // a streak this long earns its own banner

// Stage palette: the level maps to a hue offset the renderer applies to the
// whole stage (aurora sky, neon frame, glow bar, mirror/panel grids, sky
// background). 0.055 in three's offsetHSL hue units (~20 deg per level) is
// enough that each level visibly re-inks the stage while staying in the
// cool-to-warm neon range for a long time (a full 360 deg cycle every
// ~18 levels). Level 1 is the neutral palette (offset 0).
export const LEVEL_HUE_STEP = 0.055;

export function levelHue(level = 1) {
  const h = (Math.max(1, level) - 1) * LEVEL_HUE_STEP;
  return h % 1; // offsetHSL hue is periodic; keep the value in [0, 1)
}

// Streak mode: at STREAK_LEVEL the settled stack ignites into a living
// rainbow (the renderer's per-block hue wave). The banner fires on the
// ignition crossing itself (level 9 -> 10); the wave amplitude ramps from
// a faint tint at the ignition level to a full rainbow
// STREAK_RAMP_LEVELS later (level 20).
export const STREAK_LEVEL = 10;
export const STREAK_RAMP_LEVELS = 10;

export function streakIntensity(level = 1) {
  if (level < STREAK_LEVEL) return 0;
  return Math.min(1, (level - STREAK_LEVEL + 1) / (STREAK_RAMP_LEVELS + 1));
}

// Anamorphic flare envelope: the TETRIS / streak-ignition lens event. A fast
// smoothstep attack (bright punch-in over the first 10% of the life), a
// short hold at full intensity, then a slow filmic decay to 0 over the last
// 55%. t is normalized to [0,1] over the flare's lifetime (the renderer's
// FLARE_LIFE); both the grade pass's full-width screen streak and the 3D
// bloom-carrying streak quad read this envelope so they fade in sync.
// Out-of-range and NaN input reads as "off" (0).
export function flareEnv(t) {
  if (!(t > 0) || t >= 1) return 0;
  const u = t < 0.1 ? t / 0.1 : 1;
  const atk = u * u * (3 - 2 * u);
  const d = t < 0.45 ? 0 : (t - 0.45) / 0.55;
  const dec = 1 - (d * d * (3 - 2 * d));
  return atk * dec;
}

// Perfect clear: after the line clear, NO block remains anywhere on the
// board (every row, hidden spawn rows included, is empty). The settled
// stack is the only content a board can hold, so a zeroed board is the
// unambiguous "the well is empty again" signal. Hidden-row-only residue
// still counts as non-empty (and in practice a hidden-row lock is a
// lock-out, not a perfect clear).
export function boardEmpty(board) {
  for (const row of board) {
    for (const cell of row) if (cell !== null) return false;
  }
  return true;
}

export function popupFor({ clears = 0, combo = 0, level, prevLevel }) {
  if (clears >= 4) return { text: 'TETRIS!', tier: 'tetris' };
  if (level >= STREAK_LEVEL && prevLevel < STREAK_LEVEL) {
    return { text: 'STREAK', tier: 'streak' };
  }
  if (level > prevLevel) return { text: `LEVEL ${level}`, tier: 'level' };
  if (combo >= COMBO_BANNER_MIN) return { text: `COMBO \u00d7${combo}`, tier: 'combo' };
  if (clears === 3) return { text: 'TRIPLE', tier: 'triple' };
  if (clears === 2) return { text: 'DOUBLE', tier: 'double' };
  return null;
}