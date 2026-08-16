// Browser shell for the Tetris engine: input, timing, and the three.js
// scene. The board is rendered in 3D (src/renderer3d.js); hold/next are
// shown both as 2D canvas panels and as in-stage holographic displays
// (renderer.setHold / setNext).

import {
  createGame,
  movePiece,
  rotatePiece,
  softDrop,
  hardDrop,
  holdPiece,
  lockPiece,
  ghostY,
  nextPieces,
  applyClearsToCells,
} from './src/engine.js';
import { PIECES, getCells } from './src/pieces.js';
import { landingCells, predictClears } from './src/predict.js';
import { popupFor, STREAK_LEVEL, boardEmpty } from './src/fx-labels.js';
import { dangerOf } from './src/danger.js';
import { TetrisRenderer3D } from './src/renderer3d.js';
import {
  createTiming,
  advanceFrame,
  notifyMoved,
  resetForNewPiece,
  resetShift,
  startFreeze,
  clearFreeze,
  MAX_FRAME_MS,
} from './src/loop.js';
import { createDirInput, pressDir, releaseDir, clearDirs } from './src/input.js';

// ---- DOM ----
const boardCanvas = document.getElementById('board');
const holdCanvas = document.getElementById('hold');
const nextCanvas = document.getElementById('next');
const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlaySub = document.getElementById('overlay-sub');
const scoreEl = document.getElementById('score');
const levelEl = document.getElementById('level');
const linesEl = document.getElementById('lines');
const bestEl = document.getElementById('best');

const DPR = Math.min(window.devicePixelRatio || 1, 2);

// Length of the visual dash after a line clear (gameplay pauses for it).
const CLEAR_FREEZE_MS = 220;

function setupCanvas(canvas, w, h) {
  canvas.width = w * DPR;
  canvas.height = h * DPR;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);
  return ctx;
}

const hctx = setupCanvas(holdCanvas, 120, 60);
const nctx = setupCanvas(nextCanvas, 120, 180);

// ---- 3D renderer ----
const renderer = new TetrisRenderer3D(boardCanvas);
new ResizeObserver(() => {
  renderer.resize(boardCanvas.clientWidth, boardCanvas.clientHeight);
}).observe(boardCanvas);

window.addEventListener('pointermove', (e) => {
  renderer.setPointer((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1));
});

// ---- State ----
let game = createGame();
let best = Number(localStorage.getItem('tetris.best') || 0);
bestEl.textContent = best;

let lastTime = 0;
// All gameplay timing (gravity, lock delay, DAS/ARR, soft-drop repeat and the
// line-clear dash) lives in the pure src/loop.js state machine.
let timing = createTiming();

// Horizontal keys (press-ordered, so holding both directions behaves).
const dirInput = createDirInput();
let softHeld = false;

// Identity of the current piece object. The engine replaces game.current
// with a fresh object on every spawn (lock/hold/restart), so object
// identity is a reliable "new piece" signal — needed because the renderer
// can't tell a back-to-back same-type spawn from the same piece moving.
let lastPiece = null;

// Consecutive clear-locks (the popup banner logic lives in the pure
// src/fx-labels.js; this counter is frontend bookkeeping the engine doesn't
// track). Reset by any no-clear lock, hold or restart.
let combo = 0;

// ---- Input ----
window.addEventListener('keydown', (e) => {
  if (e.repeat) {
    // We handle auto-repeat ourselves for horizontal; ignore repeats.
    if (['ArrowLeft', 'ArrowRight', 'ArrowDown'].includes(e.key)) e.preventDefault();
    return;
  }
  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      if (pressDir(dirInput, -1)) onDirChanged();
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (pressDir(dirInput, 1)) onDirChanged();
      break;
    case 'ArrowDown':
      e.preventDefault();
      softHeld = true;
      timing.softAccum = 0;
      if (softDrop(game)) onPieceMoved();
      break;
    case 'ArrowUp':
    case 'x':
    case 'X':
      e.preventDefault();
      doRotate(1);
      break;
    case 'z':
    case 'Z':
      e.preventDefault();
      doRotate(-1);
      break;
    case ' ':
      e.preventDefault();
      doLock(hardDrop);
      break;
    case 'c':
    case 'C':
    case 'Shift':
      if (holdPiece(game)) afterHold();
      break;
    case 'p':
    case 'P':
      if (!game.gameOver) {
        game.paused = !game.paused;
        updateOverlay();
      }
      break;
    case 'r':
    case 'R':
      restart();
      break;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' && releaseDir(dirInput, -1)) onDirChanged();
  if (e.key === 'ArrowRight' && releaseDir(dirInput, 1)) onDirChanged();
  if (e.key === 'ArrowDown') softHeld = false;
});

// The active horizontal direction changed (fresh press, or fell back to the
// other key that is still held): move once immediately for responsiveness and
// restart the auto-shift charge.
function onDirChanged() {
  resetShift(timing);
  if (dirInput.dir !== 0 && movePiece(game, dirInput.dir, 0)) onPieceMoved();
}

