// Pure board<->world coordinate transforms for the 3D renderer.
//
// Board coords: x in [0, COLS), y in [0, TOTAL_ROWS) with y=0 at the TOP.
// World coords: three.js, +y is up; the board's bottom row center sits at
// world y 0.5. A block at board cell (x, y) is drawn at cellWorld(x, y).
//
// The piece group is positioned at pieceAnchor(type, x, y) (the bounding-box
// center) and each block is offset from it by blockOffset(type, r, c). The
// invariant (pinned by test/coords.test.js) is that anchor + offset lands
// every block exactly on its board cell. A sign error in the anchor makes the
// piece float (n-1) cells above the stack, jump down on lock, and makes the
// ghost miss its landing position — so this module is pure and unit-tested
// rather than living inside the WebGL class.

import { COLS, TOTAL_ROWS, HIDDEN_ROWS } from './engine.js';
import { PIECES, getCells } from './pieces.js';

export const toWorldX = (x) => x - (COLS - 1) / 2;
export const toWorldY = (y) => TOTAL_ROWS - 1 - y + 0.5;

// World position of the center of board cell (x, y).
export function cellWorld(x, y) {
  return { x: toWorldX(x), y: toWorldY(y) };
}

function halfOf(type) {
  return (PIECES[type].size - 1) / 2;
}

// World anchor (bounding-box center) of a piece at board (x, y).
//
// Board +y points DOWN but world +y points UP, so the box center is half a
// box BELOW the top row in world space: toWorldY(y) - half, not +. (The x
// axis agrees in both spaces, so it is toWorldX(x) + half.)
export function pieceAnchor(type, x, y) {
  const h = halfOf(type);
  return { x: toWorldX(x) + h, y: toWorldY(y) - h };
}

// Offset of a block at cell (r, c) relative to the piece anchor.
export function blockOffset(type, r, c) {
  const h = halfOf(type);
  return { x: c - h, y: -(r - h) };
}

// World position of every block of a piece at board (x, y) in its spawn
// (rotation 0) layout. Rotated states are these same offsets rotated around
// the anchor by the group's rotation.z — the anchor is the rotation center,
// so getting it right is what keeps rotated pieces on their cells too.
export function pieceBlocksWorld(type, x, y) {
  const a = pieceAnchor(type, x, y);
  return getCells(type, 0).map(([r, c]) => {
    const o = blockOffset(type, r, c);
    return { x: a.x + o.x, y: a.y + o.y, bx: x + c, by: y + r };
  });
}

// True while ANY cell of the piece at board row y is in a hidden row (above
// the visible field). The renderer hides the piece/ghost group in that
// state: the board frame only covers the visible field, so a cell in a
// hidden row would render floating above the frame / clipped at the top of
// the screen. A piece is fully visible exactly when
// y >= HIDDEN_ROWS - (topmost cell row of the rotation).
export function anyHiddenCell(type, rotation, y, hiddenRows = HIDDEN_ROWS) {
  return getCells(type, rotation).some(([r]) => y + r < hiddenRows);
}

// Anchor for lock-impact FX: the centroid x of the locked cells (already in
// world units via toWorldX) and the LOWEST row (max y) — the point where
// the piece meets the stack. Returns null for an empty cell list (a lock
// whose cells were all destroyed by the clear, or a no-op lock: no FX).
export function impactAnchor(cells, cols = COLS) {
  if (!cells || cells.length === 0) return null;
  let sx = 0;
  let row = -Infinity;
  for (const [x, y] of cells) {
    sx += x;
    if (y > row) row = y;
  }
  return { wx: sx / cells.length - (cols - 1) / 2, row };
}
