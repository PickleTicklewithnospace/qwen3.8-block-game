// Browser regression: the holographic ghost projector.
//
// The ghost piece is a hologram projected from the mirror stage floor:
//   - face: custom holo shader (fresnel silhouette + world-space scanline
//     shimmer + pulse), replacing the old flat 0.1-opacity box fill
//   - pillar: one faint additive light streak from the mirror floor up to
//     the ghost's lowest cell (reuses the hard-drop trail texture),
//     occluded by stack blocks, width 0.34, tracked every frame to the
//     ghost column
//   - emitter: a small pool of light on the mirror glass under the ghost
//     column (reuses the lock-splash texture; the Reflector doubles it)
// The projector follows the ghost's visibility EXACTLY: hidden when the
// landing has no fall (gy == piece.y), when the landing has cells in
// hidden rows, on game over, and on restart.
//
// Pixel verification uses TEMPORAL diffs: the floor and sky are already
// bright/animated, so spatial controls are unreliable; instead a full
// luminance grid is captured with the projector hidden (baseline) and
// again with it shown, and the diff isolates the pillar/emitter. An
// internal control band ABOVE the pillar top (static panel) bounds the
// background drift between the two captures. The scanline shimmer is
// verified as inter-frame pixel variance in the ghost window vs a static
// panel control window.
//
// Expected geometry is computed in-page from the ENGINE state (piece
// position + ghostY) with the same board->world math as src/coords.js, so
// a wrong projector can't match itself.
//
// Usage: node test/ghost-holo.mjs [url]

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
async function waitUntil(pred, arg, timeoutMs = 8000, pollMs = 50) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred, arg)) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

// Board->world math (independent copy, same as src/coords.js).
const toWorldX = (x) => x - 4.5;
const toWorldY = (y) => 22 - 1 - y + 0.5;

// Paused setup: clear the board (or fill the given cells), install a fresh
// piece exactly where we want it, freeze all timing. Paused keeps the
// engine static while render() still drives the renderer every frame, so
// pixel captures are deterministic.
async function setup(spec) {
  return page.evaluate((s) => {
    const g = window.__tetris.game;
    g.gameOver = false;
    g.paused = true;
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
  }, spec);
}

// Luminance (byte) grid of the presented frame: forced composer.render()
// keeps the backbuffer in sync with the projected camera state.
async function grab() {
  return page.evaluate(() => {
    const r = window.__tetris.renderer;
    r.composer.render();
    const c = r.canvas;
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    const lum = new Uint8Array(c.width * c.height);
    for (let i = 0, p = 0; i < img.length; i += 4, p++) {
      lum[p] = Math.min(255, (0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2]) | 0);
    }
    return { w: c.width, h: c.height, lum };
  });
}

// Project world points to canvas device pixels (renderer's live camera).
async function project(points) {
  return page.evaluate((pts) =>
    pts.map(([x, y, z]) => {
      const p = window.__tetris.renderer.projectToPixel(x, y, z);
      return { x: p.x, y: p.y };
    }),
  points);
}

function avgWindow(g, px, py, rad) {
  let L = 0, n = 0;
  for (let dy = -rad; dy <= rad; dy++) {
    for (let dx = -rad; dx <= rad; dx++) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
      L += g.lum[y * g.w + x];
      n++;
    }
  }
  return n ? L / n : null;
}

// Renderer projector state (geometry in world units).
function projState() {
  return page.evaluate(() => {
    const r = window.__tetris.renderer;
    const g = window.__tetris.game;
    const gy = window.__tetris.ghostY(g);
    return {
      ghostY: gy,
      pieceY: g.current.y,
      ghostVisible: r.ghostGroup.visible,
      beamVisible: r.ghostBeam.visible,
      emitterVisible: r.ghostEmitter.visible,
      beam: {
        x: r.ghostBeam.position.x,
        cy: r.ghostBeam.position.y,
        len: r.ghostBeam.scale.y,
      },
      emitter: { x: r.ghostEmitter.position.x, y: r.ghostEmitter.position.y },
      ghostIsHolo: !!r.ghostMats['O']?.box?.isShaderMaterial,
    };
  });
}

