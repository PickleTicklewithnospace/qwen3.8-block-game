// Browser regression: the hard-drop light trail.
//
// A hard drop must spawn ONE light streak per occupied column, spanning the
// piece's swept fall (start row -> landing row, inclusive), then fade out.
// A natural lock (gravity + lock delay) and a grounded hard drop (d = 0)
// must spawn NO trail.
//
// Expected geometry is computed in-page from the piece state + ghostY using
// the same board->world math as src/coords.js (independent of the
// renderer's trail code, so a wrong span/column can't match itself).
//
// Usage: node test/harddrop-trail.mjs [url]

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

// Fresh game with an empty board and a piece placed exactly where we want it.
// Returns a tag identifying the placed piece (the engine replaces
// game.current on every spawn).
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

const H = await page.evaluate(() => window.__tetris.game.board.length);
const FLOOR = H - 1;

// Active trails as world-space geometry (independent of renderer internals).
function activeTrails() {
  return page.evaluate(() =>
    window.__tetris.renderer.trails
      .filter((t) => t.t < 1)
      .map((t) => ({
        wx: t.mesh.position.x,
        cy: t.mesh.position.y,
        len: t.mesh.scale.y,
      })),
  );
}

// Expected per-column swept spans for the current piece, computed from the
// piece state + ghostY (the hard-drop landing) with board->world math.
function expectedSpans() {
  return page.evaluate(() => {
    const g = window.__tetris.game;
    const { getCells, ghostY } = window.__tetris;
    const p = g.current;
    const cols = g.board[0].length;
    const wy = (y) => g.board.length - 1 - y + 0.5; // toWorldY
    const d = ghostY(g) - p.y;
    const fromX = new Map();
    const toX = new Map();
    for (const [r, c] of getCells(p.type, p.rotation)) {
      const x = p.x + c;
      const fy = p.y + r;
      const ty = fy + d;
      const f = fromX.get(x) ?? [Infinity, -Infinity];
      f[0] = Math.min(f[0], fy);
      f[1] = Math.max(f[1], fy);
      fromX.set(x, f);
      const t = toX.get(x) ?? [Infinity, -Infinity];
      t[0] = Math.min(t[0], ty);
      t[1] = Math.max(t[1], ty);
      toX.set(x, t);
    }
    const spans = [];
    for (const [x, f] of fromX) {
      const t = toX.get(x);
      if (!t) continue;
      if (t[0] - f[0] <= 0) continue;
      let wyTop = wy(f[0]) + 0.5;
      const wyBottom = wy(t[1]) - 0.5;
      wyTop = Math.min(wyTop, wy(0) + 0.5); // visible-field clamp
      if (wyTop <= wyBottom) continue;
      spans.push({
        wx: x - (cols - 1) / 2,
        cy: (wyTop + wyBottom) / 2,
        len: wyTop - wyBottom,
      });
    }
    return { d, spans: spans.sort((a, b) => a.wx - b.wx) };
  });
}

// ---- 1. Hard drop: one trail per column, correct span ----
await setup({ type: 'T', rotation: 0, x: 3, y: 5, level: 1 });
const pre = await expectedSpans();
check('test piece actually falls (d > 0)', pre.d > 0, `d=${pre.d}`);
check('expected spans computed', pre.spans.length === 3, `${pre.spans.length} columns`);
await page.keyboard.press(' ');
const trails = await activeTrails();
check(
  'one trail per occupied column',
  trails.length === pre.spans.length,
  `${trails.length} vs ${pre.spans.length}`,
);
for (const e of pre.spans) {
  const m = trails.find((t) => Math.abs(t.wx - e.wx) < 1e-6);
  check(`trail in column wx=${e.wx}`, !!m);
  if (m) {
    check(`  length ${e.len}`, Math.abs(m.len - e.len) < 0.01, `got ${m.len}`);
    check(`  center y ${e.cy}`, Math.abs(m.cy - e.cy) < 0.01, `got ${m.cy}`);
  }
}

// ---- 2. Trails fade out and hide ----
const faded = await waitUntil(
  () => window.__tetris.renderer.trails.every((t) => t.t >= 1),
  null,
  10000,
);
check('trails fade out and hide', faded !== null, `${faded}ms`);
const hidden = await page.evaluate(() =>
  window.__tetris.renderer.trails.every((t) => !t.mesh.visible),
);
check('faded trails are hidden', hidden);

// ---- 3. Natural lock (gravity + lock delay, no hard drop): no trail ----
const tag3 = await setup({ type: 'O', rotation: 0, x: 4, y: FLOOR - 1, level: 1 });
const locked3 = await waitUntil(
  (tg) => window.__tetris.game.current.__tag !== tg,
  tag3,
  8000,
);
check('grounded piece locks naturally', locked3 !== null, `${locked3}ms`);
const none3 = await page.evaluate(() =>
  window.__tetris.renderer.trails.every((t) => t.t >= 1 || !t.mesh.visible),
);
check('natural lock spawns no trail', none3);

// ---- 4. Grounded hard drop (d = 0): no trail ----
await setup({ type: 'O', rotation: 0, x: 4, y: FLOOR - 1, level: 1 });
await page.keyboard.press(' ');
const none4 = await page.evaluate(() =>
  window.__tetris.renderer.trails.every((t) => t.t >= 1),
);
check('grounded hard drop (d=0) spawns no trail', none4);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
