import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame,
  createBoard,
  COLS,
  ROWS,
  TOTAL_ROWS,
  HIDDEN_ROWS,
  CONFIG,
  movePiece,
  rotatePiece,
  softDrop,
  hardDrop,
  holdPiece,
  lockPiece,
  stepGravity,
  ghostY,
  isGrounded,
  canPlace,
  gravityIntervalMs,
  makeBagRng,
  nextPieces,
  applyClearsToCells,
  LINE_SCORES,
  SOFT_DROP_SCORE,
  HARD_DROP_SCORE,
} from '../src/engine.js';
import { PIECES, PIECE_TYPES, getCells } from '../src/pieces.js';

function gameWith(type, seed = 42) {
  const g = createGame(seed);
  g.current = { type, rotation: 0, x: 3, y: 5 };
  g.queue = Array.from({ length: 6 }, () => 'I');
  return g;
}

test('board dimensions', () => {
  const b = createBoard();
  assert.equal(b.length, TOTAL_ROWS);
  assert.equal(b[0].length, COLS);
  assert.equal(TOTAL_ROWS, ROWS + 2);
});

test('7-bag: 35 draws contain exactly 5 of each piece', () => {
  const rng = makeBagRng(123);
  const counts = Object.fromEntries(PIECE_TYPES.map((t) => [t, 0]));
  for (let i = 0; i < 35; i++) counts[rng()]++;
  for (const t of PIECE_TYPES) assert.equal(counts[t], 5, `${t} count`);
});

test('7-bag: deterministic with same seed', () => {
  const a = makeBagRng(7);
  const b = makeBagRng(7);
  for (let i = 0; i < 50; i++) assert.equal(a(), b());
});

test('I piece has horizontal and vertical rotations (SRS)', () => {
  const h = new Set(getCells('I', 0).map(([r, c]) => r));
  const v = new Set(getCells('I', 1).map(([r, c]) => c));
  assert.equal(h.size, 1, 'spawn is horizontal');
  assert.equal(v.size, 1, 'R is vertical');
  assert.equal(new Set(getCells('I', 2).map(([r, c]) => r)).size, 1);
  assert.equal(new Set(getCells('I', 3).map(([r, c]) => c)).size, 1);
});

test('SRS invariant: each rotation state is the exact CW rotation of the previous', () => {
  const norm = (cells) =>
    cells.map(([r, c]) => `${r},${c}`).sort().join('|');
  for (const t of PIECE_TYPES) {
    const n = PIECES[t].size;
    for (let r = 0; r < 4; r++) {
      const expected = norm(getCells(t, r).map(([rr, cc]) => [cc, n - 1 - rr]));
      const actual = norm(getCells(t, (r + 1) % 4));
      assert.equal(actual, expected, `${t} rot ${r} -> ${(r + 1) % 4}`);
    }
  }
});

test('all piece states are a single connected shape', () => {
  for (const t of PIECE_TYPES) {
    for (let r = 0; r < 4; r++) {
      const cells = getCells(t, r);
      const set = new Set(cells.map(([a, b]) => `${a},${b}`));
      const [sr, sc] = cells[0];
      const seen = new Set([`${sr},${sc}`]);
      const queue = [[sr, sc]];
      while (queue.length) {
        const [a, b] = queue.pop();
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k = `${a + dr},${b + dc}`;
          if (set.has(k) && !seen.has(k)) {
            seen.add(k);
            queue.push([a + dr, b + dc]);
          }
        }
      }
      assert.equal(seen.size, 4, `${t} rot ${r} is disconnected`);
    }
  }
});

test('piece shapes always have 4 cells', () => {
  for (const t of PIECE_TYPES) {
    for (let r = 0; r < 4; r++) {
      assert.equal(getCells(t, r).length, 4, `${t} rot ${r}`);
    }
  }
});

test('gravity: piece falls when space below', () => {
  const g = gameWith('T');
  assert.equal(stepGravity(g), 'fell');
  assert.equal(g.current.y, 6);
});

test('gravity: grounded piece reports grounded', () => {
  const g = gameWith('T');
  g.current.y = TOTAL_ROWS - 2; // bottom for a 3-wide piece
  assert.equal(isGrounded(g), true);
  assert.equal(stepGravity(g), 'grounded');
  assert.equal(g.current.y, TOTAL_ROWS - 2);
});

test('horizontal movement and wall collision', () => {
  const g = gameWith('T');
  const y = g.current.y;
  assert.equal(movePiece(g, -1), true);
  assert.equal(g.current.x, 2);
  assert.equal(g.current.y, y, 'omitted dy defaults to zero');
  assert.ok(Number.isFinite(ghostY(g)));
  g.current.x = 0;
  assert.equal(movePiece(g, -1, 0), false);
  g.current.x = COLS - 3;
  assert.equal(movePiece(g, 1, 0), false);
});

