// Timing tests for src/loop.js — the frame-level rules the player actually
// feels: lock delay, gravity, soft drop and auto-shift. Driven by a synthetic
// clock so every assertion is exact.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame,
  createBoard,
  CONFIG,
  COLS,
  TOTAL_ROWS,
  ghostY,
  isGrounded,
  gravityIntervalMs,
  lockPiece,
} from '../src/engine.js';
import {
  createTiming,
  advanceFrame,
  notifyMoved,
  resetForNewPiece,
  resetShift,
  startFreeze,
  clearFreeze,
  softDropIntervalMs,
  MAX_FRAME_MS,
} from '../src/loop.js';

const FRAME = 16;

// A game with an empty board and a piece placed exactly where we want it.
function rig({ type = 'O', x = 4, y = 0, level = 1, board = createBoard() } = {}) {
  const g = createGame(1);
  g.board = board;
  g.current = { type, rotation: 0, x, y };
  g.level = level;
  return g;
}

// Drop the current piece to its landing row so it is grounded.
function ground(g) {
  g.current.y = ghostY(g);
  assert.ok(isGrounded(g), 'rig should be grounded');
}

// Feed `ms` of frames. Returns the recorded hook calls.
function run(g, t, ms, { dir = 0, soft = false, dt = FRAME, lockFn = lockPiece } = {}) {
  const events = { locks: 0, moves: 0 };
  const hooks = {
    moved: () => { events.moves++; notifyMoved(g, t); },
    lock: () => { events.locks++; lockFn(g); resetForNewPiece(t); },
  };
  for (let elapsed = 0; elapsed < ms; elapsed += dt) {
    advanceFrame(g, t, dt, { dir, soft }, hooks);
  }
  return events;
}

// ---- Lock delay is real time, not gravity ticks ----

test('grounded piece does not lock before lockDelayMs at level 1', () => {
  const g = rig();
  ground(g);
  const t = createTiming();
  // Historically the lock timer advanced by one gravity interval per gravity
  // tick, so at level 1 (1000ms/row) a grounded piece locked on its very
  // first grounded tick — zero effective lock delay.
  const e = run(g, t, CONFIG.lockDelayMs - 2 * FRAME);
  assert.equal(e.locks, 0);
  assert.ok(t.lockTimer < CONFIG.lockDelayMs);
});

test('grounded piece locks once lockDelayMs of real time elapses', () => {
  const g = rig();
  ground(g);
  const t = createTiming();
  const e = run(g, t, CONFIG.lockDelayMs + 2 * FRAME);
  assert.equal(e.locks, 1);
});

test('lock delay is independent of level/gravity interval', () => {
  for (const level of [1, 5, 10, 15, 20]) {
    const g = rig({ level });
    ground(g);
    const t = createTiming();
    let elapsed = 0;
    let locked = 0;
    while (elapsed < 2000 && locked === 0) {
      elapsed += FRAME;
      advanceFrame(g, t, FRAME, { dir: 0, soft: false }, { lock: () => { locked = elapsed; } });
    }
    assert.ok(
      locked >= CONFIG.lockDelayMs && locked <= CONFIG.lockDelayMs + 2 * FRAME,
      `level ${level}: locked at ${locked}ms, expected ~${CONFIG.lockDelayMs}ms`,
    );
  }
});

test('lock fires exactly once per grounded piece (no double lock in a frame)', () => {
  const g = rig();
  ground(g);
  const t = createTiming();
  let locks = 0;
  // Hook does not lock the piece: the loop must still not spam the hook
  // within a single frame (one frame = at most one lock decision).
  t.lockTimer = CONFIG.lockDelayMs - 1;
  advanceFrame(g, t, MAX_FRAME_MS, { dir: 0, soft: false }, { lock: () => locks++ });
  assert.equal(locks, 1);
});

test('airborne piece never triggers the lock hook and keeps lockTimer null', () => {
  const g = rig({ y: 0 });
  const t = createTiming();
  const e = run(g, t, 900); // < one gravity interval at level 1... plus a fall
  assert.equal(e.locks, 0);
  assert.equal(t.lockTimer, null);
});

