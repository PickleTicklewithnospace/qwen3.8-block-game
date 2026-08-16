// Browser regression: lock delay, sliding under an overhang, held-key
// behaviour and soft-drop speed in the REAL running game.
//
// The bugs guarded here:
//   - the lock timer advanced by one gravity interval per gravity tick, so at
//     level 1 a grounded piece locked the instant gravity noticed it was
//     grounded: no lock delay, no sliding under overhangs, and every
//     move/rotation "reset" was a no-op;
//   - holding Down ran the soft-drop repeat AND accelerated gravity, so the
//     piece fell at ~1.6x the soft-drop rate;
//   - releasing one arrow key while the other was still held stopped all
//     horizontal movement until the player let go and pressed again.
//
// All waits are deadline-based polling (headless SwiftShader frames are slow
// and variable).
//
// Usage: node test/lock-delay.mjs [url]

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
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function key(type, k) {
  return page.evaluate(([t, k]) => {
    window.dispatchEvent(new KeyboardEvent(t, { key: k }));
  }, [type, k]);
}
async function waitUntil(pred, arg, timeoutMs = 8000, pollMs = 25) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred, arg)) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

// Fresh game with an empty board and a piece placed exactly where we want it.
// Returns a tag identifying the placed piece, so "did it lock yet?" is exact
// (the engine replaces game.current on every spawn).
async function setup(spec) {
  return page.evaluate((s) => {
    const g = window.__tetris.game;
    g.gameOver = false;
    g.paused = false;
    g.level = s.level || 1;
    for (let y = 0; y < g.board.length; y++) g.board[y].fill(null);
    for (const [y, x, t] of s.cells || []) g.board[y][x] = t;
    g.current = { type: s.type, rotation: 0, x: s.x, y: s.y };
    g.lock = { resets: 0, lastReset: false };
    const t = window.__tetris.timing;
    t.lockTimer = null;
    t.gravityAccum = 0;
    t.softAccum = 0;
    t.das = 0;
    t.arr = 0;
    t.freeze = 0;
    window.__tetris.dirInput.held.length = 0;
    window.__tetris.dirInput.dir = 0;
    window.__tagSeq = (window.__tagSeq || 0) + 1;
    g.current.__tag = window.__tagSeq;
    return window.__tagSeq;
  }, spec);
}

// Board geometry shared by the tests: the piece lands on the bottom row.
const H = await page.evaluate(() => window.__tetris.game.board.length);
const FLOOR = H - 1;

// ---- 1. A grounded piece gets a real lock delay at level 1 ----
// O piece resting on the floor: it must survive ~500ms, not lock instantly.
// The measurement starts the moment the piece is placed (no sleep), so an
// instant lock is distinguishable from a real ~500ms delay.
const tag1 = await setup({ type: 'O', x: 4, y: FLOOR - 1, level: 1 });
const lockedAfter = await waitUntil(
  (tg) => window.__tetris.game.current.__tag !== tg,
  tag1,
  4000,
);
check('grounded piece eventually locks', lockedAfter !== null, `${lockedAfter}ms`);
check(
  'lock delay is real time (~500ms): not instant, not a gravity interval',
  lockedAfter !== null && lockedAfter >= 300 && lockedAfter <= 1100,
  `${lockedAfter}ms`,
);
const settled = await page.evaluate(() => window.__tetris.game.board.flat().filter(Boolean).length);
check('locked piece wrote exactly its 4 cells', settled === 4, `${settled}`);

// ---- 2. Sliding under an overhang ----
// Floor on the left (cols 0-5) and a ceiling three rows up on the right,
// leaving a covered pocket. A piece resting on the left floor must be able to
// slide right, fall into the pocket and lock UNDER the overhang.
const overhang = [];
for (let x = 0; x <= 5; x++) overhang.push([FLOOR, x, 'I']);
for (let x = 6; x < 10; x++) overhang.push([FLOOR - 3, x, 'I']);
await setup({ type: 'O', x: 4, y: FLOOR - 2, cells: overhang, level: 1 });
await sleep(50);
await key('keydown', 'ArrowRight');
const reached = await waitUntil(() => window.__tetris.game.current.x >= 6, null, 4000);
check('piece can slide toward the pocket before locking', reached !== null, `${reached}ms`);
const landed = await waitUntil(
  () => window.__tetris.game.board[window.__tetris.game.board.length - 1].some(
    (c, x) => c === 'O' && x >= 6,
  ),
  null,
  5000,
);
await key('keyup', 'ArrowRight');
check('piece locks inside the covered pocket (slide under works)', landed !== null, `${landed}ms`);
const geom = await page.evaluate((f) => {
  const b = window.__tetris.game.board;
  return {
    ceilingIntact: [6, 7, 8, 9].every((x) => b[f - 3][x] === 'I'),
    inPocket: b[f].filter((c, x) => c === 'O' && x >= 6).length,
    aboveCeiling: b.slice(0, f - 3).flat().filter(Boolean).length,
    gameOver: window.__tetris.game.gameOver,
  };
}, FLOOR);
check('overhang was not overwritten (no clipping)', geom.ceilingIntact);
check('two O cells rest on the pocket floor', geom.inPocket === 2, `${geom.inPocket}`);
check('nothing was written above the overhang', geom.aboveCeiling === 0, `${geom.aboveCeiling}`);
check('game still running', !geom.gameOver);

// ---- 3. Releasing one arrow while the other is held keeps moving ----
await setup({ type: 'O', x: 5, y: 2, level: 1 });
await sleep(50);
await key('keydown', 'ArrowLeft');
await key('keydown', 'ArrowRight');
const wentRight = await waitUntil(() => window.__tetris.game.current.x >= 7, null, 3000);
check('newest direction key wins while both are held', wentRight !== null);
await key('keyup', 'ArrowRight'); // Left is still physically down
const x1 = await page.evaluate(() => window.__tetris.game.current.x);
const fellBack = await waitUntil(
  (x) => window.__tetris.game.current.x <= x - 2,
  x1,
  3000,
);
await key('keyup', 'ArrowLeft');
check('movement falls back to the still-held key', fellBack !== null, `${fellBack}ms`);
const dirCleared = await page.evaluate(() => window.__tetris.dirInput.dir === 0
  && window.__tetris.dirInput.held.length === 0);
check('releasing both keys clears the held set', dirCleared);

// ---- 4. Soft drop runs at the soft-drop rate, not double ----
// Rows fallen must equal the score gained: gravity contributing extra rows
// (the old double-gravity bug) shows up as rows > score.
await setup({ type: 'O', x: 4, y: 0, level: 1 });
await sleep(50);
// Zero the gravity accumulator in the same call that samples the baseline, so
// the natural fall clock starts here (the whole phase runs well inside one
// level-1 gravity interval).
const s0 = await page.evaluate(() => {
  const g = window.__tetris.game;
  window.__tetris.timing.gravityAccum = 0;
  return { y: g.current.y, score: g.score };
});
await key('keydown', 'ArrowDown');
await waitUntil((y) => window.__tetris.game.current.y >= y + 8, s0.y, 4000);
await key('keyup', 'ArrowDown');
const s1 = await page.evaluate(() => {
  const g = window.__tetris.game;
  return { y: g.current.y, score: g.score };
});
const rows = s1.y - s0.y;
const scored = s1.score - s0.score;
check(
  'every soft-dropped row is a scored soft-drop row (no shadow gravity)',
  rows > 0 && scored === rows,
  `rows ${rows}, score ${scored}`,
);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
