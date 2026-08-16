// Regression: the game must keep working AFTER a line clear.
//
// Historically `clearFx` (the 220ms line-clear freeze) was never expired, so
// after the first line clear the frame loop stopped processing gravity,
// DAS/ARR, soft-drop repeat and the lock delay forever — the new piece
// floated in mid-air and held keys stopped repeating.
//
// Also verifies the lock-delay reset cap end-to-end: once the engine's
// per-piece reset budget is exhausted, tapping left/right must NOT keep
// resetting the lock timer (infinite-lock exploit).
//
// All waits are deadline-based polling (headless SwiftShader frames are
// slow and variable; fixed wall-time waits are flaky).
//
// Usage: node test/post-clear.mjs [url]

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8901/index.html';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(1200);

const results = [];
function check(name, cond) { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}`); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function key(type, k) {
  return page.evaluate(([t, k]) => {
    window.dispatchEvent(new KeyboardEvent(t, { key: k }));
  }, [type, k]);
}

// Snapshot of the relevant game state, plus a per-piece-object tag so
// spawns/locks are detectable across snapshots (atomic: one evaluate).
let lastTag = null;
async function tagged() {
  const s = await page.evaluate(() => {
    const g = window.__tetris.game;
    const p = g.current;
    if (!p.__tag) p.__tag = Math.random();
    return {
      y: p.y,
      x: p.x,
      score: g.score,
      lines: g.lines,
      cells: g.board.flat().filter(Boolean).length,
      tag: p.__tag,
    };
  });
  const pieceChanged = lastTag !== null && s.tag !== lastTag;
  lastTag = s.tag;
  return { ...s, pieceChanged };
}

// Poll a page-side predicate (real function + arg) until true or deadline.
async function waitUntil(pred, arg, timeoutMs = 8000, pollMs = 100) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred, arg)) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(pollMs);
  }
}

// ---- Phase 1: clear a line, then verify the game keeps running ----
// Rig: bottom row full except cols 0-1; O piece dropped at x=0 completes it.
await page.evaluate(() => {
  const g = window.__tetris.game;
  const y = g.board.length - 1;
  for (let x = 0; x < 10; x++) g.board[y][x] = x < 2 ? null : 'Z';
  g.current = { type: 'O', rotation: 0, x: 0, y: 10 };
});
await sleep(100);
const before = await tagged();
check('rig: 1 line about to clear', before.lines === 0);

await key('keydown', ' ');
await key('keyup', ' ');
const afterClear = await tagged();
check('line cleared', afterClear.lines === 1);
check('new piece spawned after clear', afterClear.pieceChanged);

// Gravity must still run after the clear freeze (level 1: 1000ms/row).
const g0 = await tagged();
const fell = await waitUntil(
  (y0) => window.__tetris.game.current.y > y0,
  g0.y,
);
check('gravity still falls after clear', fell);

// DAS/ARR must still repeat: hold Left until the piece moved >=3 cells.
const d0 = await tagged();
await key('keydown', 'ArrowLeft');
const dasOk = await waitUntil(
  (x0) => x0 - window.__tetris.game.current.x >= 3,
  d0.x,
);
await key('keyup', 'ArrowLeft');
const d1 = await tagged();
check('DAS repeat works after clear (moved >=3 cells left)', dasOk && d1.x <= d0.x - 3);

// Soft-drop repeat must still work: hold Down until score climbs by >=2.
const s0 = await tagged();
await key('keydown', 'ArrowDown');
const sdOk = await waitUntil(
  (sc) => window.__tetris.game.score >= sc + 2,
  s0.score,
);
await key('keyup', 'ArrowDown');
check('soft drop repeat works after clear', sdOk);

// ---- Phase 2: lock-delay reset cap (no infinite-lock exploit) ----
// Ground a piece, exhaust the reset budget, then tap left/right. With the
// cap enforced the piece must lock; without it, tapping keeps it alive.
await page.evaluate(() => {
  const g = window.__tetris.game;
  g.current.x = 3;
  g.current.y = g.board.length - 1 - 2; // bottom for a 2-tall piece
  g.lock.resets = 15; // == CONFIG.lockDelayResets (cap exhausted)
});
await sleep(100);
const l0 = await tagged();
let locked = false;
const t0 = Date.now();
let i = 0;
while (Date.now() - t0 < 8000 && !locked) {
  const k = i++ % 2 === 0 ? 'ArrowLeft' : 'ArrowRight';
  await key('keydown', k);
  await key('keyup', k);
  await sleep(40);
  const s = await tagged();
  locked = s.pieceChanged || s.cells > l0.cells;
}
check('piece locks despite taps once reset cap exhausted', locked);

// ---- Phase 3: a hard drop during the clear dash must not freeze the new piece ----
// The 220ms dash belongs to the piece that just cleared. Locking a new piece
// mid-dash must end it: otherwise the fresh piece sits frozen for the
// remainder and held keys feel dead right after a clear.
//
// The WHOLE scenario runs in ONE in-page evaluate: dispatchEvent runs the
// key handler (doLock -> startFreeze/clearFreeze) synchronously, so every
// state read below is the exact same-task value — no frame and no
// evaluate round-trip can elapse between the drop and the read it validates.
// (The old sequence read `timing.freeze` via three separate evaluates + a
// wall sleep, and on fast machines the round-trip latency out-raced the
// 220ms dash, flaking the "dash still active" precondition.)
const p3 = await page.evaluate(async () => {
  const g = window.__tetris.game;
  const t = window.__tetris.timing;
  const y = g.board.length - 1;
  for (let x = 0; x < 10; x++) g.board[y][x] = x < 2 ? null : 'Z';
  g.current = { type: 'O', rotation: 0, x: 0, y: 10 };
  g.lock = { resets: 0, lastReset: false };
  g.paused = false;
  g.gameOver = false;
  const drop = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
  };
  const before1 = g.current;
  const lines0 = g.lines;
  drop(); // first drop: O completes the Z row -> 220ms dash starts
  const freezeAfterFirst = t.freeze; // exact post-drop value (same task)
  const piece2 = g.current;
  // Mid-dash point: 60ms in-page. Tick time advances at most as fast as
  // wall time, so 60ms of tick < the 220ms dash — the dash is provably
  // still alive when the second lock lands, on fast or slow frames alike.
  await new Promise((r) => setTimeout(r, 60));
  const freezeMid = t.freeze;
  drop(); // second drop mid-dash (the board is empty now, so it clears nothing)
  return {
    cleared: g.lines === lines0 + 1,
    pieceChanged: piece2 !== before1,
    pieceLocked2: g.current !== piece2,
    freezeAfterFirst,
    freezeMid,
    freezeAfterSecond: t.freeze,
  };
});
check('phase3: first drop cleared a line', p3.cleared);
check('phase3: a new piece spawned after the clear', p3.pieceChanged);
check('phase3: dash armed by the first clear', p3.freezeAfterFirst > 0, `freeze=${p3.freezeAfterFirst}`);
check('phase3: dash still active mid-dash (precondition)', p3.freezeMid > 0, `freeze=${p3.freezeMid}`);
check('phase3: second piece locked', p3.pieceLocked2);
check(
  'phase3: new lock ends the previous clear dash (freeze === 0)',
  p3.freezeAfterSecond === 0,
  `freeze=${p3.freezeAfterSecond}`,
);

// ---- Phase 4: game over must not render the final piece twice ----
// The locked piece is already part of the stack; the piece/ghost groups must
// be hidden, or the final piece renders a second time (glowing) on the
// game-over screen.
await page.evaluate(() => {
  const g = window.__tetris.game;
  g.gameOver = false;
  g.paused = false;
  for (let y = 0; y < g.board.length; y++) for (let x = 0; x < 10; x++) g.board[y][x] = 'Z';
  for (const [y, x] of [[0, 4], [0, 5], [1, 4], [1, 5]]) g.board[y][x] = null;
  g.current = { type: 'O', rotation: 0, x: 4, y: 0 };
  g.lock = { resets: 0, lastReset: false };
});
await sleep(100);
await key('keydown', ' ');
await key('keyup', ' ');
const go = await page.evaluate(() => ({
  over: window.__tetris.game.gameOver,
  pieceVisible: window.__tetris.renderer.pieceGroup.visible,
  ghostVisible: window.__tetris.renderer.ghostGroup.visible,
}));
check('phase4: lock-out ends the game', go.over);
check(
  'phase4: final piece is not rendered twice on the game-over screen',
  go.pieceVisible === false && go.ghostVisible === false,
  `piece=${go.pieceVisible} ghost=${go.ghostVisible}`,
);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
