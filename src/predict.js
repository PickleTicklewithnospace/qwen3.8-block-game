// Pure landing/clear prediction, used by the frontend for lock FX and
// line-clear effects. Extracted from main.js so it can be unit-tested
// against the engine: the prediction must always match what lockPiece
// actually does.
//
// A piece only ever locks at its ghost (landing) position — a hard drop
// moves it there first, and the lock delay only fires while grounded
// (i.e., already there) — so the ghost cells are the landing cells in
// both cases.

import { ghostY, COLS, TOTAL_ROWS } from './engine.js';
import { PIECES, getCells } from './pieces.js';

// Cells the current piece will occupy when it locks: [x, y] in board coords.
export function landingCells(g) {
  const p = g.current;
  const gy = ghostY(g);
  return getCells(p.type, p.rotation).map(([r, c]) => [p.x + c, gy + r]);
}

// Rows that will be full once the current piece locks, with the colors that
// will fill them (captured before the engine clears them). `rows` is sorted
// ascending and `colors[i]` corresponds to `rows[i]`.
export function predictClears(g) {
  const cells = landingCells(g);
  const rows = [];
  const colors = [];
  for (let y = 0; y < TOTAL_ROWS; y++) {
    let count = 0;
    const rowColors = [];
    for (let x = 0; x < COLS; x++) {
      const t = g.board[y][x];
      if (t) {
        count++;
        rowColors.push(PIECES[t].color);
      }
    }
    for (const [cx, cy] of cells) {
      if (cy === y) {
        count++;
        rowColors.push(PIECES[g.current.type].color);
      }
    }
    if (count >= COLS) {
      rows.push(y);
      colors.push(rowColors);
    }
  }
  return { rows, colors };
}