function onPieceMoved() {
  // The engine is the source of truth for lock-delay resets and enforces
  // the per-piece reset cap. Only restart the frontend timer when the
  // engine actually applied a reset — otherwise rapid tapping could hold a
  // piece on the ground forever (infinite lock delay).
  notifyMoved(game, timing);
}

// Lock the current piece via `fn` (hardDrop or lockPiece), capturing FX
// info before the engine mutates state. A hard drop additionally leaves
// light trails: the piece's pre-drop position is captured before fn() moves
// it. The lock-impact splash needs the locked piece's type/color, also
// captured pre-drop (game.current is replaced on spawn); the popup banner
// needs the pre-lock level (a level-up crosses the threshold inside fn()).
// Rotate the current piece (the same entry point the ArrowUp/x/z keys
// use), capturing the PRE-rotation state first so the renderer can flash
// a holographic afterimage of the footprint the piece just left (the
// engine may wall-kick the piece, so the echo must anchor on the old
// x/y/rotation). Exposed on window.__tetris so browser tests can drive
// rotations deterministically inside one synchronous in-page evaluate.
function doRotate(dir) {
  if (game.gameOver || game.paused) return;
  const prev = {
    type: game.current.type,
    rotation: game.current.rotation,
    x: game.current.x,
    y: game.current.y,
  };
  if (rotatePiece(game, dir)) {
    onPieceMoved();
    renderer.onRotate(prev.type, prev.rotation, prev.x, prev.y);
  }
}

function doLock(fn) {
  if (game.gameOver || game.paused) return;
  const cells = landingCells(game);
  const clears = predictClears(game);
  const isHard = fn === hardDrop;
  const meta = { type: game.current.type, hard: isHard };
  const prevLevel = game.level;
  const from = isHard
    ? {
        type: game.current.type,
        rotation: game.current.rotation,
        x: game.current.x,
        y: game.current.y,
      }
    : null;
  fn(game);
  if (isHard) renderer.onHardDrop(from, cells);
  afterLock(cells, clears, meta, prevLevel);
}

function afterLock(cells, clears, meta, prevLevel) {
  resetForNewPiece(timing);
  // A new lock ends the previous clear's dash: locking mid-dash must not
  // leave the fresh piece frozen for the remainder.
  clearFreeze(timing);
  if (game.clearRows.length > 0) {
    startFreeze(timing, CLEAR_FREEZE_MS);
    // Line-clear FX must be queued BEFORE the post-collapse board diff:
    // onLineClear records the cleared rows and the next setStack uses them
    // to slide every shifted block down from its source row (row-collapse
    // settle). It touches no stack meshes, so ordering it ahead of the diff
    // is safe.
    // Colors were captured pre-clear by the prediction; zip them by row.
    const colorByRow = new Map(clears.rows.map((r, i) => [r, clears.colors[i]]));
    renderer.onLineClear(game.clearRows, game.clearRows.map((r) => colorByRow.get(r)));
  }
  renderer.setStack(game.board); // so onLock can find the fresh meshes
  // Locked cells that survive the clear have shifted down; map them to
  // post-clear coordinates so the pop FX and the lock-impact splash hit
  // the meshes/cells that now hold them (cells destroyed by the clear are
  // dropped). Rows come from the engine (what actually cleared — a lock-out
  // lock clears nothing, even if the prediction saw full hidden rows).
  const postClear = applyClearsToCells(cells, game.clearRows);
  renderer.onLock(postClear, { hard: meta.hard, color: PIECES[meta.type].color });
  // Popup banner: the label/tier logic is pure (src/fx-labels.js).
  combo = game.clearRows.length > 0 ? combo + 1 : 0;
  const spec = popupFor({
    clears: game.clearRows.length,
    combo,
    level: game.level,
    prevLevel,
  });
  if (spec) renderer.showPopup(spec);
  // Level-up: the stage re-inks to the new level's palette (renderer owns
  // the aurora surge + sonic ring + spark fountain; the LEVEL N banner came
  // from popupFor above, using the pre-lock level captured in doLock).
  if (game.level > prevLevel) renderer.onLevelUp(game.level);
  // Streak-mode ignition: the lock that carries the stage from level 9 to
  // 10 lights the settled stack up as a living rainbow (the renderer owns
  // the full-board rainbow sweep + surge; the STREAK banner came from
  // popupFor above).
  if (prevLevel < STREAK_LEVEL && game.level >= STREAK_LEVEL) renderer.onStreakIgnite();
  // Perfect clear: the post-clear board is empty (the pure boardEmpty
  // signal). The renderer owns the celebration (flash, rainbow sweep,
  // double ring, gold fountain, the PERFECT CLEAR! banner + flare); a
  // 4-line perfect stacks it with the TETRIS banner above.
  if (game.clearRows.length > 0 && boardEmpty(game.board)) renderer.onPerfect();
  if (game.gameOver) {
    if (game.score > best) {
      best = game.score;
      localStorage.setItem('tetris.best', String(best));
      bestEl.textContent = best;
    }
    renderer.onGameOver();
    updateOverlay();
  }
}