// ---- 1. Projector hidden while the ghost cannot fall (gy == piece.y) ----
// O on the floor at x=7: the engine reports no fall, main.js hides the
// ghost, and the projector must follow. x=7 (not 3) keeps this baseline's
// floor-block reflections ~200 px away from the emitter grid used in
// section 2, so they can't mask the pool's temporal diff.
await setup({ type: 'O', rotation: 0, x: 7, y: 20, level: 1 });
const settled1 = await waitUntil(
  () => window.__tetris.renderer.ghostGroup.visible === false,
  null,
  5000,
);
const s1 = await projState();
check('ghost hidden when it cannot fall (gy == piece.y)', settled1 !== null && s1.ghostVisible === false,
  `ghostY=${s1.ghostY} pieceY=${s1.pieceY}`);
check('pillar hidden with the ghost', s1.beamVisible === false);
check('emitter pool hidden with the ghost', s1.emitterVisible === false);
const baseA = await grab(); // baseline: projector off, floor + sky only

// ---- 2. Move the piece mid-air: projector appears at the ghost column ----
// O at x=3 -> anchor wx = toWorldX(3) + 0.5 = -1.0; empty board -> ghost at
// the floor (rows 20,21), pillar = floor..ghost base (h = 0.55 world units).
await page.evaluate(() => {
  const g = window.__tetris.game;
  g.current.x = 3;
  g.current.y = 6;
});
const up1 = await waitUntil(
  () => {
    const r = window.__tetris.renderer;
    return r.ghostGroup.visible && r.ghostBeam.visible;
  },
  null,
  8000,
);
const s2 = await projState();
check('projector appears when the ghost can fall', up1 !== null && s2.ghostVisible === true, `${up1}ms`);
check('pillar visible and emitter pool on', s2.beamVisible === true && s2.emitterVisible === true);
const O_WX = toWorldX(3) + 0.5;
check('pillar tracks the ghost column x', s2.beam.x !== null && Math.abs(s2.beam.x - O_WX) < 1e-6,
  `got ${s2.beam.x}, want ${O_WX}`);
check('emitter pool under the ghost column', Math.abs(s2.emitter.x - O_WX) < 1e-6 &&
  Math.abs(s2.emitter.y - (await page.evaluate(() => window.__tetris.renderer.impactFloorY))) < 0.01,
  `x ${s2.emitter.x}, y ${s2.emitter.y}`);
// Pillar spans floorY(-0.5) .. ghostBase(0.0) + 0.05 overlap => h 0.55,
// centered at -0.225. (Expected from the ENGINE: ghost at the floor row.)
check('pillar height = floor..ghost base', Math.abs(s2.beam.len - (toWorldY(21) - 0.5 + 0.05 - -0.5)) < 0.05,
  `len ${s2.beam.len}`);
check('pillar centered on its span', Math.abs(s2.beam.cy - (-0.5 + (s2.beam.len) / 2)) < 0.05,
  `cy ${s2.beam.cy}`);
check('ghost face is the holo shader material', s2.ghostIsHolo === true);
const postA = await grab();

// Pixel proof (temporal diff): the emitter pool on the floor. Grid below
// the emitter's projected point; the |dx| < 14 px center is excluded
// (the pillar's own base stub + its reflection live there and belong to
// the pillar, not the pool).
const [em] = await project([[O_WX, -0.505, 0.15]]);
{
  const px = Math.round(em.x), py = Math.round(em.y);
  let best = { v: -Infinity, dx: 0, dy: 0 };
  for (let dy = 2; dy <= 44; dy += 2) {
    for (let dx = -60; dx <= 60; dx += 4) {
      if (Math.abs(dx) < 14) continue;
      const b = avgWindow(baseA, px + dx, py + dy, 2);
      const a = avgWindow(postA, px + dx, py + dy, 2);
      if (b === null || a === null) continue;
      if (a - b > best.v) best = { v: a - b, dx, dy };
    }
  }
  check('emitter pool brightens the mirror floor (temporal diff)', best.v > 12,
    `+${best.v.toFixed(0)} lum at dx ${best.dx}, dy ${best.dy}`);
}

