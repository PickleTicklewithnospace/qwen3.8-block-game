// Property tests: the FX prediction (src/predict.js) and the post-clear
// cell mapping (engine.applyClearsToCells) must always agree with what the
// engine actually does when the piece locks. Any divergence means the
// line-clear effects (flash rows, colors, lock pops) target the wrong cells.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame,
  hardDrop,
  canPlace,
  applyClearsToCells,
  COLS,
  TOTAL_ROWS,
  HIDDEN_ROWS,
} from '../src/engine.js';
import { PIECES, PIECE_TYPES, getCells } from '../src/pieces.js';
import { landingCells, predictClears } from '../src/predict.js';

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a game with a random sparse stack and a random current piece placed
// at a valid spawn-row position. Returns null when no placement fits.
function randomGame(rng, seed) {
  const g = createGame(seed);
  const density = 0.1 + rng() * 0.25;
  for (let y = HIDDEN_ROWS; y < TOTAL_ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (rng() < density) g.board[y][x] = PIECE_TYPES[Math.floor(rng() * PIECE_TYPES.length)];
    }
  }
  const type = PIECE_TYPES[Math.floor(rng() * PIECE_TYPES.length)];
  const rotation = Math.floor(rng() * 4);
  for (let x = 0; x <= COLS - PIECES[type].size; x++) {
    if (canPlace(g.board, { type, rotation, x, y: 0 })) {
      g.current = { type, rotation, x, y: 0 };
      return g;
    }
  }
  return null;
}

// Deterministic line-clear constructions. Random sparse boards almost never
// produce a clear, so these guarantee the clear path is exercised:
//  - O completing one row (single)
//  - O completing two rows (double)
//  - vertical I completing four rows (tetris)
//  - a marker block above the clear zone (exercises the row shift)
function constructedClearGames() {
  const games = [];
  const bottom = TOTAL_ROWS - 1;
  // Singles and doubles: bottom n rows full except two adjacent cols c,c+1.
  for (let c = 0; c <= COLS - 2; c++) {
    for (const n of [1, 2]) {
      const g = createGame(1);
      for (let y = bottom - n + 1; y <= bottom; y++) {
        for (let x = 0; x < COLS; x++) {
          if (x !== c && x !== c + 1) g.board[y][x] = 'Z';
        }
      }
      if (n === 2) {
        // Marker above the clear zone, in a col the O does not fall through.
        const mc = c === 0 ? COLS - 1 : 0;
        g.board[bottom - 2][mc] = 'L';
      }
      g.current = { type: 'O', rotation: 0, x: c, y: 0 };
      games.push({ g, expectedRows: Array.from({ length: n }, (_, i) => bottom - n + 1 + i) });
    }
  }
  // Tetris: bottom four rows full except col c; vertical I in col c.
  for (let c = 2; c < COLS - 1; c++) {
    const g = createGame(1);
    for (let y = bottom - 3; y <= bottom; y++) {
      for (let x = 0; x < COLS; x++) {
        if (x !== c) g.board[y][x] = 'Z';
      }
    }
    g.board[bottom - 4][0] = 'L'; // marker above zone
    // I rotation 1 is vertical in box col 2; x = c-2 puts it in board col c.
    g.current = { type: 'I', rotation: 1, x: c - 2, y: 0 };
    games.push({ g, expectedRows: [bottom - 3, bottom - 2, bottom - 1, bottom] });
  }
  return games;
}

test('predictClears rows exactly match the engine clearRows (random fuzz)', () => {
  const rng = makeRng(1234);
  let checked = 0;
  for (let trial = 0; trial < 800 && checked < 250; trial++) {
    const g = randomGame(rng, 1000 + trial);
    if (!g) continue;
    const { rows, colors } = predictClears(g);
    hardDrop(g);
    if (g.gameOver) continue; // lock-out: engine skips clearing on game over
    assert.deepEqual(rows, g.clearRows, `trial ${trial}: predicted ${rows}, engine cleared ${g.clearRows}`);
    for (let i = 0; i < rows.length; i++) {
      assert.equal(colors[i].length, COLS, `trial ${trial}: row ${rows[i]} color count`);
    }
    checked++;
  }
  assert.ok(checked >= 150, `fuzz coverage too low: ${checked}`);
});

test('predictClears matches the engine on constructed clears (single/double/tetris)', () => {
  let checked = 0;
  for (const { g, expectedRows } of constructedClearGames()) {
    const { rows, colors } = predictClears(g);
    assert.deepEqual(rows, expectedRows, `expected ${expectedRows}, predicted ${rows}`);
    hardDrop(g);
    assert.deepEqual(g.clearRows, expectedRows, `engine cleared ${g.clearRows}`);
    assert.deepEqual(rows, g.clearRows);
    for (let i = 0; i < rows.length; i++) {
      assert.equal(colors[i].length, COLS, `row ${rows[i]} color count`);
    }
    checked++;
  }
  // 9 cols x 2 (single/double) + 7 tetris = 25 constructions.
  assert.equal(checked, 25);
});

