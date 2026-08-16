// Pure gameplay timing: DAS/ARR auto-shift, soft-drop repeat, gravity and
// the lock delay. Extracted from main.js so the timing rules can be unit
// tested with an exact synthetic clock instead of real frames.
//
// Everything is driven by `dt` (ms elapsed since the previous frame), so the
// same code runs identically at 30fps, 144fps, or in a test that feeds it
// 1ms steps.

import {
  CONFIG,
  TOTAL_ROWS,
  gravityIntervalMs,
  isGrounded,
  movePiece,
  softDrop,
  stepGravity,
} from './engine.js';

// Frames longer than this are clamped: after a tab switch or a GC pause the
// game must not teleport the piece by simulating the whole gap at once.
export const MAX_FRAME_MS = 100;

export function createTiming() {
  return {
    gravityAccum: 0,
    lockTimer: null, // ms grounded; null when airborne
    das: 0,
    arr: 0,
    softAccum: 0,
    freeze: 0, // ms of line-clear dash left
  };
}

// Soft drop interval. `softDropFactor` accelerates gravity, but never slower
// than the level's natural fall speed.
export function softDropIntervalMs(level) {
  const g = gravityIntervalMs(level);
  return Math.min(30, g / CONFIG.softDropFactor);
}

// Restart the auto-shift charge. Call whenever the active horizontal
// direction changes (fresh press, or falling back to a still-held key) so
// the next repeat starts from a full DAS delay.
export function resetShift(t) {
  t.das = 0;
  t.arr = 0;
}

// Call after any successful player-driven move/rotation. The engine owns the
// lock-delay reset budget (`game.lock.lastReset` reports whether a reset was
// actually granted), so rapid tapping can never hold a piece up forever.
export function notifyMoved(game, t) {
  if (game.lock.lastReset) t.lockTimer = 0;
}

// Called by the frontend after a lock (or hold) so the next piece starts
// with a clean clock.
export function resetForNewPiece(t) {
  t.lockTimer = null;
  t.gravityAccum = 0;
  t.softAccum = 0;
}

export function startFreeze(t, ms) {
  t.freeze = Math.max(t.freeze, ms);
}

// A lock (or hold) ends the previous line-clear dash: the new piece must not
// sit frozen for the remainder of a dash it did not cause. Call before
// (re)starting a freeze for the new lock's own clear, if any.
export function clearFreeze(t) {
  t.freeze = 0;
}

// Advance one frame. `input` is { dir: -1|0|1, soft: boolean }.
// `hooks.lock()` must lock the current piece (the frontend needs to capture
// FX state around the lock, so the loop delegates instead of locking itself).
export function advanceFrame(game, t, dtRaw, input, hooks = {}) {
  const dt = Math.min(Math.max(dtRaw, 0), MAX_FRAME_MS);
  const moved = hooks.moved || (() => {});

  if (t.freeze > 0) {
    t.freeze = Math.max(0, t.freeze - dt);
    return;
  }
  if (game.paused || game.gameOver) return;

  // --- Horizontal auto-shift ---
  if (input.dir !== 0) {
    t.das += dt;
    if (t.das >= CONFIG.DASMs) {
      t.arr += dt;
      // Bounded: a single frame can never shift further than the board.
      for (let i = 0; t.arr >= CONFIG.ARRMs && i < TOTAL_ROWS; i++) {
        t.arr -= CONFIG.ARRMs;
        if (!movePiece(game, input.dir, 0)) {
          t.arr = 0; // resting against a wall: don't bank repeats
          break;
        }
        moved();
      }
    }
  } else {
    resetShift(t);
  }

  // --- Soft drop repeat ---
  if (input.soft) {
    const interval = softDropIntervalMs(game.level);
    t.softAccum += dt;
    for (let i = 0; t.softAccum >= interval && i < TOTAL_ROWS; i++) {
      t.softAccum -= interval;
      if (!softDrop(game)) {
        t.softAccum = 0; // grounded: the lock delay takes over
        break;
      }
      moved();
    }
  } else {
    t.softAccum = 0;
  }

  // --- Gravity ---
  // Natural gravity only. While Down is held, the soft-drop repeat above owns
  // the fall: letting gravity tick as well would add unscored rows on top of
  // the soft drop (rows fallen > soft-drop score). The accumulator is frozen
  // while soft is held, so releasing Down can never release a banked burst of
  // gravity (at most one stale row, always under one interval).
  if (!input.soft) {
    const interval = gravityIntervalMs(game.level);
    t.gravityAccum += dt;
    for (let i = 0; t.gravityAccum >= interval && i < TOTAL_ROWS; i++) {
      t.gravityAccum -= interval;
      if (stepGravity(game) !== 'fell') {
        // Blocked: drop the remaining credit instead of banking it. Otherwise
        // a piece that rests on a ledge through several slow frames stores up
        // gravity and teleports down when it finally slides off.
        t.gravityAccum = 0;
        break;
      }
    }
  }

  // --- Lock delay ---
  // Real-time, independent of the gravity interval. (Driving it from gravity
  // ticks made the delay equal to one gravity interval and made every
  // move/rotation reset a no-op at low levels — no sliding under overhangs.)
  if (isGrounded(game)) {
    if (t.lockTimer === null) t.lockTimer = 0;
    t.lockTimer += dt;
    if (t.lockTimer >= CONFIG.lockDelayMs) {
      if (hooks.lock) hooks.lock();
      return;
    }
  } else {
    t.lockTimer = null;
  }
}
