// Browser regression: the level palette — when a lock crosses a level
// threshold the whole stage re-inks to the level's hue (aurora sky via the
// uHue shader uniform, neon frame, glow bar, mirror/panel grid vertex
// colors, sky background), eased over ~1 s, plus a one-shot level-up
// celebration: aurora surge, a wide sonic ring across the mirror glass from
// the board center, and a gold spark fountain off the glow bar.
//
// The hue math is pure (src/fx-labels.js: levelHue) and unit-tested; this
// suite proves the VISUAL side:
//   - level 1 is the neutral stage (state + glow-bar pixel baseline),
//   - a 1->2 level-up (1-line clear crossing the line threshold) fires the
//     surge (auroraPulse spike) and the level ring, proven at pixel level
//     by a synchronous A/B (hide the k=2.2 pool entry, render, restore,
//     render, diff — race-free, unlike temporal diffs),
//   - the stage hue converges to levelHue(2): uHue uniform, frame/glow-bar
//     colors, grid vertex colors, sky background (state) + the glow bar's
//     re-ink proven by a pixel band A/B,
//   - a second level-up (2->3) shifts the palette further,
//   - restart restores the exact neutral stage.
//
// Usage: node test/level-palette.mjs [url]

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
async function waitUntil(pred, arg, timeoutMs = 8000, pollMs = 15) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred, arg)) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

// Fresh game, empty board (plus optional pre-filled cells), piece parked at
// the given position. Returns a tag on the placed piece.
async function setup(spec) {
  return page.evaluate((s) => {
    const g = window.__tetris.game;
    g.gameOver = false;
    g.paused = false;
    g.level = s.level || 1;
    if (s.lines !== undefined) g.lines = s.lines;
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

// Rows `rows` filled in every column except the given gap column(s).
function gapRows(rows, missing = [3, 4]) {
  const cells = [];
  for (const y of rows) for (let x = 0; x < 10; x++) if (!missing.includes(x)) cells.push([y, x, 'T']);
  return cells;
}

// Stage palette state: animated/target hue, shader uniform, frame/glow-bar
// colors, grid vertex colors (first 2 verts each) and the level-1 bases.
const stageState = () =>
  page.evaluate(() => {
    const r = window.__tetris.renderer;
    const c = (m) => ({ r: m.color.r, g: m.color.g, b: m.color.b });
    const first = (g) => Array.from(g.geometry.getAttribute('color').array.slice(0, 6));
    return {
      level: window.__tetris.game.level,
      lines: window.__tetris.game.lines,
      levelHue: r.levelHue,
      levelHueTarget: r.levelHueTarget,
      uHue: r.auroraUniforms.uHue.value,
      edge: c(r.frameEdgesMat),
      rail: c(r.frameRailMat),
      bar: c(r.frameBarMat),
      bg: { r: r.scene.background.r, g: r.scene.background.g, b: r.scene.background.b },
      floorGrid: first(r.floorGrid),
      panelGrid: first(r.panelGrid),
      baseEdge: { r: r.frameEdgeBase.r, g: r.frameEdgeBase.g, b: r.frameEdgeBase.b },
      baseBar: { r: r.frameBarBase.r, g: r.frameBarBase.g, b: r.frameBarBase.b },
      baseBg: { r: r.stageBgBase.r, g: r.stageBgBase.g, b: r.stageBgBase.b },
      baseFloorGrid: Array.from(r.floorGridBase.slice(0, 6)),
    };
  });

const maxColorDelta = (a, b) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));

// Glow-bar pixel band: average RGB over a wide band on the bottom glow bar
// (world y 0.12, z 0.32). The bar is the brightest flat saturated stage
// element, so its re-ink is the most measurable pixel proof of the hue
// shift. Forced composer.render keeps the backbuffer in sync.
function captureBarBand() {
  return page.evaluate(() => {
    const r = window.__tetris.renderer;
    r.composer.render();
    const c = r.canvas;
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    const pr = r.projectToPixel(0, 0.12, 0.32);
    const px0 = Math.round(pr.x), py0 = Math.round(pr.y);
    let R = 0, G = 0, B = 0, n = 0;
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -30; dx <= 30; dx += 2) {
        const x = px0 + dx, y = py0 + dy;
        if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
        const i = (y * c.width + x) * 4;
        R += img[i]; G += img[i + 1]; B += img[i + 2]; n++;
      }
    return n ? { R: R / n, G: G / n, B: B / n, n } : null;
  });
}

