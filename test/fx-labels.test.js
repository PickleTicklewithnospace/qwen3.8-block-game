// Unit tests for the popup banner label logic (src/fx-labels.js): wording,
// tiers and priority order. The renderer only ever shows what popupFor says.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { popupFor, POPUP_TIERS, COMBO_BANNER_MIN, levelHue, LEVEL_HUE_STEP, streakIntensity, STREAK_LEVEL, flareEnv, boardEmpty } from '../src/fx-labels.js';

// ---- Perfect clear: the post-clear board is empty -------------------------

const emptyBoard = () => Array.from({ length: 22 }, () => Array(10).fill(null));

test('boardEmpty: a fully empty board (every row, hidden rows included) is empty', () => {
  assert.equal(boardEmpty(emptyBoard()), true);
});

test('boardEmpty: a single surviving block anywhere breaks the perfect clear', () => {
  const b = emptyBoard();
  b[5][0] = 'T';
  assert.equal(boardEmpty(b), false);
  const b2 = emptyBoard();
  b2[21][9] = 'I';
  assert.equal(boardEmpty(b2), false);
});

test('boardEmpty: hidden-row-only residue still counts as non-empty', () => {
  const b = emptyBoard();
  b[0][4] = 'O';
  b[1][5] = 'O';
  assert.equal(boardEmpty(b), false);
});

test('boardEmpty: a full board is obviously not empty', () => {
  const b = emptyBoard();
  for (const row of b) row.fill('S');
  assert.equal(boardEmpty(b), false);
});

test('TETRIS: a 4-line clear is the top priority', () => {
  assert.deepEqual(popupFor({ clears: 4, combo: 7, level: 9, prevLevel: 9 }), {
    text: 'TETRIS!',
    tier: 'tetris',
  });
});

test('TETRIS beats a simultaneous level-up (a 4-line clear that also levels up)', () => {
  assert.deepEqual(popupFor({ clears: 4, combo: 1, level: 5, prevLevel: 4 }), {
    text: 'TETRIS!',
    tier: 'tetris',
  });
});

test('level-up: crossing the line threshold shows LEVEL <new level>', () => {
  assert.deepEqual(popupFor({ clears: 1, combo: 1, level: 2, prevLevel: 1 }), {
    text: 'LEVEL 2',
    tier: 'level',
  });
});

test('level-up beats a double and a combo', () => {
  assert.deepEqual(popupFor({ clears: 2, combo: 5, level: 3, prevLevel: 2 }), {
    text: 'LEVEL 3',
    tier: 'level',
  });
});

// ---- Streak mode ignition -----------------------------------------------

test('streak ignition: crossing the streak level shows the STREAK banner', () => {
  assert.deepEqual(popupFor({ clears: 1, combo: 1, level: 10, prevLevel: 9 }), {
    text: 'STREAK',
    tier: 'streak',
  });
  assert.equal(STREAK_LEVEL, 10);
});

test('TETRIS beats a simultaneous streak ignition', () => {
  assert.deepEqual(popupFor({ clears: 4, combo: 1, level: 10, prevLevel: 9 }), {
    text: 'TETRIS!',
    tier: 'tetris',
  });
});

test('ignition fires exactly once: later level-ups are plain LEVEL banners', () => {
  assert.deepEqual(popupFor({ clears: 1, combo: 1, level: 11, prevLevel: 10 }), {
    text: 'LEVEL 11',
    tier: 'level',
  });
  assert.deepEqual(popupFor({ clears: 1, combo: 1, level: 20, prevLevel: 19 }), {
    text: 'LEVEL 20',
    tier: 'level',
  });
});

test('level-ups below the streak threshold stay LEVEL banners', () => {
  assert.deepEqual(popupFor({ clears: 1, combo: 1, level: 9, prevLevel: 8 }), {
    text: 'LEVEL 9',
    tier: 'level',
  });
});

test('streakIntensity: 0 below ignition, ramping from faint to full rainbow', () => {
  assert.equal(streakIntensity(1), 0);
  assert.equal(streakIntensity(9), 0);
  assert.ok(Math.abs(streakIntensity(10) - 1 / 11) < 1e-12);
  assert.ok(Math.abs(streakIntensity(15) - 6 / 11) < 1e-12);
  assert.equal(streakIntensity(20), 1);
  assert.equal(streakIntensity(40), 1);
});

test('streakIntensity clamps sub-level input (defensive)', () => {
  assert.equal(streakIntensity(0), 0);
  assert.equal(streakIntensity(-5), 0);
  assert.equal(streakIntensity(), 0);
});