test('a move that ungrounds the piece clears the lock timer', () => {
  // Ledge in column 4 only; O piece rests on it, then slides off to the right.
  const board = createBoard();
  board[TOTAL_ROWS - 1][4] = 'I';
  board[TOTAL_ROWS - 1][5] = 'I';
  const g = rig({ board, x: 4, level: 1 });
  ground(g);
  const t = createTiming();
  run(g, t, 200);
  assert.ok(t.lockTimer >= 100, 'lock timer running while grounded');
  g.current.x = 7; // slide off the ledge (open floor below)
  advanceFrame(g, t, FRAME, { dir: 0, soft: false }, {});
  assert.equal(t.lockTimer, null);
});

test('lock-delay reset budget: taps postpone the lock, then the cap ends it', () => {
  const g = rig();
  ground(g);
  const t = createTiming();
  let locks = 0;
  const hooks = { lock: () => locks++ };
  // Tap left/right every 300ms (< lockDelayMs) forever.
  let elapsed = 0;
  let taps = 0;
  while (elapsed < 20000 && locks === 0) {
    advanceFrame(g, t, FRAME, { dir: 0, soft: false }, hooks);
    elapsed += FRAME;
    if (elapsed % 304 === 0) {
      const dir = taps++ % 2 === 0 ? -1 : 1;
      // Simulate the frontend's immediate move on a fresh key press.
      const before = g.current.x;
      if (before + dir >= 0) {
        g.current.x += dir;
        g.lock.lastReset = g.lock.resets < CONFIG.lockDelayResets;
        if (g.lock.lastReset) g.lock.resets++;
        notifyMoved(g, t);
      }
    }
  }
  assert.equal(locks, 1, 'eventually locks');
  assert.ok(taps > CONFIG.lockDelayResets, `taps ${taps} should exceed reset cap`);
  assert.ok(elapsed > CONFIG.lockDelayMs * 2, 'taps really did postpone the lock');
});

// ---- Sliding under an overhang (the reason lock delay exists) ----

test('a grounded piece can slide under an overhang within the lock delay', () => {
  // Floor at the bottom row on the left half, and an overhang two rows up on
  // the right so there is a covered pocket at columns 7-8.
  const board = createBoard();
  const floor = TOTAL_ROWS - 1;
  for (let x = 0; x <= 5; x++) board[floor][x] = 'I';
  for (let x = 6; x < COLS; x++) board[floor - 3][x] = 'I'; // ceiling of the pocket
  const g = rig({ type: 'O', board, x: 4, level: 1 });
  ground(g);
  const startY = g.current.y;
  const t = createTiming();
  // Slide right one column per 100ms — must stay alive long enough to travel
  // and must not lock while still moving.
  let x = g.current.x;
  for (let elapsed = 0; elapsed < 400; elapsed += FRAME) {
    advanceFrame(g, t, FRAME, { dir: 0, soft: false }, { lock: () => assert.fail('locked too early') });
    if (elapsed % 96 === 0 && x < 6) {
      x++;
      g.current.x = x;
      g.lock.lastReset = true;
      g.lock.resets++;
      notifyMoved(g, t);
    }
  }
  assert.equal(g.current.x, 6, 'reached the pocket entrance');
  // Once past the floor edge it is airborne again and gravity drops it into
  // the pocket, under the overhang — no clipping through the ceiling.
  let lockedY = null;
  for (let elapsed = 0; elapsed < 60000 && lockedY === null; elapsed += FRAME) {
    advanceFrame(g, t, FRAME, { dir: 0, soft: false }, { lock: () => { lockedY = g.current.y; } });
  }
  assert.ok(lockedY > startY, `locked at ${lockedY}, expected below the old floor row ${startY}`);
  assert.equal(lockedY, floor - 1, 'sits on the pocket floor');
  assert.equal(g.board[floor - 3][6], 'I', 'overhang intact');
});

// ---- Gravity ----

