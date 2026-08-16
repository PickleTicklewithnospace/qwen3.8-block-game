// Browser regression: crystal image-based lighting (IBL) + key-light sparkle.
//
// The crystal blocks are lit two ways beyond their self-emission:
//   - IBL: a procedural studio environment (a few asymmetric softboxes) baked
//     to a PMREM texture and set as scene.environment, so the PBR blocks (and
//     the frosted panel) pick up soft, orientation-dependent reflections.
//   - key-light sparkle: a crisp near-white specular injected into the crystal
//     shader (same onBeforeCompile as the fresnel rim) that highlights each
//     gem facet facing the (camera-space) front studio light, so a full stack
//     of blocks reads as light-catching gemstones and the sparkle sweeps the
//     facets as a piece rotates.
//
// The sparkle is the visible, per-facet "gem catch-light." It is verified by
// an A/B toggle: the per-material uSpecStrength uniform is stashed on
// material.userData.specUniform, so the test zeros it (sparkle OFF), renders,
// and compares to sparkle ON. The delta isolates the sparkle exactly:
//   - a lone stack block shows a localized bright highlight (peak Δ + a few
//     hot pixels),
//   - an empty region (piece hidden in the hidden rows, no blocks) shows
//     ~no delta, proving the sparkle lights BLOCKS, not the sky/panel,
//   - the block's highlight dominates the empty control (localization).
// The PMREM environment's presence is asserted directly (scene.environment +
// envMap set), and the added lighting must not blow the grade: a dense,
// realistic stack keeps %white < 3%.
//
// Expected geometry is computed in-page from the engine's board with the same
// board->world math as src/coords.js, so a wrong block position can't match.
//
// Usage: node test/crystal-ibl.mjs [url]

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred, timeoutMs = 8000, pollMs = 50) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred)) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

// Board->world math (independent copy, same as src/coords.js).
const toWorldX = (x) => x - 4.5;
const toWorldY = (y) => 22 - 1 - y + 0.5;

// Paused, deterministic setup. `cells` = [y,x,type]; `piece` is the active
// piece {type,rotation,x,y}. With piece.y in a hidden row the piece is not
// rendered (used for clean "no block" controls).
async function setup(cells, piece) {
  return page.evaluate(({ cells, piece }) => {
    const g = window.__tetris.game;
    g.gameOver = false;
    g.paused = true;
    g.level = 1;
    for (let y = 0; y < g.board.length; y++) g.board[y].fill(null);
    for (const [y, x, t] of cells || []) g.board[y][x] = t;
    g.current = piece;
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
    window.__tetris.renderer.setStack(g.board);
  }, { cells, piece });
}

// A/B the key-light sparkle (ON vs OFF) over a window centered on the
// projected world point (wx,wy). Returns peak Δ luminance, and counts of
// pixels whose Δ exceeds 6 / 12 (the visible glint area).
async function abSparkle(wx, wy, rad) {
  return page.evaluate(([wx, wy, rad]) => {
    const r = window.__tetris.renderer;
    const c = r.canvas;
    const off = document.createElement('canvas');
    off.width = c.width;
    off.height = c.height;
    const ctx = off.getContext('2d');
    const read = () => {
      r.composer.render();
      ctx.drawImage(c, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    };
    const lum = (img, X, Y) => {
      const i = (Y * c.width + X) * 4;
      return 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
    };
    const mats = [...Object.values(r.pieceMats), ...Object.values(r.stackMats)];
    const saved = mats.map((m) => (m.userData.specUniform ? m.userData.specUniform.value : null));
    mats.forEach((m) => { if (m.userData.specUniform) m.userData.specUniform.value = 0; });
    const imgOff = read();
    mats.forEach((m, i) => { if (m.userData.specUniform) m.userData.specUniform.value = saved[i]; });
    const imgOn = read();
    const p = r.projectToPixel(wx, wy, 0.47);
    const px = Math.round(p.x);
    const py = Math.round(p.y);
    let peak = 0, c6 = 0, c12 = 0;
    for (let y = -rad; y <= rad; y++) {
      for (let x = -rad; x <= rad; x++) {
        const X = px + x, Y = py + y;
        if (X < 0 || Y < 0 || X >= c.width || Y >= c.height) continue;
        const d = lum(imgOn, X, Y) - lum(imgOff, X, Y);
        if (d > peak) peak = d;
        if (d > 6) c6++;
        if (d > 12) c12++;
      }
    }
    return { peak, c6, c12 };
  }, [wx, wy, rad]);
}

// %white over the presented frame (the grade metric used by frame-stats).
async function whitePct() {
  return page.evaluate(() => {
    const r = window.__tetris.renderer;
    r.composer.render();
    const c = r.canvas;
    const off = document.createElement('canvas');
    off.width = c.width;
    off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let white = 0;
    const tot = d.length / 4;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) white++;
    return (100 * white) / tot;
  });
}