test('rotation changes shape and returns to original after 4 CW turns', () => {
  const g = gameWith('T');
  const start = { ...g.current };
  for (let i = 0; i < 4; i++) {
    assert.equal(rotatePiece(g, 1), true);
  }
  assert.deepEqual(g.current, start);
});

test('wall kick: T-spin setup — rotate T against left wall', () => {
  const g = gameWith('T');
  g.current.x = 0;
  g.current.y = 10;
  // Rotate CCW at left wall: should succeed via kick (or in place).
  assert.equal(rotatePiece(g, -1), true);
  // Must remain inside bounds.
  for (const [r, c] of getCells(g.current.type, g.current.rotation)) {
    assert.ok(g.current.x + c >= 0 && g.current.x + c < COLS);
  }
});

test('soft drop scores 1 per row', () => {
  const g = gameWith('T');
  const y0 = g.current.y;
  assert.equal(softDrop(g), true);
  assert.equal(g.current.y, y0 + 1);
  assert.equal(g.score, SOFT_DROP_SCORE);
});

test('hard drop: lands on floor, scores, locks, spawns next', () => {
  const g = gameWith('T');
  const y0 = g.current.y;
  g.score = 0;
  const expectedDrop = ghostY(g) - y0;
  hardDrop(g);
  assert.equal(g.score, expectedDrop * HARD_DROP_SCORE);
  // Next piece spawned
  assert.equal(g.current.type, 'I');
  assert.equal(g.canHold, true);
  // Board has 4 T cells
  let cells = 0;
  for (const row of g.board) cells += row.filter(Boolean).length;
  assert.equal(cells, 4);
});

test('line clear: single line clears and scores', () => {
  const g = createGame(42);
  // Fill bottom row except where the T will land; simpler: fill manually.
  const y = TOTAL_ROWS - 1;
  for (let x = 0; x < COLS; x++) g.board[y][x] = 'Z';
  g.score = 0;
  g.lines = 0;
  g.level = 1;
  // Drop an O piece into the gap? Instead just call lockPiece with a piece
  // placed so its cells complete the row.
  g.current = { type: 'O', rotation: 0, x: 0, y: TOTAL_ROWS - 2 };
  // Remove the two cells under the O so it fits, then they'd be empty...
  // Easiest: fill row, place O above row, clear row via lock.
  g.board[y][0] = null;
  g.board[y][1] = null;
  lockPiece(g);
  assert.equal(g.lastClear, 1);
  assert.equal(g.lines, 1);
  assert.equal(g.score, LINE_SCORES[1] * 1);
  // Bottom row now holds only the O piece (2 cells); rest empty
  const bottom = g.board[TOTAL_ROWS - 1];
  assert.equal(bottom.filter(Boolean).length, 2);
  assert.ok(bottom.slice(2).every((c) => c === null));
});


test('tetris: 4-line clear scores 800 * level', () => {
  const g = createGame(42);
  const y0 = TOTAL_ROWS - 4;
  for (let y = y0; y < TOTAL_ROWS; y++) {
    for (let x = 0; x < COLS; x++) g.board[y][x] = 'Z';
  }
  g.score = 0;
  g.lines = 26;
  g.level = 3;
  // I rotation 1 is vertical in column 2 of its 4x4 box; x=0 puts it in col 2.
  g.current = { type: 'I', rotation: 1, x: 0, y: y0 };
  // Clear that column so the I fits.
  for (let y = y0; y < TOTAL_ROWS; y++) g.board[y][2] = null;
  lockPiece(g);
  assert.equal(g.lastClear, 4);
  assert.equal(g.lines, 30);
  assert.equal(g.level, 4);
  assert.equal(g.score, LINE_SCORES[4] * 4);
});

test('level up every 10 lines', () => {
  const g = createGame(42);
  g.lines = 9;
  g.level = 1;
  // Clear a single line
  const y = TOTAL_ROWS - 1;
  for (let x = 0; x < COLS; x++) g.board[y][x] = 'Z';
  g.board[y][0] = null;
  g.board[y][1] = null;
  g.current = { type: 'O', rotation: 0, x: 0, y: TOTAL_ROWS - 2 };
  lockPiece(g);
  assert.equal(g.lines, 10);
  assert.equal(g.level, 2);
});

