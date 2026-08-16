import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffStack, keyOf, sourceRow } from '../src/stack-diff.js';
import {
  createBoard,
  createGame,
  hardDrop,
  COLS,
  TOTAL_ROWS,
  HIDDEN_ROWS,
} from '../src/engine.js';
import { applyClearsToCells } from '../src/engine.js';

const DIMS = { cols: COLS, totalRows: TOTAL_ROWS, hiddenRows: HIDDEN_ROWS };

function boardWith(cells) {
  const b = createBoard();
  for (const [x, y, t] of cells) b[y][x] = t;
  return b;
}

// Snapshot a board the way the renderer's prev-state would look.
function snapshot(board) {
  const m = new Map();
  for (let y = HIDDEN_ROWS; y < TOTAL_ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (board[y][x]) m.set(keyOf(x, y), board[y][x]);
    }
  }
  return m;
}

test('diff: empty prev -> adds for all visible cells', () => {
  const b = boardWith([[0, 21, 'Z'], [1, 21, 'T']]);
  const d = diffStack(new Map(), b, DIMS);
  assert.deepEqual(d.adds.map((a) => a.key).sort(), ['0,21', '1,21']);
  assert.deepEqual(d.adds[0], { key: '0,21', x: 0, y: 21, type: 'Z' });
  assert.equal(d.removes.length, 0);
  assert.equal(d.typeChanges.length, 0);
});

test('diff: cells in hidden rows are never rendered', () => {
  const b = boardWith([[0, 0, 'Z'], [1, 1, 'T'], [2, HIDDEN_ROWS, 'L']]);
  const d = diffStack(new Map(), b, DIMS);
  assert.deepEqual(d.adds.map((a) => a.key), ['2,2']);
});

test('diff: emptied cells produce removes and nothing else', () => {
  const prev = new Map([['0,21', 'Z'], ['1,21', 'T']]);
  const b = boardWith([[0, 21, 'Z']]);
  const d = diffStack(prev, b, DIMS);
  assert.deepEqual(d.removes, [{ key: '1,21' }]);
  assert.equal(d.adds.length, 0);
  assert.equal(d.typeChanges.length, 0);
});

test('diff: type change at an existing key (clear shift) is reported', () => {
  const prev = new Map([['0,20', 'O']]);
  const b = boardWith([[0, 20, 'L']]);
  const d = diffStack(prev, b, DIMS);
  assert.deepEqual(d.typeChanges, [
    { key: '0,20', x: 0, y: 20, from: 'O', to: 'L' },
  ]);
  assert.equal(d.adds.length, 0);
  assert.equal(d.removes.length, 0);
});

test('diff: identical states produce no changes', () => {
  const b = boardWith([[3, 15, 'S'], [4, 15, 'S']]);
  const d = diffStack(snapshot(b), b, DIMS);
  assert.equal(d.adds.length + d.removes.length + d.typeChanges.length, 0);
});

test('diff: a cell that both changes type and a neighbor vanishes', () => {
  const prev = new Map([['0,21', 'Z'], ['1,21', 'Z'], ['2,21', 'Z']]);
  const b = boardWith([[0, 21, 'T'], [2, 21, 'L']]);
  const d = diffStack(prev, b, DIMS);
  assert.deepEqual(d.typeChanges.map((c) => c.key).sort(), ['0,21', '2,21']);
  assert.deepEqual(d.removes, [{ key: '1,21' }]);
  assert.equal(d.adds.length, 0);
});

// Applying the diff to the prev state must reconstruct the board exactly.
function applyDiff(prev, d) {
  const next = new Map(prev);
  for (const a of d.adds) next.set(a.key, a.type);
  for (const c of d.typeChanges) next.set(c.key, c.to);
  for (const r of d.removes) next.delete(r.key);
  return next;
}

test('diff: applying the diff to prev exactly reconstructs the board (fuzz)', () => {
  let seed = 7;
  const rng = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const types = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
  let prev = new Map();
  for (let trial = 0; trial < 300; trial++) {
    const b = createBoard();
    for (let y = HIDDEN_ROWS; y < TOTAL_ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (rng() < 0.2) b[y][x] = types[Math.floor(rng() * types.length)];
      }
    }
    const d = diffStack(prev, b, DIMS);
    const next = applyDiff(prev, d);
    assert.deepEqual(next, snapshot(b), `trial ${trial}: diff does not reconstruct board`);
    prev = next;
  }
});