test('gravity falls exactly one row per gravity interval', () => {
  const g = rig({ level: 1 });
  const t = createTiming();
  const y0 = g.current.y;
  run(g, t, gravityIntervalMs(1) - FRAME);
  assert.equal(g.current.y, y0, 'no fall before the interval');
  run(g, t, 2 * FRAME);
  assert.equal(g.current.y, y0 + 1);
});

test('a long frame is clamped: no teleporting after a stall', () => {
  const g = rig({ level: 20 }); // ~30ms per row
  const t = createTiming();
  const y0 = g.current.y;
  advanceFrame(g, t, 5000, { dir: 0, soft: false }, {});
  const maxRows = Math.ceil(MAX_FRAME_MS / gravityIntervalMs(20)) + 1;
  assert.ok(g.current.y - y0 <= maxRows, `fell ${g.current.y - y0} rows, max ${maxRows}`);
});

test('sliding off a ledge does not release banked gravity', () => {
  // Slow frames (100ms) with a short gravity interval (level 20 ≈ 30ms/row):
  // a piece resting on a ledge must not store up unspent gravity and then
  // teleport down many rows the instant it slides off.
  const board = createBoard();
  board[10][4] = 'I'; // ledge high above the floor, so a teleport is visible
  const g = rig({ type: 'O', board, x: 3, level: 20 });
  ground(g);
  assert.equal(g.current.y, 8, 'rig: resting on the high ledge');
  const t = createTiming();
  const SLOW = MAX_FRAME_MS;
  // Sit grounded through several slow frames, still inside the lock delay.
  for (let i = 0; i < 4; i++) {
    advanceFrame(g, t, SLOW, { dir: 0, soft: false }, { lock: () => assert.fail('locked early') });
  }
  const y0 = g.current.y;
  g.current.x = 7; // now over open floor
  advanceFrame(g, t, SLOW, { dir: 0, soft: false }, {});
  const maxRows = Math.ceil(SLOW / gravityIntervalMs(20));
  assert.ok(
    g.current.y - y0 <= maxRows,
    `dropped ${g.current.y - y0} rows in one ${SLOW}ms frame (max ${maxRows})`,
  );
});

// ---- Soft drop ----

test('soft drop falls at the soft interval, not double speed', () => {
  const g = rig({ level: 1 });
  const t = createTiming();
  const y0 = g.current.y;
  const ms = 300;
  run(g, t, ms, { soft: true });
  const expected = Math.floor(ms / softDropIntervalMs(1));
  // Holding Down used to accelerate BOTH the soft-drop repeat and gravity,
  // so the piece fell ~1.6x too fast (and only scored for part of it).
  assert.ok(
    Math.abs(g.current.y - y0 - expected) <= 1,
    `fell ${g.current.y - y0} rows in ${ms}ms, expected ~${expected}`,
  );
});

test('soft drop scores exactly one point per row it moves', () => {
  const g = rig({ level: 1 });
  const t = createTiming();
  const y0 = g.current.y;
  const s0 = g.score;
  run(g, t, 200, { soft: true });
  assert.equal(g.score - s0, g.current.y - y0);
});

test('soft drop on a grounded piece does not stall the lock delay', () => {
  const g = rig();
  ground(g);
  const t = createTiming();
  const e = run(g, t, CONFIG.lockDelayMs + 2 * FRAME, { soft: true });
  assert.equal(e.locks, 1);
});

test('holding Down never adds unscored gravity rows (no shadow gravity)', () => {
  // Level 6: gravity 262ms/row, soft drop 13.1ms/row. Tap Down, release so
  // gravity banks credit, then hold Down through the next gravity tick: with
  // natural gravity still ticking, that tick drops an unscored row while the
  // player is holding Down (rows fallen > soft-drop score).
  const g = rig({ level: 6 });
  const t = createTiming();
  const y0 = g.current.y;
  const s0 = g.score;
  // No-op lock hook: the piece may rest at the floor without spawning.
  const hooks = { moved: () => notifyMoved(g, t), lock: () => {} };
  for (let e = 0; e < 100; e += FRAME) advanceFrame(g, t, FRAME, { dir: 0, soft: true }, hooks);
  for (let e = 0; e < 100; e += FRAME) advanceFrame(g, t, FRAME, { dir: 0, soft: false }, hooks);
  for (let e = 0; e < 200; e += FRAME) advanceFrame(g, t, FRAME, { dir: 0, soft: true }, hooks);
  const rows = g.current.y - y0;
  const score = g.score - s0;
  assert.ok(rows >= 15, `piece really fell (${rows} rows)`);
  assert.equal(score, rows, 'every row while holding Down is a scored soft-drop row');
});