// ---- 1. Environment + sparkle are installed ----
// A visible T piece so its (and a matching stack cell's) material compiles
// and exposes userData.specUniform.
await setup([[21, 4, 'T']], { type: 'T', rotation: 0, x: 4, y: 6 });
await waitUntil(() => window.__tetris.renderer.pieceGroup.visible === true, 5000);
await sleep(400); // let the piece (and its material) compile
const install = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  return {
    sceneEnv: !!r.scene.environment,
    envMap: !!r.envMap,
    pieceSpec: r.pieceMats['T'] && r.pieceMats['T'].userData.specUniform ? r.pieceMats['T'].userData.specUniform.value : -1,
    stackSpec: r.stackMats['T'] && r.stackMats['T'].userData.specUniform ? r.stackMats['T'].userData.specUniform.value : -1,
    panelEnv: r.frame ? r.frame.children.some((c) => c.material && c.material.envMapIntensity > 0) : false,
  };
});
check('IBL environment is baked into the scene', install.sceneEnv && install.envMap);
check('crystal pieces carry the key-light sparkle uniform', install.pieceSpec > 0, `pieceSpec=${install.pieceSpec}`);
check('crystal stack blocks carry the sparkle uniform', install.stackSpec > 0, `stackSpec=${install.stackSpec}`);
check('hero piece sparkles harder than the settled stack', install.pieceSpec > install.stackSpec,
  `piece ${install.pieceSpec} > stack ${install.stackSpec}`);

// ---- 2. Control: sparkle lights BLOCKS, not empty space ----
// Empty board + piece hidden in the hidden rows => no crystal block on screen.
const hiddenPiece = { type: 'T', rotation: 0, x: 4, y: 0 };
await setup([], hiddenPiece);
const settledCtl = await waitUntil(() => window.__tetris.renderer.pieceGroup.visible === false, 5000);
check('hidden-row piece is not rendered (clean control)', settledCtl !== null);
await sleep(300);
const ctl = await abSparkle(toWorldX(0), toWorldY(2), 14); // upper board area, no blocks
check('empty space shows no sparkle (control near-zero)', ctl.peak < 5, `control peak ${ctl.peak.toFixed(1)}`);

// ---- 3. A lone stack block shows a visible, localized gem highlight ----
await setup([[21, 4, 'T']], hiddenPiece);
await sleep(300);
const blk = await abSparkle(toWorldX(4), toWorldY(21), 18);
check('stack block catches a visible key-light highlight', blk.peak > 12, `peak ΔL ${blk.peak.toFixed(0)}`);
check('highlight is a localized glint (hot pixels present)', blk.c12 >= 2, `${blk.c12} px > +12, ${blk.c6} px > +6`);
check('block highlight dominates the empty-space control', blk.peak > ctl.peak + 8,
  `block ${blk.peak.toFixed(0)} vs control ${ctl.peak.toFixed(0)}`);

// ---- 4. Grade: a dense, realistic stack stays under the white clip ----
// Bottom ~10 rows filled (~2/3 density): a busy-but-playable board (real
// Tetris clears lines, so a fully-packed 200-cell board is not a real state;
// this matches the frame-stats 14-drop stack the grade is tuned against).
const cells = [];
const types = ['I', 'J', 'L', 'S', 'T', 'Z', 'O'];
for (let y = 12; y <= 21; y++) for (let x = 0; x < 10; x++) if ((x + y) % 3 !== 0) cells.push([y, x, types[(x + y) % 7]]);
await setup(cells, hiddenPiece);
await sleep(400);
const wp = await whitePct();
check('dense stack keeps the white-clip grade under 3%', wp < 3, `white ${wp.toFixed(2)}%`);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);