// ---- 3. Scanline shimmer: the holo face animates, static panel does not ----
// The cinematic grade (its own suite: cinematic-grade.mjs) animates film
// grain on EVERY frame, which would break the "static panel" control, so
// the grade is zeroed for this A/B capture — this suite tests the HOLO
// shader, not the grade.
{
  const gradeOff = () => page.evaluate(() => {
    const u = window.__tetris.renderer.gradePass.uniforms;
    const s = { v: u.uVignette.value, c: u.uChroma.value, g: u.uGrain.value };
    u.uVignette.value = 0; u.uChroma.value = 0; u.uGrain.value = 0;
    return s;
  });
  const gradeOn = (s) => page.evaluate((saved) => {
    const u = window.__tetris.renderer.gradePass.uniforms;
    u.uVignette.value = saved.v; u.uChroma.value = saved.c; u.uGrain.value = saved.g;
  }, s);
  const [gc, cc] = await project([[O_WX, toWorldY(20.5), 0.25], [toWorldX(0.4), toWorldY(20.5), 0.25]]);
  const saved = await gradeOff();
  const f1 = await grab();
  await sleep(350); // ~1-2 SwiftShader frames: scanlines drift, panel stays
  const f2 = await grab();
  await gradeOn(saved);
  const winDiff = (g1, g2, px, py) => {
    let L = 0, n = 0;
    for (let dy = -16; dy <= 16; dy++) {
      for (let dx = -16; dx <= 16; dx++) {
        const x = px + dx, y = py + dy;
        if (x < 0 || y < 0 || x >= g1.w || y >= g1.h) continue;
        const i = y * g1.w + x;
        L += Math.abs(g2.lum[i] - g1.lum[i]);
        n++;
      }
    }
    return n ? L / n : null;
  };
  const ghostD = winDiff(f1, f2, Math.round(gc.x), Math.round(gc.y));
  const ctlD = winDiff(f1, f2, Math.round(cc.x), Math.round(cc.y));
  check('holo ghost face shimmers frame to frame', ghostD !== null && ghostD > 3,
    `mean|Δ| ${ghostD?.toFixed(1)}`);
  check('static panel control does not shimmer', ctlD !== null && ctlD < 3,
    `mean|Δ| ${ctlD?.toFixed(1)}`);
  check('ghost shimmer dominates background drift', ghostD !== null && ctlD !== null &&
    ghostD > 2 * Math.max(1, ctlD), `ghost ${ghostD?.toFixed(1)} vs ctl ${ctlD?.toFixed(1)}`);
}

// ---- 4. Tall pillar through an open column, landing on a stack ----
// Rows 14..21 filled except cols 3,4 (open to the floor). A T at x=3
// (bottom row spans cols 3,4,5) lands on the stack top via col 5: bottom
// row rests at row 13 (cols 3,4 float beside it), ghost base =
// toWorldY(13)-0.5. The pillar (anchor column = col 4, wx -0.5) runs
// floor..ghost base through the OPEN col 4 — visible over the panel.
// Verified SPATIALLY: the same heights in open col 3 (wx -1.5) carry no
// pillar, so the difference isolates it in one frame (immune to capture-
// interval camera drift).
const fillB = [];
for (let y = 14; y <= 21; y++) {
  for (const x of [0, 1, 2, 5, 6, 7, 8, 9]) fillB.push([y, x, 'Z']);
}
await setup({ type: 'T', rotation: 0, x: 3, y: 6, level: 1, cells: fillB });
await waitUntil(
  () => {
    const r = window.__tetris.renderer;
    return r.ghostGroup.visible && r.ghostBeam.visible;
  },
  null,
  8000,
);
const s4 = await projState();
// Engine: col 5 filled from row 14 -> T bottom row rests at row 13.
const T_WX = toWorldX(3) + 1.0; // T anchor: bounding box cols 3..5
const wantLen = toWorldY(13) - 0.5 + 0.05 - -0.5;
check('tall pillar: height = floor..ghost base on stack', Math.abs(s4.beam.len - wantLen) < 0.05,
  `len ${s4.beam.len}, want ${wantLen}`);
check('tall pillar: anchored in the open column x', Math.abs(s4.beam.x - T_WX) < 1e-6,
  `x ${s4.beam.x}, want ${T_WX}`);
check('tall pillar: ghost actually landed on the stack', s4.ghostY === 12, `ghostY=${s4.ghostY}`);
const postB = await grab();