test('hold: swaps pieces, once per drop', () => {
  const g = gameWith('T');
  assert.equal(holdPiece(g), true);
  assert.equal(g.held, 'T');
  assert.equal(g.current.type, 'I');
  assert.equal(g.canHold, false);
  assert.equal(holdPiece(g), false);
  // After lock, hold is available again
  g.current.y = TOTAL_ROWS - 2;
  lockPiece(g);
  assert.equal(g.canHold, true);
});

test('game over when spawn collides', () => {
  const g = createGame(42);
  // Fill the spawn zone (leave cols 8-9 empty so rows don't auto-clear)
  for (let y = 0; y < 4; y++) for (let x = 0; x < COLS - 2; x++) g.board[y][x] = 'Z';
  g.current = { type: 'I', rotation: 0, x: 3, y: TOTAL_ROWS - 2 };
  lockPiece(g);
  assert.equal(g.gameOver, true);
});

test('game over when locking above visible field', () => {
  const g = createGame(42);
  // I vertical with top cell in y=-1 (reachable via negative wall kick).
  g.current = { type: 'I', rotation: 3, x: 0, y: -1 };
  lockPiece(g);
  assert.equal(g.gameOver, true);
});

test('lock-out: piece locking entirely above the visible field ends the game', () => {
  const g = createGame(42);
  // Stack 18 high in cols 3-6 so a horizontal I lands in the hidden rows.
  for (let y = HIDDEN_ROWS; y < TOTAL_ROWS; y++) {
    for (let x = 3; x <= 6; x++) g.board[y][x] = 'Z';
  }
  g.current = { type: 'I', rotation: 0, x: 3, y: 0 }; // all cells at row 1
  lockPiece(g);
  assert.equal(g.gameOver, true);
  // The locked cells are still written so the final state renders fully.
  for (let x = 3; x <= 6; x++) assert.equal(g.board[1][x], 'I');
});

test('lock-out lock resets the clear state (no stale clear FX from the previous piece)', () => {
  const g = createGame(42);
  g.board = createBoard();
  // Piece 1: a real single clear, so lastClear/clearRows hold a value.
  const y = TOTAL_ROWS - 1;
  for (let x = 4; x < COLS; x++) g.board[y][x] = 'Z';
  g.current = { type: 'I', rotation: 0, x: 0, y: y - 1 };
  lockPiece(g);
  assert.equal(g.lastClear, 1);
  assert.deepEqual(g.clearRows, [y]);
  // Piece 2: locks entirely in the hidden rows (lock-out). It clears nothing,
  // so the clear state must report THIS lock, not the previous piece's.
  g.board = createBoard();
  for (let yy = 0; yy < TOTAL_ROWS; yy++) for (let x = 0; x < COLS; x++) g.board[yy][x] = 'Z';
  for (const [yy, x] of [[0, 4], [0, 5], [1, 4], [1, 5]]) g.board[yy][x] = null;
  g.current = { type: 'O', rotation: 0, x: 4, y: 0 };
  lockPiece(g);
  assert.equal(g.gameOver, true);
  assert.equal(g.lastClear, 0, 'lock-out lock reports no clear');
  assert.equal(g.clearRows.length, 0, 'lock-out lock reports no rows');
});

test('top-out: piece partially in the hidden rows is allowed', () => {
  const g = createGame(42);
  // Stack 17 high in col 1 (away from the spawn zone, cols 3-6): a vertical
  // I fits with 2 cells hidden, 2 visible. Partial top-out is legal, and the
  // next piece must still be able to spawn.
  for (let y = HIDDEN_ROWS + 2; y < TOTAL_ROWS; y++) g.board[y][1] = 'Z';
  g.current = { type: 'I', rotation: 3, x: 0, y: 0 }; // col 1, rows 0-3
  lockPiece(g);
  assert.equal(g.gameOver, false);
  assert.equal(g.board[0][1], 'I');
  assert.equal(g.board[1][1], 'I');
  assert.equal(g.board[2][1], 'I');
  assert.equal(g.board[3][1], 'I');
});

test('lock with a cell above the board writes the rest of the piece (no partial lock)', () => {
  const g = createGame(42);
  // I vertical with top cell in y=-1: the other three cells (rows 0-2) must
  // still be written so the game-over screen shows the full piece.
  g.current = { type: 'I', rotation: 3, x: 0, y: -1 };
  lockPiece(g);
  assert.equal(g.gameOver, true);
  assert.equal(g.board[0][1], 'I');
  assert.equal(g.board[1][1], 'I');
  assert.equal(g.board[2][1], 'I');
});