// Synchronous A/B proof of the level ring: hide ONLY the k=2.2 pool entry
// (the level-up sonic ring — the lock splash at the piece's centroid is a
// different entry and stays up), render, restore, render, and diff. Two
// back-to-back renders are pixel-identical everywhere except the toggled
// mesh (grain/aurora are time-driven and advance only in tick), so the diff
// in the floor region is the ring's own pixels plus its bloom. The far-sky
// window bounds the residual (grain-free) noise.
function ringAB() {
  return page.evaluate(() => {
    const r = window.__tetris.renderer;
    const lv = r.impacts.find((im) => im.k === 2.2 && im.disc.visible && im.t < 0.85);
    if (!lv) return { found: false };
    const snap = () => {
      r.composer.render();
      const c = r.canvas;
      const off = document.createElement('canvas');
      off.width = c.width; off.height = c.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    };
    const A = snap();
    lv.disc.visible = false;
    lv.ring.visible = false;
    const B = snap();
    lv.disc.visible = true;
    lv.ring.visible = true;
    const c = r.canvas;
    const lum = (img, x, y) => {
      if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
      const i = (y * c.width + x) * 4;
      return 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
    };
    // Floor window around the ring's projected center (board center).
    const pr = r.projectToPixel(0, r.impactFloorY, 0.15);
    const px0 = Math.round(pr.x), py0 = Math.round(pr.y);
    let floorMax = 0, floorMean = 0, floorN = 0;
    for (let dy = -60; dy <= 60; dy += 2)
      for (let dx = -170; dx <= 170; dx += 4) {
        const la = lum(A, px0 + dx, py0 + dy);
        const lb = lum(B, px0 + dx, py0 + dy);
        if (la === null || lb === null) continue;
        const d = Math.abs(la - lb);
        if (d > floorMax) floorMax = d;
        floorMean += d; floorN++;
      }
    // Far-sky control: same A/B over a sky window with no FX.
    const prs = r.projectToPixel(-14, 26, -45);
    const sx0 = Math.round(prs.x), sy0 = Math.round(prs.y);
    let skyMax = 0, skyMean = 0, skyN = 0;
    for (let dy = -20; dy <= 20; dy += 2)
      for (let dx = -40; dx <= 40; dx += 4) {
        const la = lum(A, sx0 + dx, sy0 + dy);
        const lb = lum(B, sx0 + dx, sy0 + dy);
        if (la === null || lb === null) continue;
        const d = Math.abs(la - lb);
        if (d > skyMax) skyMax = d;
        skyMean += d; skyN++;
      }
    return {
      found: true,
      t: lv.t,
      floorMax,
      floorMean: floorN ? floorMean / floorN : 0,
      skyMax,
      skyMean: skyN ? skyMean / skyN : 0,
    };
  });
}

// ---- 1. Level 1 is the neutral stage -------------------------------------
{
  const s0 = await stageState();
  check('level 1: hue offset is neutral', s0.levelHueTarget === 0 && s0.levelHue === 0,
    `target ${s0.levelHueTarget}, current ${s0.levelHue}`);
  check('level 1: aurora uHue uniform is 0', Math.abs(s0.uHue) < 1e-9, `uHue ${s0.uHue}`);
  check('level 1: frame edges at the base cyan', maxColorDelta(s0.edge, s0.baseEdge) < 1e-4,
    `delta ${maxColorDelta(s0.edge, s0.baseEdge).toExponential(2)}`);
  check('level 1: floor grid at its baked base colors', s0.floorGrid.every((v, i) => v === s0.baseFloorGrid[i]));
}
const barL1 = await captureBarBand();
check('glow-bar pixel baseline captured (level 1)', !!barL1 && barL1.n > 50, barL1 ? `n=${barL1.n} R=${barL1.R.toFixed(1)}` : 'none');