// Integration: the diff of a real engine line clear must report exactly the
// shifted/cleared/added cells — this is the regression for the wrong-color
// glitch (shifted blocks keeping their old material).
test('diff after a real single line clear: shifted marker is a type change, no stale keys', () => {
  const g = createGame(42);
  const y = TOTAL_ROWS - 1; // bottom row
  for (let x = 0; x < COLS; x++) g.board[y][x] = 'Z';
  g.board[y][0] = null;
  g.board[y][1] = null;
  g.board[y - 1][5] = 'L'; // marker above the clear zone
  const prev = snapshot(g.board);
  g.current = { type: 'O', rotation: 0, x: 0, y: 5 };
  hardDrop(g);
  assert.equal(g.lastClear, 1);
  assert.deepEqual(g.clearRows, [y]);

  const d = diffStack(prev, g.board, DIMS);
  // The O completed the bottom row: its two row-y cells were destroyed with
  // the row, its two row-(y-1) cells shifted down into the (previously
  // empty) gap at (0,y),(1,y). The marker L shifted from (5,y-1) onto the
  // Z at (5,y) — a type change, the case that used to render the wrong color.
  assert.deepEqual(d.adds.map((a) => a.key).sort(), ['0,21', '1,21']);
  assert.deepEqual(
    d.typeChanges.map((c) => `${c.key}:${c.from}>${c.to}`),
    ['5,21:Z>L'],
  );
  assert.deepEqual(
    d.removes.map((r) => r.key).sort(),
    ['2,21', '3,21', '4,21', '5,20', '6,21', '7,21', '8,21', '9,21'],
  );
  // No stale keys: applying the diff leaves exactly the live board.
  assert.deepEqual(applyDiff(prev, d), snapshot(g.board));
});

test('diff after a real double line clear: marker shifts down two rows', () => {
  const g = createGame(42);
  const yA = TOTAL_ROWS - 1;
  const yB = TOTAL_ROWS - 2;
  for (const y of [yA, yB]) {
    for (let x = 0; x < COLS; x++) g.board[y][x] = 'Z';
    g.board[y][0] = null;
    g.board[y][1] = null;
  }
  g.board[yB - 1][5] = 'L'; // marker two rows above the clear zone
  const prev = snapshot(g.board);
  g.current = { type: 'O', rotation: 0, x: 0, y: 5 };
  hardDrop(g);
  assert.equal(g.lastClear, 2);
  assert.deepEqual(g.clearRows, [yB, yA]);

  const d = diffStack(prev, g.board, DIMS);
  // Both rows cleared; the marker L lands two rows down on the Z at (5,yA).
  assert.equal(d.adds.length, 0);
  assert.deepEqual(d.typeChanges.map((c) => `${c.key}:${c.from}>${c.to}`), ['5,21:Z>L']);
  // Row 21: 8 Z cells, one ((5,21)) becomes a type change -> 7 removes.
  // Row 20: 8 Z cells removed. Marker's old spot (5,19): 1 remove.
  assert.equal(d.removes.length, 16);
  assert.ok(d.removes.some((r) => r.key === '5,19'));
  assert.deepEqual(applyDiff(prev, d), snapshot(g.board));
});

// ---- sourceRow: the inverse of the engine's clear compaction ----
//
// A clear removes its row and shifts every row above it (toward the top,
// smaller board-y) down by one: post = pre + #{r ∈ cleared : r > pre}
// (exactly what applyClearsToCells does). sourceRow(cleared, y) must return
// the pre-clear row that now sits at post row y — the renderer slides each
// shifted block down from that source row (row-collapse settle).

test('sourceRow: no clears -> identity', () => {
  assert.equal(sourceRow([], 7), 7);
  assert.equal(sourceRow([], 0), 0);
});

