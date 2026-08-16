// Invariant tests for the board<->world coordinate transforms (src/coords.js).
//
// The core rule: a block of a piece at board (x, y) must render exactly on
// its board cell. The renderer positions the piece group at pieceAnchor() and
// offsets each block by blockOffset(); if those don't compose to cellWorld(),
// the piece floats above the stack, jumps on lock, and the ghost misses its
// landing position. These tests pin that composition for every piece.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toWorldX,
  toWorldY,
  cellWorld,
  pieceAnchor,
  blockOffset,
  pieceBlocksWorld,
  anyHiddenCell,
  impactAnchor,
} from '../src/coords.js';
import { PIECES, PIECE_TYPES, getCells } from '../src/pieces.js';
import { COLS, TOTAL_ROWS, HIDDEN_ROWS } from '../src/engine.js';

const EPS = 1e-9;
const close = (a, b) => Math.abs(a - b) < EPS;

test('cellWorld maps board cells to world centers (bottom row at 0.5, y inverted)', () => {
  assert.ok(close(toWorldY(TOTAL_ROWS - 1), 0.5), 'bottom row center at world y 0.5');
  assert.ok(close(toWorldY(0), TOTAL_ROWS - 0.5), 'top row center at world y TOTAL_ROWS-0.5');
  // World y strictly decreases as board y increases (board +y is down).
  assert.ok(toWorldY(0) > toWorldY(1) > toWorldY(TOTAL_ROWS - 1));
  assert.ok(close(toWorldX(0), -(COLS - 1) / 2), 'left col at -half width');
  assert.ok(close(toWorldX(COLS - 1), (COLS - 1) / 2), 'right col at +half width');
  assert.ok(close(cellWorld(3, 7).x, toWorldX(3)));
  assert.ok(close(cellWorld(3, 7).y, toWorldY(7)));
});

test('anchor is the bounding-box center for every piece', () => {
  for (const type of PIECE_TYPES) {
    const n = PIECES[type].size;
    for (const [x, y] of [[0, 0], [4, 10], [COLS - n, TOTAL_ROWS - n]]) {
      const a = pieceAnchor(type, x, y);
      assert.ok(close(a.x, toWorldX(x + (n - 1) / 2)), `${type} anchor x @(${x},${y})`);
      assert.ok(close(a.y, toWorldY(y + (n - 1) / 2)), `${type} anchor y @(${x},${y})`);
    }
  }
});

test('anchor + offset lands every block exactly on its board cell (all pieces)', () => {
  for (const type of PIECE_TYPES) {
    const n = PIECES[type].size;
    // Several placements, including the walls and the floor.
    for (const [x, y] of [[0, 0], [4, 10], [COLS - n, 0], [0, TOTAL_ROWS - n], [5, 3]]) {
      const a = pieceAnchor(type, x, y);
      for (const [r, c] of getCells(type, 0)) {
        const o = blockOffset(type, r, c);
        const w = cellWorld(x + c, y + r);
        assert.ok(close(a.x + o.x, w.x), `${type} (${r},${c}) @(${x},${y}) x: ${a.x + o.x} != ${w.x}`);
        assert.ok(close(a.y + o.y, w.y), `${type} (${r},${c}) @(${x},${y}) y: ${a.y + o.y} != ${w.y}`);
      }
    }
  }
});

test('pieceBlocksWorld lands all blocks on their cells (spawn layout, all pieces)', () => {
  for (const type of PIECE_TYPES) {
    const n = PIECES[type].size;
    for (const [x, y] of [[0, 0], [4, 12], [COLS - n, TOTAL_ROWS - n]]) {
      for (const b of pieceBlocksWorld(type, x, y)) {
        const w = cellWorld(b.bx, b.by);
        assert.ok(close(b.x, w.x), `${type} block x @(${x},${y})`);
        assert.ok(close(b.y, w.y), `${type} block y @(${x},${y})`);
      }
    }
  }
});

// The regression this module exists for: the anchor y term must SUBTRACT the
// half-box (world +y is up, board +y is down). If it ever adds, the piece
// floats (n-1) cells high and this fails.
test('anchor y is BELOW the top row (world +y up), not above it', () => {
  for (const type of PIECE_TYPES) {
    const n = PIECES[type].size;
    const x = 4, y = 10;
    const a = pieceAnchor(type, x, y);
    const topRow = toWorldY(y);
    assert.ok(a.y < topRow, `${type}: anchor y ${a.y} must be below top row ${topRow}`);
    assert.ok(close(topRow - a.y, (n - 1) / 2), `${type}: anchor is (n-1)/2 below the top row`);
  }
});