test('applyClearsToCells: surviving landing cells land exactly where the engine puts them (constructed clears)', () => {
  let checked = 0;
  for (const { g } of constructedClearGames()) {
    const cells = landingCells(g);
    const type = g.current.type;
    hardDrop(g);
    assert.ok(g.lastClear > 0, 'constructed trial must clear at least one row');
    const final = applyClearsToCells(cells, g.clearRows);
    for (const [x, y] of final) {
      assert.ok(y >= 0 && y < TOTAL_ROWS, `mapped row out of bounds: ${y}`);
      assert.equal(g.board[y][x], type, `cell ${x},${y} should be ${type}`);
    }
    // The piece's surviving footprint on the board must be exactly `final`.
    const footprint = [];
    for (let y = 0; y < TOTAL_ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (g.board[y][x] === type) footprint.push([x, y]);
      }
    }
    assert.deepEqual(footprint.sort(), [...final].sort(), 'footprint mismatch');
    checked++;
  }
  assert.equal(checked, 25);
});

test('applyClearsToCells: marker block shifts down by the number of cleared rows below it', () => {
  // Double clear with a marker above: the marker (L) must move down exactly 2.
  const g = createGame(1);
  const bottom = TOTAL_ROWS - 1;
  for (let y = bottom - 1; y <= bottom; y++) {
    for (let x = 0; x < COLS; x++) g.board[y][x] = 'Z';
    g.board[y][0] = null;
    g.board[y][1] = null;
  }
  g.board[bottom - 2][5] = 'L';
  g.current = { type: 'O', rotation: 0, x: 0, y: 0 };
  hardDrop(g);
  assert.equal(g.lastClear, 2);
  assert.equal(g.board[bottom][5], 'L', 'marker shifted down two rows');
  assert.equal(g.board[bottom - 2][5], null, 'marker old spot empty');
});

test('landingCells: piece cells after hard drop are exactly the landing cells (no clear)', () => {
  const rng = makeRng(99);
  let checked = 0;
  for (let trial = 0; trial < 400 && checked < 100; trial++) {
    const g = randomGame(rng, 5000 + trial);
    if (!g) continue;
    const cells = landingCells(g);
    const type = g.current.type;
    const before = new Set();
    for (let y = 0; y < TOTAL_ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (g.board[y][x] === type) before.add(`${x},${y}`);
      }
    }
    hardDrop(g);
    if (g.gameOver || g.lastClear > 0) continue;
    // No clear: the piece must sit exactly on its predicted cells, adding
    // exactly 4 new cells of its type (the stack may already have some).
    for (const [x, y] of cells) {
      assert.equal(g.board[y][x], type, `trial ${trial}: cell ${x},${y}`);
      assert.ok(!before.has(`${x},${y}`), `trial ${trial}: landing cell was occupied`);
    }
    let after = 0;
    for (let y = 0; y < TOTAL_ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (g.board[y][x] === type) after++;
      }
    }
    assert.equal(after, before.size + 4, `trial ${trial}: expected ${before.size + 4} ${type} cells`);
    checked++;
  }
  assert.ok(checked >= 50, `fuzz coverage too low: ${checked}`);
});

test('applyClearsToCells: unit semantics', () => {
  // No clears -> identity (fresh array, not the same reference).
  const a = [[0, 5], [1, 9]];
  assert.deepEqual(applyClearsToCells(a, []), a);
  assert.notEqual(applyClearsToCells(a, []), a);
  // Cells above cleared rows shift down by the number of cleared rows below.
  assert.deepEqual(applyClearsToCells([[0, 19], [1, 18]], [20, 21]), [[0, 21], [1, 20]]);
  // Cells on cleared rows are destroyed.
  assert.deepEqual(applyClearsToCells([[0, 21], [1, 20]], [21]), [[1, 21]]);
  // Non-adjacent clears: rows 18 and 21.
  assert.deepEqual(applyClearsToCells([[0, 17], [1, 19], [2, 20]], [18, 21]), [[0, 19], [1, 20], [2, 21]]);
  // A clear strictly above the cell does not move it.
  assert.deepEqual(applyClearsToCells([[0, 20]], [10]), [[0, 20]]);
  // All cells destroyed.
  assert.deepEqual(applyClearsToCells([[0, 21], [1, 21]], [21]), []);
});

test('ghost landing cells are a valid placement (fuzz)', () => {
  const rng = makeRng(31337);
  let checked = 0;
  for (let trial = 0; trial < 400 && checked < 100; trial++) {
    const g = randomGame(rng, 15000 + trial);
    if (!g) continue;
    const cells = landingCells(g);
    const p = g.current;
    // Reconstruct the ghost position and verify it is collision-free.
    const gy = cells[0][1] - getCells(p.type, p.rotation)[0][0];
    assert.ok(canPlace(g.board, { type: p.type, rotation: p.rotation, x: p.x, y: gy }), `trial ${trial}: ghost invalid`);
    // And one row below it must collide (it is the landing row).
    assert.ok(!canPlace(g.board, { type: p.type, rotation: p.rotation, x: p.x, y: gy + 1 }), `trial ${trial}: ghost not grounded`);
    checked++;
  }
  assert.ok(checked >= 50, `fuzz coverage too low: ${checked}`);
});
