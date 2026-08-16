// Browser regression: the lock-impact FX (mirror-floor light splash + ring +
// spark puff).
//
// Every lock spawns ONE pooled splash on the mirror floor under the lock
// point (a soft radial light disc + thin ring, tinted by the piece; hard
// drops are stronger and wider). A lock whose cells were all destroyed by a
// clear spawns NO splash.
//
// The splash is verified at the PIXEL level with a TEMPORAL diff: a luminance
// grid on the floor under the lock point is captured before the drop
// (baseline: floor + aurora reflection + glow-bar bleed) and again while the
// splash is mid-expansion; the diff isolates what the drop added. Columns
// |dx| < 42 px around the center are excluded because the hard-drop TRAIL
// reflection also lands there (it belongs to a different FX). The floor is
// in the near field (~2x the board's px/unit), so the splash covers a wide
// screen area and the grid spans +/-160 px.
//
// Expected geometry is computed in-page from the ENGINE's post-lock board
// state (scan for the locked piece type), so a wrong anchor can't match
// itself. The S-with-partial-clear case pins that the splash uses
// POST-CLEAR cells: the pre-clear centroid would be 0.5 world units off.
//
// Usage: node test/lock-impact.mjs [url]

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
async function waitUntil(pred, arg, timeoutMs = 8000, pollMs = 25) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred, arg)) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