test('inputs ignored while paused or game over', () => {
  const g = gameWith('T');
  g.paused = true;
  assert.equal(movePiece(g, 1, 0), false);
  assert.equal(rotatePiece(g, 1), false);
  assert.equal(softDrop(g), false);
  assert.equal(hardDrop(g), false);
  g.paused = false;
  g.gameOver = true;
  assert.equal(movePiece(g, 1, 0), false);
  assert.equal(hardDrop(g), false);
});

test('ghost Y equals floor for grounded piece', () => {
  const g = gameWith('T');
  g.current.y = TOTAL_ROWS - 2;
  assert.equal(ghostY(g), g.current.y);
});

test('ghost Y is below piece when airborne', () => {
  const g = gameWith('T');
  assert.ok(ghostY(g) > g.current.y);
});

test('gravity interval decreases with level and has a floor', () => {
  assert.ok(gravityIntervalMs(1) > gravityIntervalMs(5));
  assert.ok(gravityIntervalMs(5) > gravityIntervalMs(10));
  assert.ok(gravityIntervalMs(20) >= 30);
  assert.equal(gravityIntervalMs(1), 1000);
});

test('nextPieces returns queue preview', () => {
  const g = createGame(42);
  const n = nextPieces(g, 3);
  assert.equal(n.length, 3);
  assert.equal(n[0], g.queue[0]);
});

test('canPlace detects overlap with stack', () => {
  const g = gameWith('T');
  g.board[TOTAL_ROWS - 1][3] = 'Z';
  g.current.y = TOTAL_ROWS - 3;
  assert.equal(canPlace(g.board, g.current, 0, 0), true);
  assert.equal(canPlace(g.board, g.current, 0, 1), false);
});

// ---- Lock delay reset cap ----

test('lock delay: grounded horizontal moves reset up to the per-piece cap', () => {
  const g = gameWith('T');
  g.current.y = TOTAL_ROWS - 2; // grounded on the floor
  assert.equal(isGrounded(g), true);
  for (let i = 0; i < CONFIG.lockDelayResets; i++) {
    // Alternate directions so every move succeeds.
    assert.equal(movePiece(g, i % 2 === 0 ? 1 : -1, 0), true);
    assert.equal(g.lock.lastReset, true, `move ${i + 1} should apply a reset`);
  }
  assert.equal(g.lock.resets, CONFIG.lockDelayResets);
  // Cap exhausted: further successful moves must NOT reset.
  assert.equal(movePiece(g, 1, 0), true);
  assert.equal(g.lock.lastReset, false, 'reset cap must be enforced');
  assert.equal(g.lock.resets, CONFIG.lockDelayResets);
});

test('lock delay: soft drop never resets the delay', () => {
  const g = gameWith('T');
  assert.equal(softDrop(g), true);
  assert.equal(g.lock.lastReset, false);
  assert.equal(g.lock.resets, 0);
});

test('lock delay: rotation while grounded resets the delay', () => {
  const g = gameWith('T');
  g.current.y = TOTAL_ROWS - 2;
  assert.equal(rotatePiece(g, 1), true);
  assert.equal(g.lock.lastReset, true);
  assert.equal(g.lock.resets, 1);
});

test('lock delay: reset budget refreshes when a new piece spawns', () => {
  const g = gameWith('T');
  g.current.y = TOTAL_ROWS - 2;
  for (let i = 0; i < CONFIG.lockDelayResets; i++) {
    assert.equal(movePiece(g, i % 2 === 0 ? 1 : -1, 0), true);
  }
  assert.equal(g.lock.resets, CONFIG.lockDelayResets);
  hardDrop(g);
  assert.equal(g.lock.resets, 0);
  assert.equal(g.lock.lastReset, false);
});

test('lock delay: failed moves do not consume or grant resets', () => {
  const g = gameWith('T');
  g.current.y = TOTAL_ROWS - 2;
  g.current.x = 0;
  assert.equal(movePiece(g, -1, 0), false);
  assert.equal(g.lock.lastReset, false);
  assert.equal(g.lock.resets, 0);
});

// ---- Ghost accuracy ----

