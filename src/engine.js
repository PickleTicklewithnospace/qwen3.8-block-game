// Pure Tetris game engine. No DOM, no timers — all state transitions are
// explicit functions so they can be unit-tested and driven by any frontend.

import { PIECES, PIECE_TYPES, getCells, getKicks } from './pieces.js';

export const COLS = 10;
export const ROWS = 20;
export const HIDDEN_ROWS = 2; // spawn zone above the visible board
export const TOTAL_ROWS = ROWS + HIDDEN_ROWS;

export const LINE_SCORES = [0, 100, 300, 500, 800];
export const SOFT_DROP_SCORE = 1;
export const HARD_DROP_SCORE = 2;

export const CONFIG = {
  lockDelayMs: 500,
  lockDelayResets: 15, // max gravity-driven resets per piece
  DASMs: 167, // delayed auto shift
  ARRMs: 33, // auto repeat rate
  softDropFactor: 20, // gravity speed multiplier while soft dropping
  levelsPerLines: 10,
  nextQueueLength: 5,
};

// Gravity interval (ms) per level, classic-style curve.
export function gravityIntervalMs(level) {
  const t = Math.pow(0.8 - (level - 1) * 0.007, level - 1);
  return Math.max(30, Math.floor(1000 * t));
}

// 7-bag randomizer. Returns a piece type.
export function makeBagRng(seed = Date.now()) {
  let state = seed >>> 0;
  const rand = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let bag = [];
  return () => {
    if (bag.length === 0) {
      bag = [...PIECE_TYPES];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.pop();
  };
}

export function createGame(seed) {
  const rng = makeBagRng(seed);
  const queue = Array.from({ length: CONFIG.nextQueueLength + 1 }, () => rng());
  return {
    board: createBoard(),
    queue,
    current: spawnPiece(queue.shift()),
    held: null,
    canHold: true,
    score: 0,
    lines: 0,
    level: 1,
    gameOver: false,
    paused: false,
    // Lock delay bookkeeping. `resets` is the per-piece reset budget
    // (guideline move/rotation reset cap); `lastReset` reports whether the
    // most recent move/rotation actually applied a reset, so frontends own
    // the delay timer without being able to bypass the cap.
    lock: { resets: 0, lastReset: false },
    lastClear: 0, // number of lines cleared by the most recent lock (for effects)
    clearRows: [], // rows just cleared (for effects)
    rng,
  };
}

export function createBoard() {
  return Array.from({ length: TOTAL_ROWS }, () => Array(COLS).fill(null));
}

export function spawnPiece(type) {
  const size = PIECES[type].size;
  const x = Math.floor((COLS - size) / 2);
  // Spawn in the hidden rows (row 0 of total board).
  return { type, rotation: 0, x, y: 0 };
}

function collides(board, piece, dx = 0, dy = 0, rotation = piece.rotation) {
  for (const [r, c] of getCells(piece.type, rotation)) {
    const x = piece.x + c + dx;
    const y = piece.y + r + dy;
    if (x < 0 || x >= COLS || y >= TOTAL_ROWS) return true;
    if (y >= 0 && board[y][x]) return true;
  }
  return false;
}

export function canPlace(board, piece, dx = 0, dy = 0, rotation = piece.rotation) {
  return !collides(board, piece, dx, dy, rotation);
}

export function movePiece(game, dx, dy = 0) {
  if (game.gameOver || game.paused) {
    game.lock.lastReset = false;
    return false;
  }
  const { current } = game;
  if (canPlace(game.board, current, dx, dy)) {
    current.x += dx;
    current.y += dy;
    // Horizontal move while grounded resets the lock delay (capped).
    // Downward moves (gravity/soft drop) never reset it.
    game.lock.lastReset = dy === 0 && isGrounded(game) && resetLockDelay(game);
    return true;
  }
  game.lock.lastReset = false;
  return false;
}

export function isGrounded(game) {
  return !canPlace(game.board, game.current, 0, 1);
}

// Applies one lock-delay reset if budget remains. Returns whether the
// reset was actually applied (false once the per-piece cap is exhausted).
function resetLockDelay(game) {
  if (game.lock.resets < CONFIG.lockDelayResets) {
    game.lock.resets++;
    return true;
  }
  return false;
}

// Rotate with SRS wall kicks. dir: 1 = clockwise, -1 = counter-clockwise.
export function rotatePiece(game, dir) {
  if (game.gameOver || game.paused) return false;
  const { current } = game;
  const from = current.rotation;
  const to = (from + dir + 4) % 4;
  const kicks = getKicks(current.type, from, to);
  for (const [dx, dy] of kicks) {
    if (canPlace(game.board, current, dx, dy, to)) {
      current.x += dx;
      current.y += dy;
      current.rotation = to;
      game.lock.lastReset = isGrounded(game) && resetLockDelay(game);
      return true;
    }
  }
  game.lock.lastReset = false;
  return false;
}

export function ghostY(game) {
  let dy = 0;
  while (canPlace(game.board, game.current, 0, dy + 1)) dy++;
  return game.current.y + dy;
}

// Soft drop one row. Returns true if the piece moved.
export function softDrop(game) {
  if (game.gameOver || game.paused) return false;
  if (movePiece(game, 0, 1)) {
    game.score += SOFT_DROP_SCORE;
    return true;
  }
  return false;
}

// Hard drop: move to ghost position, score, and lock immediately.
export function hardDrop(game) {
  if (game.gameOver || game.paused) return false;
  const dy = ghostY(game) - game.current.y;
  game.score += dy * HARD_DROP_SCORE;
  game.current.y += dy;
  lockPiece(game);
  return true;
}

// Hold / swap piece.
export function holdPiece(game) {
  if (game.gameOver || game.paused || !game.canHold) return false;
  const cur = game.current.type;
  if (game.held) {
    game.current = spawnPiece(game.held);
    game.held = cur;
  } else {
    game.held = cur;
    game.current = spawnPiece(game.queue.shift());
    game.queue.push(game.rng());
  }
  game.canHold = false;
  game.lock = { resets: 0, lastReset: false };
  if (collides(game.board, game.current)) {
    game.gameOver = true;
  }
  return true;
}

// Map pre-clear locked cells to their post-clear board positions.
// A clear removes its row and shifts every row above it down by one, so a
// cell at row y ends up at y + (number of cleared rows strictly below y).
// Cells sitting on a cleared row are destroyed with it.
export function applyClearsToCells(cells, clearedRows) {
  if (clearedRows.length === 0) return cells.map(([x, y]) => [x, y]);
  return cells
    .filter(([x, y]) => !clearedRows.includes(y))
    .map(([x, y]) => [x, y + clearedRows.filter((r) => r > y).length]);
}

// Lock the current piece into the board, clear lines, spawn next.
export function lockPiece(game) {
  // Reset the clear state for THIS lock: the frontend reads these fields to
  // drive FX, and a lock-out lock (game over above the board) must not replay
  // the previous piece's clear.
  game.lastClear = 0;
  game.clearRows = [];
  const { board, current } = game;
  const cells = getCells(current.type, current.rotation).map(
    ([r, c]) => [current.y + r, current.x + c],
  );
  let aboveBoard = false;
  let visible = 0;
  for (const [y, x] of cells) {
    if (y < 0) {
      // Above the board: never written (no partial locks), but the rest of
      // the piece still locks so the final state renders consistently.
      aboveBoard = true;
      continue;
    }
    board[y][x] = current.type;
    if (y >= HIDDEN_ROWS) visible++;
  }
  if (aboveBoard || visible === 0) {
    // Locked above the board, or entirely above the visible field
    // (guideline lock-out) => game over.
    game.gameOver = true;
    return;
  }
  // Clear full lines.
  const full = [];
  for (let y = 0; y < TOTAL_ROWS; y++) {
    if (board[y].every((cell) => cell !== null)) full.push(y);
  }
  for (const y of full) {
    board.splice(y, 1);
    board.unshift(Array(COLS).fill(null));
  }
  const cleared = full.length;
  game.lastClear = cleared;
  game.clearRows = full;
  if (cleared > 0) {
    game.lines += cleared;
    game.level = 1 + Math.floor(game.lines / CONFIG.levelsPerLines);
    game.score += LINE_SCORES[cleared] * game.level;
  }
  // Spawn next piece.
  game.current = spawnPiece(game.queue.shift());
  game.queue.push(game.rng());
  game.canHold = true;
  game.lock = { resets: 0, lastReset: false };
  if (collides(game.board, game.current)) {
    game.gameOver = true;
  }
}

// Advance gravity: if the piece can fall, move it down; otherwise the caller
// should start/continue the lock delay. Returns:
//  'fell' | 'grounded' | 'noop'
export function stepGravity(game) {
  if (game.gameOver || game.paused) return 'noop';
  if (movePiece(game, 0, 1)) {
    return 'fell';
  }
  return 'grounded';
}

export function togglePause(game) {
  if (game.gameOver) return;
  game.paused = !game.paused;
}

// Snapshot of the next pieces for the UI.
export function nextPieces(game, n = 3) {
  return game.queue.slice(0, n);
}
