// Pure diff of the visible board for the 3D stack mesh layer.
//
// The renderer keeps one mesh per filled cell, keyed "x,y". Between frames
// the board changes in three ways:
//   - a cell becomes filled   -> add a mesh
//   - a cell becomes empty    -> remove a mesh
//   - a line clear shifts rows down -> the TYPE at an existing key changes
// The third case is the subtle one: without reporting it, shifted blocks
// keep their old material (wrong-color glitch after every line clear).

export const keyOf = (x, y) => `${x},${y}`;

// Pure inverse of the engine's clear compaction (applyClearsToCells): given
// the set of cleared rows and a POST-clear board row `y`, returns the
// PRE-clear row the block at that position fell from. A clear removes its
// row and shifts every row above it (toward the top, smaller board-y) down
// by one, so post = pre + #{r ∈ cleared : r > pre} and the source row is
// the fixed point `s = y - #{r ∈ cleared : r >= s}`. One descending pass is
// exact: starting from s = y, each cleared row at or below the running
// source pushes it up one row (process largest first, so a row counted for
// a lower source can never uncount a higher one).
//
// The renderer uses this to animate the row collapse: every shifted block
// slides down from its source row instead of teleporting. `y` must be a
// row that exists post-clear (never a cleared row itself); the result can
// be negative (a source in the hidden rows above the board).
export function sourceRow(clearedRows, y) {
  let s = y;
  for (const r of [...clearedRows].sort((a, b) => b - a)) {
    if (r >= s) s--;
  }
  return s;
}

/**
 * Diff a previous stack-type map against the current board.
 *
 * @param {Map<string,string>} prevTypes previous state: key "x,y" -> piece type
 * @param {Array<Array<string|null>>} board full board (TOTAL_ROWS x COLS)
 * @param {{cols:number,totalRows:number,hiddenRows:number}} dims board dims;
 *   only rows hiddenRows..totalRows-1 are rendered
 * @returns {{
 *   adds: Array<{key:string,x:number,y:number,type:string}>,
 *   removes: Array<{key:string}>,
 *   typeChanges: Array<{key:string,x:number,y:number,from:string,to:string}>,
 * }}
 */
export function diffStack(prevTypes, board, { cols, totalRows, hiddenRows }) {
  const adds = [];
  const removes = [];
  const typeChanges = [];
  const seen = new Set();
  for (let y = hiddenRows; y < totalRows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = board[y][x];
      if (!t) continue;
      const key = keyOf(x, y);
      seen.add(key);
      const old = prevTypes.get(key);
      if (old === undefined) adds.push({ key, x, y, type: t });
      else if (old !== t) typeChanges.push({ key, x, y, from: old, to: t });
    }
  }
  for (const key of prevTypes.keys()) {
    if (!seen.has(key)) removes.push({ key });
  }
  return { adds, removes, typeChanges };
}
