// Browser regression: the mirror stage floor.
//
// The floor is a real planar mirror (three.js Reflector): a virtual camera
// re-renders the scene below the floor plane, so the stage (stack, glow bar,
// trails, FX) is doubled in the glass. A planar mirror's virtual image
// projects like a real object at the point mirrored across the plane
// (p' = (x, 2*Y_M - y, z)) — exact for the glow bar (z=0.32), but the
// Reflector's mirror camera carries an up-axis quirk that shifts the z=0
// block mapping ~20-30px lower. So: the bar is checked at its exact
// projected point; block reflections are found by SCANNING a vertical
// window below the projected point in the block's column, diffed against
// the same window in an empty column (same floor depth => same reflected
// background, so the delta isolates the block's own reflection).
//
// Usage: node test/mirror-floor.mjs [url]

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8901/index.html';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(1500);

const results = [];
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
}

// Sample the canvas: point samples (5x5 device-pixel avg) + column scans
// (per-row 5x5 avg over a vertical window). One forced composer.render()
// keeps the backbuffer in sync with the projected camera state.
function sampleCanvas(pointSpecs, scanSpecs) {
  return page.evaluate(({ pts, scans }) => {
    const r = window.__tetris.renderer;
    r.composer.render();
    const c = r.canvas;
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    const avgAt = (px, py, rad) => {
      let R = 0, G = 0, B = 0, n = 0;
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const x = px + dx, y = py + dy;
          if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
          const i = (y * c.width + x) * 4;
          R += img[i]; G += img[i + 1]; B += img[i + 2]; n++;
        }
      }
      return { r: R / n, g: G / n, b: B / n };
    };
    const out = { pts: {}, scans: {} };
    for (const [tag, p] of Object.entries(pts)) {
      const pr = r.projectToPixel(p.x, p.y, p.z);
      out.pts[tag] = { ...avgAt(Math.round(pr.x), Math.round(pr.y), 2), px: pr.x, py: pr.y };
    }
    for (const [tag, sp] of Object.entries(scans)) {
      const pr = r.projectToPixel(sp.x, sp.y, 0);
      const px = Math.round(pr.x);
      const rows = [];
      for (let dy = 0; dy <= sp.scanH; dy++) {
        rows.push(avgAt(px, Math.round(pr.y) + dy, 2));
      }
      out.scans[tag] = { px, py0: pr.y, rows };
    }
    return out;
  }, { pts: pointSpecs, scans: scanSpecs });
}

const lum = (s) => 0.2126 * s.r + 0.7152 * s.g + 0.0722 * s.b;

// ---- 1. Mirror exists and is live ----
const mirrorState = await page.evaluate(() => {
  const m = window.__tetris.renderer.mirror;
  return m ? { isReflector: m.isReflector, visible: m.visible, y: m.position.y } : null;
});
check('mirror floor exists in scene', !!mirrorState && mirrorState.isReflector);
check('mirror floor visible', !!mirrorState && mirrorState.visible);
const YM = mirrorState ? mirrorState.y : -0.53;

// ---- 2. Deterministic stack: known hues at the stage front ----
await page.evaluate(() => {
  const g = window.__tetris.game;
  g.gameOver = false;
  g.paused = false;
  g.level = 1;
  for (let y = 0; y < g.board.length; y++) g.board[y].fill(null);
  // Purple T-block pair at the bottom-left corner, cyan I cell next to it.
  // Bottom visible row is y=21 (TOTAL_ROWS=22, hidden rows 0-1); the blocks
  // sit on rows 19-20 so their reflections land in the visible mirror wedge.
  g.board[20][0] = 'T';
  g.board[19][0] = 'T';
  g.board[20][1] = 'I';
  g.current = { type: 'O', rotation: 0, x: 4, y: 2 };
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
});

const toWorldX = (x) => x - 4.5;
const toWorldY = (y) => 20.5 - y;
const BLOCK_Y = 2 * YM - toWorldY(20); // mirrored bottom-row block center
const SCAN_H = 60; // window height: absorbs the mirror-mapping shift