// ---- 2. Level-up 1 -> 2: surge + ring + banner ----------------------------
// 9 lines + this 1-line clear crosses the 10-line threshold into level 2.
// The filler keeps the clear from emptying the well (a perfect clear would
// add its own k=2.2 gold rings to the pool this phase's ring A/B hides).
await setup({ type: 'O', rotation: 0, x: 3, y: 2, level: 1, lines: 9, cells: [...gapRows([21]), [10, 0, 'Z']] });
await page.keyboard.press(' ');

const surged = await waitUntil(
  () => window.__tetris.renderer.auroraPulse > 1.9,
  null,
  8000,
);
check('level-up fires the aurora surge (pulse > 1.9)', surged !== null, `${surged}ms`);

const banner = await waitUntil(
  () => window.__tetris.renderer.popups.some((p) => p.tier === 'level' && p.t < 1),
  null,
  5000,
);
check('LEVEL 2 banner shows alongside the palette shift', banner !== null, `${banner}ms`);

// Gold spark fountain: 42 HDR gold-white sparks (pBase R >= 1.4 is unique
// to this spawner — no other FX writes that hot a base).
const sparks = await waitUntil(
  () => {
    const r = window.__tetris.renderer;
    for (let i = 0; i < r.pCount; i++)
      if (r.pLife[i] > 0 && r.pBase[i * 3] >= 1.4) return true;
    return false;
  },
  null,
  8000,
);
check('level-up spawns the gold spark fountain', sparks !== null, `${sparks}ms`);

const locked2 = await waitUntil(
  () => window.__tetris.game.level === 2 && window.__tetris.game.lines === 10,
  null,
  5000,
);
check('crossed into level 2 (lines 9 + 1 clear = 10)', locked2 !== null, `${locked2}ms`);
const s2 = await stageState();
check('level 2: hue target is LEVEL_HUE_STEP', Math.abs(s2.levelHueTarget - 0.055) < 1e-9,
  `target ${s2.levelHueTarget}`);

// Pixel proof of the sonic ring while it is on the glass.
const ring = await (async () => {
  const t0 = Date.now();
  for (;;) {
    const ab = await ringAB();
    if (ab.found) return ab;
    if (Date.now() - t0 > 8000) return null;
    await sleep(15);
  }
})();
check('level ring is on the floor (k=2.2 entry active)', !!ring, ring ? `t=${ring?.t?.toFixed(2)}` : 'not caught');
if (ring) {
  check('level ring is visible on the mirror glass (pixel A/B)', ring.floorMax > 40,
    `floor max ${ring.floorMax.toFixed(1)} / mean ${ring.floorMean.toFixed(1)}`);
  check('...and is the ring, not the sky (far-sky A/B stays flat)', ring.skyMax < 25,
    `sky max ${ring.skyMax.toFixed(1)} / mean ${ring.skyMean.toFixed(2)}`);
  check('ring signal dominates the residual', ring.floorMax > ring.skyMax * 2,
    `floor ${ring.floorMax.toFixed(1)} vs sky ${ring.skyMax.toFixed(1)}`);
}

// ---- 3. The stage re-inks: hue converges to levelHue(2) -------------------
const converged = await waitUntil(
  () => Math.abs(window.__tetris.renderer.levelHue - window.__tetris.renderer.levelHueTarget) < 0.002,
  null,
  15000,
);
check('stage hue eases to the level-2 target', converged !== null, `${converged}ms`);
const s3 = await stageState();
check('aurora uHue holds at 0.055 * 2*pi', Math.abs(s3.uHue - 0.055 * Math.PI * 2) < 0.02,
  `uHue ${s3.uHue.toFixed(4)}`);