// Fresh game with an empty board (or the given pre-filled cells) and a piece
// placed exactly where we want it. Returns a tag on the placed piece.
async function setup(spec) {
  return page.evaluate((s) => {
    const g = window.__tetris.game;
    g.gameOver = false;
    g.paused = false;
    g.level = s.level || 1;
    for (let y = 0; y < g.board.length; y++) g.board[y].fill(null);
    for (const [y, x, t] of s.cells || []) g.board[y][x] = t;
    g.current = { type: s.type, rotation: s.rotation || 0, x: s.x, y: s.y };
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

// Active splashes as world-space geometry (renderer state).
function activeImpacts() {
  return page.evaluate(() =>
    window.__tetris.renderer.impacts
      .filter((im) => im.t < 1)
      .map((im) => ({ wx: im.disc.position.x, y: im.disc.position.y, s: im.s, k: im.k })),
  );
}

// Expected impact anchor, computed from the ENGINE's post-lock board state:
// centroid x (world units) + lowest row of the cells of piece type `type`.
function expectedAnchor(type) {
  return page.evaluate((t) => {
    const g = window.__tetris.game;
    const cols = g.board[0].length;
    let sx = 0, n = 0, row = -Infinity;
    for (let y = 0; y < g.board.length; y++) {
      for (let x = 0; x < cols; x++) {
        if (g.board[y][x] !== t) continue;
        sx += x; n++;
        if (y > row) row = y;
      }
    }
    if (n === 0) return null;
    return { wx: sx / n - (cols - 1) / 2, row, n };
  }, type);
}

// Luminance grid on the floor below the lock point: rows dy=2..40 px below
// the projected splash center (downward: above the center sits the glow bar
// and board base), columns dx=-160..160 px. Forced composer.render keeps the
// backbuffer in sync with the projected camera state.
function captureFloorGrid(wx) {
  return page.evaluate((specWx) => {
    const r = window.__tetris.renderer;
    const floorY = r.impactFloorY ?? -0.505;
    r.composer.render();
    const c = r.canvas;
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    const lum = (x, y) => {
      if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
      const i = (y * c.width + x) * 4;
      return 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
    };
    const avg = (x, y) => {
      let L = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const v = lum(x + dx, y + dy);
          if (v !== null) { L += v; n++; }
        }
      return n ? L / n : null;
    };
    const pr = r.projectToPixel(specWx, floorY, 0.15);
    const px0 = Math.round(pr.x), py0 = Math.round(pr.y);
    const grid = [];
    for (let dy = 2; dy <= 40; dy += 2) {
      const row = [];
      for (let dx = -160; dx <= 160; dx += 4) row.push({ dx, v: avg(px0 + dx, py0 + dy) });
      grid.push(row);
    }
    return { px0, py0, grid };
  }, wx);
}

// Max (post - baseline) over the grid, excluding |dx| < 42 px (the hard-drop
// trail reflection lives in the center column; the splash spans the rest).
function gridDiff(base, post) {
  let best = { v: -Infinity, dx: 0, dy: 0 };
  for (let i = 0; i < post.grid.length; i++) {
    const dy = 2 + i * 2;
    for (const cell of post.grid[i]) {
      if (Math.abs(cell.dx) < 42) continue;
      const b = base.grid[i].find((c) => c.dx === cell.dx);
      if (b.v === null || cell.v === null) continue;
      const d = cell.v - b.v;
      if (d > best.v) best = { v: d, dx: cell.dx, dy };
    }
  }
  return best;
}

// ---- 1. Hard drop: splash at the lock centroid, bright on the floor ----
// T at x=3 locks into cells 3,4,4,5 (centroid x 4 -> world -0.5).
const PRE_WX = -0.5;
await setup({ type: 'T', rotation: 0, x: 3, y: 4, level: 1 });
const base1 = await captureFloorGrid(PRE_WX); // baseline BEFORE the drop

await page.keyboard.press(' ');

// Spark puff at the base of the locked piece (renderer particle state).
const sparks = await waitUntil(
  () => {
    const g = window.__tetris.game;
    const r = window.__tetris.renderer;
    let sx = 0, n = 0, row = -Infinity;
    for (let y = 0; y < g.board.length; y++)
      for (let x = 0; x < g.board[0].length; x++)
        if (g.board[y][x] === 'T') { sx += x; n++; if (y > row) row = y; }
    if (n === 0) return false;
    const wx = sx / n - (g.board[0].length - 1) / 2;
    const wy = g.board.length - 1 - row + 0.5; // toWorldY(row)
    for (let i = 0; i < r.pCount; i++) {
      if (r.pLife[i] <= 0 || r.pPos[i * 3 + 1] < -100) continue;
      if (Math.abs(r.pPos[i * 3] - wx) < 3 && Math.abs(r.pPos[i * 3 + 1] - wy) < 3) return true;
    }
    return false;
  },
  null,
  10000,
);
check('hard drop spawns a spark puff at the base of the lock', sparks !== null, `${sparks}ms`);

const locked1 = await expectedAnchor('T');
check('expected anchor found (post-lock engine state)', !!locked1 && locked1.n === 4,
  locked1 ? `wx ${locked1.wx}, row ${locked1.row}` : 'none');
const imp1 = await activeImpacts();
check('exactly one splash active after hard drop', imp1.length === 1, `${imp1.length} active`);
if (locked1 && imp1.length === 1) {
  check('splash centered on the lock centroid x', Math.abs(imp1[0].wx - locked1.wx) < 1e-6,
    `got ${imp1[0].wx}, want ${locked1.wx}`);
  check('hard drop splash is strong (s > 1, k > 1)', imp1[0].s > 1 && imp1[0].k > 1,
    `s ${imp1[0].s}, k ${imp1[0].k}`);
}

// Pixel proof: catch the splash while it is on the floor, then diff against
// the pre-drop baseline.
const splashWindow = await waitUntil(
  () => window.__tetris.renderer.impacts.some((im) => im.t > 0.2 && im.t < 0.65),
  null,
  10000,
);
check('splash caught mid-expansion on the floor', splashWindow !== null, `${splashWindow}ms`);
if (splashWindow !== null) {
  const post1 = await captureFloorGrid(PRE_WX);
  const diff1 = gridDiff(base1, post1);
  check('splash region on the floor is brighter than the pre-drop baseline',
    diff1.v > 20, `+${diff1.v.toFixed(0)} lum at dx ${diff1.dx}, dy ${diff1.dy}`);
}

// ---- 2. Splash fades out and hides ----
const faded = await waitUntil(
  () => window.__tetris.renderer.impacts.every((im) => im.t >= 1),
  null,
  30000,
);
check('splash fades out', faded !== null, `${faded}ms`);
const hidden = await page.evaluate(() =>
  window.__tetris.renderer.impacts.every((im) => !im.disc.visible && !im.ring.visible),
);
check('faded splash is hidden', hidden);

// ---- 3. Natural lock (gravity + lock delay): softer splash ----
// y=20 puts the O on the floor (bottom row 21 = TOTAL_ROWS-1).
const tag3 = await setup({ type: 'O', rotation: 0, x: 7, y: 20, level: 1 });
const locked3 = await waitUntil(
  (tg) => window.__tetris.game.current.__tag !== tg,
  tag3,
  20000,
);
check('grounded piece locks naturally', locked3 !== null, `${locked3}ms`);
const exp3 = await expectedAnchor('O');
const imp3 = await activeImpacts();
check('natural lock spawns exactly one splash', exp3 ? imp3.length === 1 : false, `${imp3.length} active`);
if (exp3 && imp3.length === 1) {
  check('natural-lock splash at its centroid', Math.abs(imp3[0].wx - exp3.wx) < 1e-6,
    `got ${imp3[0].wx}, want ${exp3.wx}`);
  check('natural lock is a soft splash (s <= 1)', imp3[0].s <= 1.0, `s ${imp3[0].s}`);
}
const faded3 = await waitUntil(
  () => window.__tetris.renderer.impacts.every((im) => im.t >= 1),
  null,
  30000,
);
check('case-3 splash faded before the next case', faded3 !== null, `${faded3}ms`);

// ---- 4. Partial clear: splash anchored on POST-CLEAR cells ----
// Row 20 full except cols 3,4; row 19 full except cols 0,3. An S at x=3
// (top row cols 4,5) cannot reach y=20 because its top-right cell (5, y)
// would collide with the row-20 col-5 filler, so it rests at y=19: bottom
// cells (3,20),(4,20) complete row 20 -> it clears; the S cells in row 19
// shift down to row 20. Pre-clear centroid x = 4 (wx -0.5); post-clear
// centroid x = 4.5 (wx 0) — only the post-clear anchor can pass.
const fill4 = [];
for (const x of [0, 1, 2, 5, 6, 7, 8, 9]) fill4.push([20, x, 'T']);
for (const x of [1, 2, 6, 7, 8, 9]) fill4.push([19, x, 'T']);
await setup({ type: 'S', rotation: 0, x: 3, y: 2, level: 1, cells: fill4 });
await page.keyboard.press(' ');
const rip4 = await waitUntil(
  () => window.__tetris.renderer.impacts.some((im) => im.t < 1),
  null,
  10000,
);
check('partial-clear lock spawns a splash', rip4 !== null, `${rip4}ms`);
const exp4 = await expectedAnchor('S');
check('partial clear: row 20 cleared, S top cells shifted onto it',
  !!exp4 && exp4.row === 20 && exp4.n === 2,
  exp4 ? `wx ${exp4.wx}, row ${exp4.row}, n ${exp4.n}` : 'none');
const imp4 = await activeImpacts();
check('partial-clear lock spawns exactly one splash', exp4 ? imp4.length === 1 : false, `${imp4.length} active`);
if (exp4 && imp4.length === 1) {
  check('splash anchored on POST-CLEAR centroid (not pre-clear)', Math.abs(imp4[0].wx - exp4.wx) < 1e-6,
    `got ${imp4[0].wx}, want ${exp4.wx} (pre-clear would be ${exp4.wx - 0.5})`);
}
const faded4 = await waitUntil(
  () => window.__tetris.renderer.impacts.every((im) => im.t >= 1),
  null,
  30000,
);
check('case-4 splash faded before the next case', faded4 !== null, `${faded4}ms`);

// ---- 5. Full clear: all locked cells destroyed -> no LOCK splash --------
// Prior splashes must be fully faded first, so any splash active at check
// time was necessarily spawned by this lock. The floor is row 21
// (TOTAL_ROWS-1), so both rows 20 and 21 are filled except the O gap.
// Since the perfect-clear feature, this very lock (it empties the well)
// ALSO fires the perfect celebration: the two gold sonic rings (k 2.2)
// share this pool. The check is that no LOCK splash (onLock) spawned —
// every active entry must be a perfect ring.
const fill5 = [];
for (const x of [0, 1, 2, 5, 6, 7, 8, 9]) fill5.push([21, x, 'T']);
for (const x of [0, 1, 2, 5, 6, 7, 8, 9]) fill5.push([20, x, 'T']);
const tag5 = await setup({ type: 'O', rotation: 0, x: 3, y: 3, level: 1, cells: fill5 });
await page.keyboard.press(' ');
const locked5 = await waitUntil(
  (tg) => window.__tetris.game.current.__tag !== tg,
  tag5,
  10000,
);
check('full-clear lock happened', locked5 !== null, `${locked5}ms`);
const st5 = await page.evaluate(() => ({
  clearRows: window.__tetris.game.clearRows.length,
  boardEmpty: window.__tetris.game.board.every((row) => row.every((c) => c === null)),
  ks: window.__tetris.renderer.impacts.filter((im) => im.t < 1).map((im) => im.k),
}));
check('both rows cleared and the board is empty (test precondition)',
  st5.clearRows === 2 && st5.boardEmpty === true,
  `clearRows ${st5.clearRows} empty=${st5.boardEmpty}`);
check('full-clear lock spawns no LOCK splash (only the two perfect-clear rings, k 2.2)',
  st5.ks.length === 2 && st5.ks.every((k) => Math.abs(k - 2.2) < 1e-9),
  JSON.stringify(st5.ks));

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);