// Hidden-row visibility: the renderer hides the piece/ghost group while any
// cell is above the visible field (the board frame only covers rows
// HIDDEN_ROWS..TOTAL_ROWS-1). These tests pin the exact boundary for every
// piece and rotation, so an off-by-one in the comparison would show a piece
// one row too early (floating over the frame) or hide it one row too late.
test('anyHiddenCell matches the spec for every piece/rotation/row (exhaustive)', () => {
  for (const type of PIECE_TYPES) {
    for (let rotation = 0; rotation < 4; rotation++) {
      for (let y = -2; y <= 6; y++) {
        const expected = getCells(type, rotation).some(([r]) => y + r < HIDDEN_ROWS);
        assert.equal(
          anyHiddenCell(type, rotation, y),
          expected,
          `${type} rot${rotation} y=${y}: expected hidden=${expected}`,
        );
      }
    }
  }
});

test('anyHiddenCell flips exactly at the first fully-visible row (per piece/rotation)', () => {
  for (const type of PIECE_TYPES) {
    for (let rotation = 0; rotation < 4; rotation++) {
      const topRow = Math.min(...getCells(type, rotation).map(([r]) => r));
      const firstVisibleY = HIDDEN_ROWS - topRow;
      assert.equal(
        anyHiddenCell(type, rotation, firstVisibleY - 1),
        true,
        `${type} rot${rotation}: still hidden at y=${firstVisibleY - 1}`,
      );
      assert.equal(
        anyHiddenCell(type, rotation, firstVisibleY),
        false,
        `${type} rot${rotation}: visible at y=${firstVisibleY}`,
      );
    }
  }
});

test('anyHiddenCell concrete boundaries (spawn rows hidden, top visible row shown)', () => {
  // O: 2x2. Spawn at y=0 (rows 0,1) hidden; y=1 (rows 1,2) still hidden;
  // y=2 (rows 2,3) fully inside the visible field.
  assert.equal(anyHiddenCell('O', 0, 0), true);
  assert.equal(anyHiddenCell('O', 0, 1), true);
  assert.equal(anyHiddenCell('O', 0, 2), false);
  // I horizontal: cells sit in box row 1, so it is visible one row earlier
  // than the O piece (y=1 puts its cells on visible row 2).
  assert.equal(anyHiddenCell('I', 0, 0), true);
  assert.equal(anyHiddenCell('I', 0, 1), false);
  // I vertical: cells span box rows 0..3, so it needs y=2 to be visible.
  assert.equal(anyHiddenCell('I', 1, 1), true);
  assert.equal(anyHiddenCell('I', 1, 2), false);
  // T: cells in box rows 0..1 -> visible from y=2.
  assert.equal(anyHiddenCell('T', 0, 1), true);
  assert.equal(anyHiddenCell('T', 0, 2), false);
  // A piece fully below the hidden zone is never hidden.
  for (const type of PIECE_TYPES) {
    for (let rotation = 0; rotation < 4; rotation++) {
      assert.equal(anyHiddenCell(type, rotation, 10), false, `${type} rot${rotation} y=10`);
    }
  }
});

test('impactAnchor: empty cell list anchors nothing (no FX)', () => {
  assert.equal(impactAnchor([]), null);
  assert.equal(impactAnchor(null), null);
});

test('impactAnchor: single cell sits on its cell (world x, lowest row)', () => {
  assert.deepEqual(impactAnchor([[3, 7]]), { wx: toWorldX(3), row: 7 });
});

test('impactAnchor: centroid x is the mean of the cells, in world units', () => {
  // Cells at x=0 and x=9: centroid 4.5 = board center = world x 0.
  assert.deepEqual(impactAnchor([[0, 5], [9, 7]]), { wx: 0, row: 7 });
  // T lock at x=3 (cells 3,4,4,5): centroid 4 -> world -0.5.
  const a = impactAnchor([[3, 19], [4, 19], [4, 20], [5, 20]]);
  assert.equal(a.wx, toWorldX(4));
  assert.equal(a.row, 20);
});

test('impactAnchor: row is the LOWEST locked cell (max y), not the min', () => {
  // A vertical I landing with its base two rows below its top: the impact
  // point is the base, so the FX spark doesn't fire from the top cell.
  const a = impactAnchor([[4, 14], [4, 15], [4, 16], [4, 17]]);
  assert.equal(a.row, 17);
});