test('ghost: hard drop always lands exactly on the ghost cells (fuzz)', () => {
  // Plain uniform RNG (makeBagRng emits piece types, not numbers).
  let seed = 99;
  const rng = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let checked = 0;
  for (let trial = 0; trial < 600 && checked < 200; trial++) {
    const g = createGame(1 + trial);
    for (let y = HIDDEN_ROWS; y < TOTAL_ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (rng() < 0.15) g.board[y][x] = 'Z';
      }
    }
    const type = PIECE_TYPES[Math.floor(rng() * PIECE_TYPES.length)];
    const rotation = Math.floor(rng() * 4);
    let placed = false;
    for (let x = 0; x <= COLS - PIECES[type].size && !placed; x++) {
      if (canPlace(g.board, { type, rotation, x, y: 0 })) {
        g.current = { type, rotation, x, y: 0 };
        placed = true;
      }
    }
    if (!placed) continue;
    const px = g.current.x;
    const gy = ghostY(g);
    // The ghost position must itself be a valid placement.
    assert.ok(canPlace(g.board, { type, rotation, x: px, y: gy }), 'ghost cell must be valid');
    hardDrop(g);
    if (g.gameOver) continue; // lock-out: nothing to compare
    if (g.lastClear > 0) continue; // clears shift the stack; skip
    // The dropped piece must occupy exactly the ghost cells.
    for (const [r, c] of getCells(type, rotation)) {
      assert.equal(g.board[gy + r][px + c], type, `piece must lock at ghost cell ${px + c},${gy + r}`);
    }
    checked++;
  }
  assert.ok(checked >= 100, `fuzz coverage too low: ${checked}`);
});

// ---- Movement edge cases ----

test('movement: piece can slide under an overhang', () => {
  const g = gameWith('O');
  g.current.x = 1;
  g.current.y = TOTAL_ROWS - 2; // O on the bottom two rows, cols 1-2
  // Overhang block one row above col 3; space beside it is open.
  g.board[TOTAL_ROWS - 3][3] = 'Z';
  assert.equal(movePiece(g, 1, 0), true, 'slide under the overhang (cols 2-3)');
  assert.equal(movePiece(g, 1, 0), true, 'continue sliding (cols 3-4)');
  assert.equal(g.current.x, 3);
  assert.equal(isGrounded(g), true);
});

test('movement: piece cannot pass through a solid block', () => {
  const g = gameWith('O');
  g.current.x = 1;
  g.current.y = TOTAL_ROWS - 2;
  g.board[TOTAL_ROWS - 2][3] = 'Z'; // block in the piece's path
  assert.equal(movePiece(g, 1, 0), false, 'O at cols 1-2 cannot move into occupied col 3');
  assert.equal(g.current.x, 1);
});

// ---- Multi-line clear ordering ----

test('line clear: adjacent full rows both clear and stack shifts down', () => {
  const g = createGame(42);
  const y0 = TOTAL_ROWS - 2;
  for (let y = y0; y < TOTAL_ROWS; y++) {
    for (let x = 0; x < COLS; x++) g.board[y][x] = 'Z';
  }
  g.board[y0 - 1][0] = 'L'; // marker above the clear zone
  g.score = 0;
  g.lines = 0;
  g.level = 1;
  g.current = { type: 'O', rotation: 0, x: 0, y: 5 };
  lockPiece(g);
  assert.equal(g.lastClear, 2);
  assert.equal(g.score, LINE_SCORES[2] * 1);
  // Row y0 (old row y0-2, empty) is now empty; marker landed on the bottom row.
  assert.equal(g.board[y0].filter(Boolean).length, 0);
  assert.equal(g.board[TOTAL_ROWS - 1][0], 'L');
  assert.equal(g.board[TOTAL_ROWS - 1].filter(Boolean).length, 1);
  // Marker and O cells shifted down exactly 2 rows.
  assert.equal(g.board[y0 + 1][0], 'L');
  assert.equal(g.board[7][0], 'O');
  assert.equal(g.board[8][0], 'O');
});

test('line clear: non-adjacent full rows both clear (splice ordering)', () => {
  const g = createGame(42);
  const yA = TOTAL_ROWS - 1; // bottom row
  const yB = TOTAL_ROWS - 3; // two rows above it
  for (let x = 0; x < COLS; x++) {
    g.board[yA][x] = 'Z';
    g.board[yB][x] = 'Z';
  }
  g.board[yB - 1][0] = 'L';
  g.score = 0;
  g.lines = 0;
  g.level = 1;
  g.current = { type: 'O', rotation: 0, x: 0, y: 5 };
  lockPiece(g);
  assert.equal(g.lastClear, 2);
  // Everything above shifted down exactly 2 rows: the marker (old row yB-1)
  // now sits on row yB+1, and the row between the cleared rows (old yB+1,
  // empty) now sits on the bottom row.
  assert.equal(g.board[yB + 1][0], 'L');
  assert.equal(g.board[yB + 1].filter(Boolean).length, 1);
  assert.equal(g.board[TOTAL_ROWS - 1].filter(Boolean).length, 0);
  assert.equal(g.board[7][0], 'O');
  assert.equal(g.board[8][0], 'O');
  // Total cell count: 4 (O) + 1 (L) = 5.
  let cells = 0;
  for (const row of g.board) cells += row.filter(Boolean).length;
  assert.equal(cells, 5);
});