const res = await sampleCanvas(
  {
    bar: { x: 0, y: 2 * YM - 0.12, z: 0.32 },    // reflected bottom glow bar
    barCtl: { x: 0, y: 2 * YM - 0.57, z: 0.32 }, // same z, 0.45 below the bar: reflects dark frame edge
    boardbase: { x: 0, y: 0.5, z: 0.3 },         // board base (framing check)
  },
  {
    purple: { x: toWorldX(0), y: BLOCK_Y, scanH: SCAN_H },     // T block column
    purpleCtl: { x: toWorldX(8), y: BLOCK_Y, scanH: SCAN_H },  // empty column
    cyan: { x: toWorldX(1), y: BLOCK_Y, scanH: SCAN_H },       // I block column
    cyanCtl: { x: toWorldX(9), y: BLOCK_Y, scanH: SCAN_H },    // empty column
  },
);
const s = res.pts;

// Strongest colored row in a column window vs the same window in an empty column.
function strongest(rows, score) {
  let best = { i: -1, row: null, v: -Infinity };
  rows.forEach((row, i) => {
    const v = score(row);
    if (v > best.v) best = { i, row, v };
  });
  return best;
}
const purp = (r) => Math.min(r.r, r.b) - r.g; // purple: r and b above g
const cyanScore = (r) => Math.min(r.g, r.b) - r.r; // cyan: g and b above r
const pFeat = strongest(res.scans.purple.rows, purp);
const cFeat = strongest(res.scans.cyan.rows, cyanScore);

check('bar reflection brighter than control below it', lum(s.bar) > lum(s.barCtl) + 40,
  `bar ${lum(s.bar).toFixed(0)} vs ctl ${lum(s.barCtl).toFixed(0)}`);
check('bar reflection is cyan-tinted (g,b > r)', s.bar.g > s.bar.r && s.bar.b > s.bar.r,
  `rgb ${s.bar.r.toFixed(0)},${s.bar.g.toFixed(0)},${s.bar.b.toFixed(0)}`);
check('purple block reflection found in its column', pFeat.v > 25,
  `purpleness ${pFeat.v.toFixed(0)} at row ${pFeat.i} (rgb ${pFeat.row ? `${pFeat.row.r.toFixed(0)},${pFeat.row.g.toFixed(0)},${pFeat.row.b.toFixed(0)}` : '-'})`);
check('purple reflection brighter than empty column at same depth',
  pFeat.i >= 0 && lum(pFeat.row) > lum(res.scans.purpleCtl.rows[pFeat.i]) + 15,
  `feat ${pFeat.row ? lum(pFeat.row).toFixed(0) : '-'} vs ctl ${lum(res.scans.purpleCtl.rows[pFeat.i]).toFixed(0)}`);
check('cyan block reflection found in its column', cFeat.v > 25,
  `cyan-ness ${cFeat.v.toFixed(0)} at row ${cFeat.i} (rgb ${cFeat.row ? `${cFeat.row.r.toFixed(0)},${cFeat.row.g.toFixed(0)},${cFeat.row.b.toFixed(0)}` : '-'})`);
check('cyan reflection brighter than empty column at same depth',
  cFeat.i >= 0 && lum(cFeat.row) > lum(res.scans.cyanCtl.rows[cFeat.i]) + 15,
  `feat ${cFeat.row ? lum(cFeat.row).toFixed(0) : '-'} vs ctl ${lum(res.scans.cyanCtl.rows[cFeat.i]).toFixed(0)}`);

// ---- 3. Stage framing: board base sits in the lower screen wedge ----
check('board base projects on-screen', s.boardbase.px > 0 && s.boardbase.py > 0,
  `px ${s.boardbase.px.toFixed(0)}, py ${s.boardbase.py.toFixed(0)}`);
check('board base in lower half of screen', s.boardbase.py > 840 * 0.5,
  `py ${s.boardbase.py.toFixed(0)} / 840`);
check('reflection region below board base', s.bar.py > s.boardbase.py,
  `bar py ${s.bar.py.toFixed(0)} vs base py ${s.boardbase.py.toFixed(0)}`);

// ---- 4. Gameplay still runs with the mirror pass active ----
const before = await page.evaluate(() => {
  const g = window.__tetris.game;
  g.current.__tag = (window.__tagSeq = (window.__tagSeq || 0) + 1);
  return g.current.__tag;
});
await page.keyboard.press(' ');
await page.waitForTimeout(700);
const locked = await page.evaluate((b) => window.__tetris.game.current.__tag !== b, before);
check('hard drop still locks with mirror active', locked);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);