function afterHold() {
  resetForNewPiece(timing);
  clearFreeze(timing); // a hold ends the previous clear's dash too
  combo = 0; // holding breaks the clear streak
  if (game.gameOver) {
    renderer.onGameOver();
    updateOverlay();
  }
}

function restart() {
  game = createGame();
  timing = createTiming();
  combo = 0;
  clearInput();
  renderer.reset();
  updateOverlay();
}

// Keyup events are lost when the window/tab loses focus; without clearing
// the input state, DAS/ARR and soft-drop would keep running on a phantom
// held key forever.
function clearInput() {
  clearDirs(dirInput);
  resetShift(timing);
  softHeld = false;
}
window.addEventListener('blur', clearInput);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInput();
    if (!game.gameOver && !game.paused) {
      game.paused = true;
      updateOverlay();
    }
  }
});

overlay.addEventListener('click', () => {
  if (game.gameOver) restart();
});

// ---- Game loop ----
function frame(now) {
  const dt = Math.min(now - lastTime, MAX_FRAME_MS);
  lastTime = now;

  advanceFrame(game, timing, dt, { dir: dirInput.dir, soft: softHeld }, {
    moved: onPieceMoved,
    lock: () => doLock(lockPiece),
  });

  render(now, dt / 1000);
  requestAnimationFrame(frame);
}

function updateOverlay() {
  if (game.gameOver) {
    overlayTitle.textContent = 'Game Over';
    overlaySub.textContent = `Score ${game.score.toLocaleString()} — click or press R to restart`;
    overlay.classList.remove('hidden');
  } else if (game.paused) {
    overlayTitle.textContent = 'Paused';
    overlaySub.textContent = 'Press P to resume';
    overlay.classList.remove('hidden');
  } else {
    overlay.classList.add('hidden');
  }
}

// ---- Rendering ----
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${g},${b})`;
}

function render(now, dt) {
  renderer.setStack(game.board);

  if (!game.gameOver) {
    const p = game.current;
    const isNew = p !== lastPiece;
    lastPiece = p;
    renderer.setPiece(p.type, p.rotation, p.x, p.y, isNew);
    const gy = ghostY(game);
    if (gy > p.y) renderer.setGhost(p.type, p.rotation, p.x, gy, true);
    else renderer.setGhost(p.type, p.rotation, p.x, gy, false);
  }

  // Holographic stage displays (hold left, next right): the renderer diffs
  // against its previous state, so per-frame calls are cheap no-ops unless
  // the hold/queue actually changed.
  const next = nextPieces(game, 3);
  renderer.setHold(game.held);
  renderer.setNext(next);

  // Redline alarm: feed the settled stack's height (pure src/danger.js) to
  // the renderer's eased alarm state. Skipped while the game-over lights
  // out owns the stage — the board is still full at that point, and the
  // alarm must hand off to the cinematic (onGameOver re-targets it to 0).
  if (!game.gameOver) renderer.setDanger(dangerOf(game.board));

  renderer.tick(dt);

  renderSide(hctx, 120, 60, game.held ? [game.held] : [], 1);
  renderSide(nctx, 120, 180, next, 3);

  scoreEl.textContent = game.score.toLocaleString();
  levelEl.textContent = game.level;
  linesEl.textContent = game.lines;
}

function renderSide(ctx, w, h, types, count) {
  ctx.clearRect(0, 0, w, h);
  const size = 20;
  for (let i = 0; i < count; i++) {
    const t = types[i];
    if (!t) continue;
    const cells = getCells(t, 0);
    const xs = cells.map(([, c]) => c);
    const ys = cells.map(([r]) => r);
    const bw = Math.max(...xs) - Math.min(...xs) + 1;
    const bh = Math.max(...ys) - Math.min(...ys) + 1;
    const ox = (w - bw * size) / 2 - Math.min(...xs) * size;
    const oy = (h / count) * i + (h / count - bh * size) / 2 - Math.min(...ys) * size;
    for (const [r, c] of cells) {
      ctx.fillStyle = PIECES[t].color;
      ctx.fillRect(ox + c * size, oy + r * size, size, size);
      ctx.fillStyle = shade(PIECES[t].color, 1.3);
      ctx.fillRect(ox + c * size, oy + r * size, size, 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.strokeRect(ox + c * size + 0.5, oy + r * size + 0.5, size - 1, size - 1);
    }
  }
}

// Exposed for debugging / smoke tests. doHold / doHardDrop are the same
// entry points the key handlers use, exposed so browser tests can drive a
// hold/lock deterministically inside a single synchronous in-page evaluate
// (no tick can fire between the state capture and the action).
window.__tetris = {
  get game() { return game; },
  get timing() { return timing; },
  get combo() { return combo; },
  dirInput,
  renderer,
  ghostY,
  getCells,
  doHold: () => { if (holdPiece(game)) afterHold(); },
  doRotate: (dir) => doRotate(dir),
  doHardDrop: () => doLock(hardDrop),
};

updateOverlay();
requestAnimationFrame((t) => {
  lastTime = t;
  requestAnimationFrame(frame);
});