test('combo: a streak of >= 3 consecutive clears earns a COMBO banner', () => {
  assert.deepEqual(popupFor({ clears: 1, combo: COMBO_BANNER_MIN, level: 1, prevLevel: 1 }), {
    text: `COMBO \u00d7${COMBO_BANNER_MIN}`,
    tier: 'combo',
  });
});

test('combo beats double and triple', () => {
  assert.equal(popupFor({ clears: 2, combo: 4, level: 1, prevLevel: 1 }).tier, 'combo');
  assert.equal(popupFor({ clears: 3, combo: 4, level: 1, prevLevel: 1 }).tier, 'combo');
});

test('combo below the threshold falls through to the clear-size banner', () => {
  assert.deepEqual(popupFor({ clears: 1, combo: 2, level: 1, prevLevel: 1 }), null);
  assert.equal(popupFor({ clears: 2, combo: 2, level: 1, prevLevel: 1 }).tier, 'double');
});

test('triple and double clear-size banners', () => {
  assert.deepEqual(popupFor({ clears: 3, combo: 1, level: 1, prevLevel: 1 }), {
    text: 'TRIPLE',
    tier: 'triple',
  });
  assert.deepEqual(popupFor({ clears: 2, combo: 1, level: 1, prevLevel: 1 }), {
    text: 'DOUBLE',
    tier: 'double',
  });
});

test('single clears and no-clear locks show nothing', () => {
  assert.equal(popupFor({ clears: 1, combo: 1, level: 1, prevLevel: 1 }), null);
  assert.equal(popupFor({ clears: 0, combo: 0, level: 1, prevLevel: 1 }), null);
});

test('defaults: missing fields read as a plain no-clear lock', () => {
  assert.equal(popupFor({}), null);
});

test('tier table is complete and ordered', () => {
  assert.deepEqual(POPUP_TIERS, ['tetris', 'streak', 'level', 'combo', 'triple', 'double']);
});

// ---- Stage palette: level -> hue offset ---------------------------------

test('level 1 is the neutral stage (no hue offset)', () => {
  assert.equal(levelHue(1), 0);
});

test('each level steps the palette by LEVEL_HUE_STEP', () => {
  assert.ok(Math.abs(levelHue(2) - LEVEL_HUE_STEP) < 1e-12);
  assert.ok(Math.abs(levelHue(3) - 2 * LEVEL_HUE_STEP) < 1e-12);
  assert.ok(Math.abs(levelHue(10) - 9 * LEVEL_HUE_STEP) < 1e-12);
});

test('the offset wraps into [0, 1) for deep levels', () => {
  // 19 * 0.055 = 1.045 -> wraps to 0.045: offsetHSL hue is periodic, so the
  // value must never escape [0, 1) or three's hue rotation drifts forever.
  const h = levelHue(20);
  assert.ok(h >= 0 && h < 1, `h=${h}`);
  assert.ok(Math.abs(h - (19 * LEVEL_HUE_STEP - 1)) < 1e-12);
  assert.ok(levelHue(100) < 1);
});

test('sub-level-1 input is clamped to the neutral palette (defensive)', () => {
  assert.equal(levelHue(0), 0);
  assert.equal(levelHue(-3), 0);
  assert.equal(levelHue(), 0);
});

// ---- Anamorphic flare envelope ------------------------------------------

test('flareEnv is off at and beyond the endpoints (and on garbage input)', () => {
  assert.equal(flareEnv(0), 0);
  assert.equal(flareEnv(1), 0);
  assert.equal(flareEnv(-3), 0);
  assert.equal(flareEnv(2), 0);
  assert.equal(flareEnv(NaN), 0);
});

test('flareEnv holds full intensity through the middle of the life', () => {
  assert.equal(flareEnv(0.15), 1);
  assert.equal(flareEnv(0.44), 1);
});

test('flareEnv attacks fast and decays slow (punch-in, then a filmic tail)', () => {
  // Halfway through the 10% attack it is already 0.5 bright; at 90% of the
  // life the slow decay has nearly finished. The asymmetry IS the moment.
  assert.ok(flareEnv(0.05) > 0.4, `attack ${flareEnv(0.05)}`);
  assert.ok(flareEnv(0.9) < 0.12, `tail ${flareEnv(0.9)}`);
  assert.ok(flareEnv(0.05) > flareEnv(0.9));
});

test('flareEnv decays monotonically from the hold down to zero', () => {
  let prev = 1;
  for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 0.99]) {
    const v = flareEnv(t);
    assert.ok(v < prev, `not monotonic at t=${t}: ${v} >= ${prev}`);
    prev = v;
  }
  assert.ok(flareEnv(0.99) < 0.02, `end ${flareEnv(0.99)}`);
});