test('sourceRow: single bottom clear shifts visible rows up one index', () => {
  // y=0 is the TOP. Clearing the bottom row (21) moves every row above it
  // DOWN one index: post 21 came from pre 20, post 20 from pre 19, ... and
  // rows below the clear are untouched (post 0 = pre 0).
  assert.equal(sourceRow([21], 21), 20);
  assert.equal(sourceRow([21], 20), 19);
  assert.equal(sourceRow([21], 1), 0);
  assert.equal(sourceRow([21], 0), -1); // top post row takes content from above the board
  assert.equal(sourceRow([21], 22), 22); // rows below the clear are untouched
});

test('sourceRow: double clear shifts rows above two indices, rows inside the gap correctly', () => {
  // Clears {20, 21}: rows above (y < 20) shift down by 2; a post row
  // between the two cleared rows (20) takes its content from pre 18
  // (row 19 was itself cleared and removed).
  assert.equal(sourceRow([20, 21], 21), 19);
  assert.equal(sourceRow([20, 21], 20), 18);
  assert.equal(sourceRow([20, 21], 19), 17);
  assert.equal(sourceRow([20, 21], 18), 16);
  assert.equal(sourceRow([20, 21], 2), 0);
  assert.equal(sourceRow([20, 21], 1), -1); // source above the board (hidden zone)
});

test('sourceRow: unsorted and single-element inputs behave identically', () => {
  assert.equal(sourceRow([21, 20], 21), sourceRow([20, 21], 21));
  assert.equal(sourceRow([21, 20], 20), sourceRow([20, 21], 20));
});

// Property: sourceRow must invert applyClearsToCells for every surviving
// row — applying the engine's compaction to the computed source row must
// land exactly on the post row. Fuzzed over random clear sets.
test('sourceRow round-trips applyClearsToCells (fuzz)', () => {
  let seed = 99;
  const rng = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= (t >>> (t >>> 7)) + 0x6d2b79f5 | 0;
    return ((t ^ (t >>> (t >>> 14))) >>> 0) / 4294967296;
  };
  for (let trial = 0; trial < 400; trial++) {
    const cleared = new Set();
    const k = Math.floor(rng() * 5); // 0..4 cleared rows
    while (cleared.size < k) cleared.add(Math.floor(rng() * TOTAL_ROWS));
    const rows = [...cleared].sort((a, b) => a - b);
    for (let y = -4; y < TOTAL_ROWS + 4; y++) {
      if (cleared.has(y)) continue; // cleared post rows have no source
      const s = sourceRow(rows, y);
      const back = applyClearsToCells([[0, s]], rows);
      assert.equal(
        back.length ? back[0][1] : NaN,
        y,
        `trial ${trial}: clears=[${rows}] post ${y}: sourceRow says ${s}, compaction sends it to ${back.length ? back[0][1] : 'void'}`,
      );
    }
  }
});

// Integration: the source rows of a real engine double clear, as the
// renderer would compute them from game.clearRows.
test('sourceRow on a real engine clear matches the compaction the renderer animates', () => {
  const g = createGame(42);
  const yA = TOTAL_ROWS - 1;
  const yB = TOTAL_ROWS - 2;
  for (const y of [yA, yB]) {
    for (let x = 0; x < COLS; x++) g.board[y][x] = 'Z';
    g.board[y][0] = null;
    g.board[y][1] = null;
  }
  g.board[yB - 1][5] = 'L'; // marker: pre (5,19) -> post (5,21)
  g.board[yB - 2][6] = 'I'; // marker: pre (6,18) -> post (6,20)
  const pre = applyClearsToCells([[5, yB - 1], [6, yB - 2]], []);
  g.current = { type: 'O', rotation: 0, x: 0, y: 5 };
  hardDrop(g);
  assert.deepEqual(g.clearRows, [yB, yA]);
  const post = applyClearsToCells(pre, g.clearRows);
  for (const [sx, sy] of post) {
    assert.equal(sourceRow(g.clearRows, sy), sx === 5 ? yB - 1 : yB - 2);
  }
  assert.deepEqual(post.sort((a, b) => a[0] - b[0]), [[5, 21], [6, 20]]);
});