test('gravity accumulator is frozen while Down is held (no banked burst on release)', () => {
  // While soft drop is held, natural gravity must neither tick (shadow rows)
  // nor bank credit: otherwise releasing Down would release a burst of
  // gravity. Bank credit airborne, ground the piece, then hold Down through
  // several gravity intervals: the accumulator must not move.
  const g = rig({ level: 6 }); // gravity 262ms/row
  const t = createTiming();
  run(g, t, 200); // airborne: banks < one interval of gravity
  const banked = t.gravityAccum;
  assert.ok(banked > 0 && banked < gravityIntervalMs(6), 'rig: some credit banked');
  g.current.y = ghostY(g); // ground the piece (soft drop is now a no-op)
  run(g, t, 400, { soft: true }); // < lockDelayMs: no lock
  assert.equal(t.gravityAccum, banked, 'accumulator frozen while soft was held');
});

// ---- DAS / ARR ----

test('auto-shift waits for DAS then repeats at ARR', () => {
  const g = rig({ x: 4 });
  const t = createTiming();
  const x0 = g.current.x;
  run(g, t, CONFIG.DASMs - 2 * FRAME, { dir: -1 });
  assert.equal(g.current.x, x0, 'no repeat before DAS');
  run(g, t, 4 * CONFIG.ARRMs + FRAME, { dir: -1 });
  const moved = x0 - g.current.x;
  assert.ok(moved >= 3 && moved <= 6, `moved ${moved} cells after DAS`);
});

test('auto-shift into a wall does not bank repeats', () => {
  // Same slow-frame scenario as banked gravity: pressed against the left wall
  // through slow frames, unspent ARR must not accumulate and then fling the
  // piece across the board when the direction reverses.
  const g = rig({ x: 0 });
  const t = createTiming();
  const SLOW = MAX_FRAME_MS;
  run(g, t, 20 * SLOW, { dir: -1, dt: SLOW });
  assert.equal(g.current.x, 0, 'stays at the wall');
  assert.ok(t.arr < CONFIG.ARRMs, `banked ${t.arr}ms of ARR while blocked`);
  // Reversing must move at most the repeats one frame is worth.
  const e = run(g, t, SLOW, { dir: 1, dt: SLOW });
  const maxMoves = Math.ceil(SLOW / CONFIG.ARRMs);
  assert.ok(e.moves <= maxMoves, `burst of ${e.moves} moves (max ${maxMoves})`);
  assert.ok(g.current.x <= maxMoves, `jumped to x=${g.current.x} in one frame`);
});

test('releasing the direction resets the DAS charge', () => {
  const g = rig({ x: 4 });
  const t = createTiming();
  run(g, t, CONFIG.DASMs - FRAME, { dir: -1 });
  run(g, t, FRAME, { dir: 0 }); // key released
  assert.equal(t.das, 0);
  const x0 = g.current.x;
  run(g, t, CONFIG.DASMs - 2 * FRAME, { dir: -1 });
  assert.equal(g.current.x, x0, 'DAS charge restarted from zero');
});

test('resetShift clears both DAS and ARR', () => {
  const t = createTiming();
  t.das = 500;
  t.arr = 20;
  resetShift(t);
  assert.equal(t.das, 0);
  assert.equal(t.arr, 0);
});

// ---- Line-clear freeze ----

test('freeze suspends gravity and expires after its duration', () => {
  const g = rig({ level: 1 });
  const t = createTiming();
  startFreeze(t, 220);
  const y0 = g.current.y;
  run(g, t, 220 - FRAME);
  assert.equal(g.current.y, y0, 'frozen: no gravity');
  assert.ok(t.freeze > 0);
  run(g, t, 2 * FRAME);
  assert.equal(t.freeze, 0, 'freeze expires');
  run(g, t, gravityIntervalMs(1) + FRAME);
  assert.ok(g.current.y > y0, 'gravity resumes after the freeze');
});