const edgeDelta = maxColorDelta(s3.edge, s3.baseEdge);
check('neon frame re-inked (edges moved off the level-1 cyan)', edgeDelta > 0.03, `max dC ${edgeDelta.toFixed(3)}`);
check('floor grid vertex colors re-inked', s3.floorGrid.some((v, i) => Math.abs(v - s3.baseFloorGrid[i]) > 1e-4));
check('sky background re-inked (subtly)', maxColorDelta(s3.bg, s3.baseBg) > 1e-4,
  `max dC ${maxColorDelta(s3.bg, s3.baseBg).toExponential(2)}`);

// Let every transient expire (clear FX, trails, sparks) so the re-inked
// glow bar band is clean. The engine is paused for the settle window:
// an unpaused game keeps shedding stardust from the falling piece on
// every gravity step (src/fall-dust.js), and the all-particles-expired
// condition could never hold.
await page.evaluate(() => {
  window.__tetris.game.paused = true;
});
const settled = await waitUntil(
  () => {
    const r = window.__tetris.renderer;
    if (r.flashes.length > 0) return false;
    for (let i = 0; i < r.pCount; i++) if (r.pLife[i] > 0) return false;
    return r.impacts.every((im) => im.t >= 1);
  },
  null,
  20000,
);
check('transient FX expired (clean stage for the re-ink capture)', settled !== null, `${settled}ms`);
const barL2 = await captureBarBand();
check('glow-bar pixel band captured (level 2)', !!barL2 && barL2.n > 50, barL2 ? `n=${barL2.n} R=${barL2.R.toFixed(1)}` : 'none');
if (barL1 && barL2) {
  const dR = Math.abs(barL2.R - barL1.R);
  const dRB = Math.abs((barL2.R - barL2.B) - (barL1.R - barL1.B));
  check('glow bar re-inked on screen (pixel band A/B)', dR > 10 || dRB > 8,
    `dR ${dR.toFixed(1)}, d(R-B) ${dRB.toFixed(1)}`);
}

// ---- 4. A second level-up shifts the palette further ----------------------
await setup({ type: 'O', rotation: 0, x: 3, y: 2, level: 2, lines: 19, cells: [...gapRows([21]), [10, 0, 'Z']] });
const edgeL2 = (await stageState()).edge;
await page.keyboard.press(' ');
const locked3 = await waitUntil(
  () => window.__tetris.game.level === 3,
  null,
  5000,
);
check('crossed into level 3 (lines 19 + 1 clear = 20)', locked3 !== null, `${locked3}ms`);
const conv3 = await waitUntil(
  () => Math.abs(window.__tetris.renderer.levelHue - window.__tetris.renderer.levelHueTarget) < 0.002,
  null,
  15000,
);
check('stage hue eases to the level-3 target', conv3 !== null, `${conv3}ms`);
const s4 = await stageState();
check('level 3: hue target is 2 * LEVEL_HUE_STEP', Math.abs(s4.levelHueTarget - 0.11) < 1e-9,
  `target ${s4.levelHueTarget}`);
check('level 3 moved the frame further than level 2', maxColorDelta(s4.edge, edgeL2) > 0.02,
  `max dC ${maxColorDelta(s4.edge, edgeL2).toFixed(3)}`);

// ---- 5. Restart restores the exact neutral stage ---------------------------
await page.keyboard.press('r');
const restored = await waitUntil(
  () => {
    const r = window.__tetris.renderer;
    return r.levelHue === 0 && r.levelHueTarget === 0;
  },
  null,
  8000,
);
check('restart: stage hue back to neutral', restored !== null, `${restored}ms`);
const s5 = await stageState();
check('restart: frame edges at the exact level-1 base', maxColorDelta(s5.edge, s5.baseEdge) < 1e-6);
check('restart: glow bar at the exact level-1 base', maxColorDelta(s5.bar, s5.baseBar) < 1e-6);
check('restart: aurora uHue is 0', Math.abs(s5.uHue) < 1e-9, `uHue ${s5.uHue}`);
check('restart: floor grid repainted to its base colors', s5.floorGrid.every((v, i) => v === s5.baseFloorGrid[i]));

// ---- errors ----------------------------------------------------------------
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

for (const r of results) console.log(r);
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${results.length - failed}/${results.length}) level-palette`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);