// Pillar column vs empty neighbor column at the same heights (spatial diff).
{ const ys = [];
  for (let y = 1.3; y <= 5.0 + 1e-9; y += 0.6) ys.push(y);
  const feat = await project(ys.map((y) => [T_WX, y, 0.25]));
  const ctl = await project(ys.map((y) => [toWorldX(3), y, 0.25]));
  let above = 0, best = -Infinity;
  for (let i = 0; i < feat.length; i++) {
    const f = avgWindow(postB, Math.round(feat[i].x), Math.round(feat[i].y), 2);
    const c = avgWindow(postB, Math.round(ctl[i].x), Math.round(ctl[i].y), 2);
    if (f === null || c === null) continue;
    const d = f - c;
    if (d > best) best = d;
    if (d > 8) above++;
  }
  // Taper pin: near the pillar top the texture gradient dies out, so the
  // column advantage over its neighbor must have mostly faded.
  const [tf, tc] = await project([[T_WX, 7.6, 0.25], [toWorldX(3), 7.6, 0.25]]);
  const topF = avgWindow(postB, Math.round(tf.x), Math.round(tf.y), 2);
  const topC = avgWindow(postB, Math.round(tc.x), Math.round(tc.y), 2);
  const topD = topF !== null && topC !== null ? topF - topC : null;
  check('pillar brightens the in-field open column vs its empty neighbor',
    above >= 5 && best > 10, `${above}/${ys.length} points above +8, max +${best.toFixed(0)}`);
  check('pillar tapers out toward the ghost base', topD !== null && topD < 12,
    `top diff ${topD?.toFixed(1)}`);
}

// ---- 5. Pillar tracks horizontal piece motion ----
await page.evaluate(() => { window.__tetris.game.current.x = 4; });
const s5 = await waitUntil(
  (wx) => {
    const r = window.__tetris.renderer;
    return r.ghostBeam.visible && Math.abs(r.ghostBeam.position.x - wx) < 1e-6;
  },
  toWorldX(4) + 1.0,
  8000,
);
const s5b = await projState();
check('pillar moves with the piece column', s5 !== null && Math.abs(s5b.beam.x - (toWorldX(4) + 1.0)) < 1e-6,
  `x ${s5b.beam.x}, want ${toWorldX(4) + 1.0}`);
check('emitter pool moves with the piece column', Math.abs(s5b.emitter.x - (toWorldX(4) + 1.0)) < 1e-6,
  `x ${s5b.emitter.x}`);

// ---- 6. Landing in hidden rows: ghost AND projector hidden ----
// Stack filled from row 3 down: the T at y=0 (cells rows 0,1) falls to
// y=1 (cells rows 1,2) — ghostY > piece.y, but row 1 is hidden, so the
// ghost must be hidden by the hidden-row rule (not the no-fall rule) and
// the projector with it.
const fillC = [];
for (let y = 3; y <= 21; y++) for (let x = 0; x < 10; x++) fillC.push([y, x, 'Z']);
await setup({ type: 'T', rotation: 0, x: 3, y: 0, level: 1, cells: fillC });
const s6 = await waitUntil(
  () => {
    const r = window.__tetris.renderer;
    const g = window.__tetris.game;
    const gy = window.__tetris.ghostY(g);
    return gy > g.current.y && !r.ghostGroup.visible;
  },
  null,
  8000,
);
const s6b = await projState();
check('projector hidden when the landing has cells in hidden rows',
  s6 !== null && s6b.ghostVisible === false && s6b.beamVisible === false && s6b.emitterVisible === false,
  `ghostY=${s6b.ghostY} pieceY=${s6b.pieceY} ghost=${s6b.ghostVisible}`);

// ---- 7. Game over clears the projector off the stage ----
await page.evaluate(() => window.__tetris.renderer.onGameOver());
const s7 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  return {
    piece: r.pieceGroup.visible,
    ghost: r.ghostGroup.visible,
    beam: r.ghostBeam.visible,
    emitter: r.ghostEmitter.visible,
  };
});
check('game over hides piece, ghost, pillar and emitter',
  s7.piece === false && s7.ghost === false && s7.beam === false && s7.emitter === false,
  `piece=${s7.piece} ghost=${s7.ghost} beam=${s7.beam} emitter=${s7.emitter}`);

// ---- 8. Restart: a fresh game projects its ghost again ----
await page.keyboard.press('r');
const s8 = await waitUntil(
  () => window.__tetris.renderer.ghostBeam.visible === true,
  null,
  10000,
);
check('projector is live again on a fresh game', s8 !== null, `${s8}ms`);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);