test('freeze does not consume the lock delay', () => {
  const g = rig();
  ground(g);
  const t = createTiming();
  startFreeze(t, 220);
  const e = run(g, t, 220 + CONFIG.lockDelayMs - 3 * FRAME);
  assert.equal(e.locks, 0, 'lock delay starts after the freeze, not during it');
});

test('startFreeze never shortens an active freeze', () => {
  const t = createTiming();
  startFreeze(t, 220);
  startFreeze(t, 50);
  assert.equal(t.freeze, 220);
});

test('clearFreeze ends an active freeze so the next piece is not stuck', () => {
  // A hard drop (or hold) mid-dash must end the dash: otherwise the fresh
  // piece sits frozen for the remainder and held keys feel dead right after
  // a clear.
  const g = rig({ level: 1 });
  const t = createTiming();
  startFreeze(t, 220);
  clearFreeze(t);
  const y0 = g.current.y;
  run(g, t, gravityIntervalMs(1) + FRAME);
  assert.ok(g.current.y > y0, 'gravity runs right after the freeze is cleared');
});

test('clearFreeze then startFreeze starts a fresh full-length dash', () => {
  const t = createTiming();
  startFreeze(t, 220);
  clearFreeze(t);
  startFreeze(t, 220);
  assert.equal(t.freeze, 220, 'a new dash starts at full length, not extended');
  clearFreeze(t);
  assert.equal(t.freeze, 0);
  clearFreeze(t); // idempotent
  assert.equal(t.freeze, 0);
});

// ---- Paused / game over ----

test('paused game ignores gravity, auto-shift and soft drop', () => {
  const g = rig({ level: 1 });
  g.paused = true;
  const t = createTiming();
  const snap = { ...g.current };
  const e = run(g, t, 3000, { dir: -1, soft: true });
  assert.deepEqual({ ...g.current }, snap);
  assert.equal(e.locks, 0);
  assert.equal(e.moves, 0);
});

test('game over stops all timing', () => {
  const g = rig();
  ground(g);
  g.gameOver = true;
  const t = createTiming();
  const e = run(g, t, 3000, { dir: 1, soft: true });
  assert.equal(e.locks, 0);
  assert.equal(e.moves, 0);
});

test('resetForNewPiece clears the per-piece clocks', () => {
  const t = createTiming();
  t.lockTimer = 400;
  t.gravityAccum = 900;
  t.softAccum = 20;
  resetForNewPiece(t);
  assert.equal(t.lockTimer, null);
  assert.equal(t.gravityAccum, 0);
  assert.equal(t.softAccum, 0);
});

// ---- Whole-piece integration ----

test('a full piece lifecycle at level 1 lands the piece on its ghost row', () => {
  const g = rig({ type: 'T', x: 3, level: 1 });
  const t = createTiming();
  const expected = ghostY(g);
  let locked = null;
  for (let elapsed = 0; elapsed < 60000 && locked === null; elapsed += FRAME) {
    advanceFrame(g, t, FRAME, { dir: 0, soft: false }, {
      moved: () => notifyMoved(g, t),
      lock: () => { locked = g.current.y; lockPiece(g); resetForNewPiece(t); },
    });
  }
  assert.equal(locked, expected, 'locked exactly at the ghost row');
  assert.equal(g.board.flat().filter(Boolean).length, 4, 'exactly one piece written');
});

test('negative and zero dt are ignored (clock going backwards)', () => {
  const g = rig();
  ground(g);
  const t = createTiming();
  advanceFrame(g, t, -1000, { dir: 0, soft: false }, { lock: () => assert.fail('locked on negative dt') });
  advanceFrame(g, t, 0, { dir: 0, soft: false }, { lock: () => assert.fail('locked on zero dt') });
  assert.equal(t.lockTimer, 0);
});
