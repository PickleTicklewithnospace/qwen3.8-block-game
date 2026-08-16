// Browser regression: the game-over "lights out" cinematic.
//
// On game over the stage powers down: a persistent GAME OVER banner pops in
// and breathes (it never fades until reset), the settled stack dissolves
// top-down into slow colored embers (per-particle gravity 2.1 vs the
// line-clear 16, so they sink dreamily), the aurora/stars/neon frame/bloom
// dim over ~2.2 s, and the camera pushes back off stage. setStack is frozen
// while over so dissolved cells are never re-added by the per-frame diff.
//
// Pixel proof: the banner is A/B'd by toggling its mesh visibility between
// two synchronous composer.render() calls (identical uniforms => everything
// else cancels); the aurora dim is a temporal comparison of the same
// projected sky points before vs after the ramp completes (the aurora's
// breathe/drift is slow relative to the 30% curtain cut, so the max over a
// few points tracks the curtain energy).
//
// Usage: node test/gameover-cinematic.mjs [url]

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
async function waitUntil(pred, timeoutMs = 8000, pollMs = 30) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred)) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

// Projected sky sample points ON the aurora plane (z = -45), spread across
// the visible curtain band but well inside the camera frustum (the camera
// tilts only ~9deg down, so high sky points project off the top edge).
// Luminance = (r+g+b)/3 of a 5x5 device-px avg; out-of-canvas projections
// are skipped.
function skyPoints(pts) {
  return page.evaluate((p) => {
    const r = window.__tetris.renderer;
    r.composer.render();
    const c = r.canvas;
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    const avgAt = (px, py, rad) => {
      let s = 0, n = 0;
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const x = px + dx, y = py + dy;
          if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
          const i = (y * c.width + x) * 4;
          s += (img[i] + img[i + 1] + img[i + 2]) / 3;
          n++;
        }
      }
      return n ? s / n : null;
    };
    const out = [];
    for (const [wx, wy] of p) {
      const q = r.projectToPixel(wx, wy, -45);
      const v = avgAt(Math.round(q.x), Math.round(q.y), 2);
      if (v !== null) out.push(v);
    }
    return { valid: out.length >= 3, max: out.length ? Math.max(...out) : NaN };
  }, pts);
}

const SKY = [[-22, 24], [-9, 28], [7, 22], [20, 20], [0, 30]];

// A dense, colorful tower (all 7 hues cycling) filling the visible field,
// rows 0-1 empty so the O locks entirely in the hidden rows -> lock-out.
async function fillTowerAndLock() {
  await page.evaluate(() => {
    const g = window.__tetris.game;
    g.gameOver = false;
    g.paused = false;
    const types = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
    for (let y = 0; y < g.board.length; y++) {
      for (let x = 0; x < 10; x++) g.board[y][x] = y >= 2 ? types[(y + x) % 7] : null;
    }
    g.current = { type: 'O', rotation: 0, x: 4, y: 0 };
    g.lock = { resets: 0, lastReset: false };
    const t = window.__tetris.timing;
    t.lockTimer = null; t.gravityAccum = 0; t.softAccum = 0;
    t.das = 0; t.arr = 0; t.freeze = 0;
  });
  await sleep(120);
  await page.keyboard.down(' ');
  await page.keyboard.up(' ');
}

async function key(k) {
  await page.keyboard.down(k);
  await page.keyboard.up(k);
}

// ---- Phase 1: baseline before game over ----
await key('r');
await sleep(400);
const base = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  return {
    over: r.over,
    overDim: r.overDim,
    z: r.camera.position.z,
    camZ: r.cameraBase.z,
    bloom: r.bloom.strength,
    bloomBase: r.bloomBase,
    edgesOp: r.frameEdgesMat.opacity,
  };
});
const sky0 = await skyPoints(SKY);
check('phase1: idle state is lit (over=false, full lights)',
  base.over === false && base.overDim === 0 && base.edgesOp > 0.99,
  `over=${base.over} overDim=${base.overDim} edges=${base.edgesOp}`);
check('phase1: idle bloom at base strength and camera on base dolly',
  Math.abs(base.bloom - base.bloomBase) < 0.001 && Math.abs(base.z - base.camZ) < 0.01,
  `bloom=${base.bloom} z=${base.z.toFixed(2)}`);

// ---- Phase 2: trigger the lock-out ----
await fillTowerAndLock();
const t0 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  return {
    over: r.over,
    overT: r.overT,
    dissolves: r.dissolves.length,
    meshes: r.stackMeshes.size,
    banner: r.popups.some((p) => p.tier === 'gameover' && p.mesh.visible),
    text: r.popups.find((p) => p.tier === 'gameover')?.text || '',
    starsOp: r.starsNear.material.opacity,
  };
});
check('phase2: lock-out entered game over with the lights-out state',
  t0.over === true && t0.banner && t0.text === 'GAME OVER',
  `over=${t0.over} banner=${t0.banner} text=${t0.text}`);
check('phase2: stack dissolve schedule built (dense tower => many cells)',
  t0.dissolves > 100 && t0.meshes > 100,
  `dissolves=${t0.dissolves} meshes=${t0.meshes}`);
check('phase2: stars already dimmed one tick into the ramp',
  t0.starsOp < 0.85, `stars=${t0.starsOp.toFixed(3)}`);

check('phase2: stars already dimmed one tick into the ramp',
  t0.starsOp <= 0.85, `stars=${t0.starsOp.toFixed(3)}`);

// ---- Phase 3: mid-dissolve: embers, banner pixels, dim ramping ----
// SwiftShader runs tick-time slower than wall time, so poll for a
// comfortably mid-ramp state instead of trusting a fixed sleep.
const midWait = await waitUntil(
  () => {
    const r = window.__tetris.renderer;
    return r.overDim > 0.35 && r.overDim < 1 && r.dissolves.length > 0;
  },
  20000,
);
const mid = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  // A/B the banner: hide it, render, sample; restore, render, sample.
  // Same synchronous evaluate => uniforms frozen => only the banner differs.
  const p = r.popups.find((q) => q.tier === 'gameover' && q.mesh.visible);
  if (!p) return { found: false };
  const q = r.projectToPixel(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z);
  const X = Math.round(q.x), Y = Math.round(q.y);
  const c = r.canvas;
  const off = document.createElement('canvas');
  off.width = c.width; off.height = c.height;
  const ctx = off.getContext('2d');
  const grab = () => { ctx.drawImage(c, 0, 0); return ctx.getImageData(0, 0, c.width, c.height).data; };
  const lum = (img, cx, cy, rad) => {
    let s = 0, n = 0;
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
        const i = (y * c.width + x) * 4;
        s += (img[i] + img[i + 1] + img[i + 2]) / 3;
        n++;
      }
    }
    return s / n;
  };
  r.composer.render();
  const shown = grab();
  p.mesh.visible = false;
  r.composer.render();
  const hidden = grab();
  // Max per-pixel |ΔL| over the banner's full projected band: the curtain
  // behind the banner can be bright in places (a mean diff washes out and
  // clips), but the band is ~450px wide so glyphs over a dark curtain gap
  // guarantee a hot pixel somewhere. A far-corner band bounds the noise.
  const maxDiff = (a, b, x0, y0, x1, y1) => {
    let m = 0;
    for (let y = Math.max(0, y0); y < Math.min(c.height, y1); y += 2) {
      for (let x = Math.max(0, x0); x < Math.min(c.width, x1); x += 2) {
        const i = (y * c.width + x) * 4;
        const la = (a[i] + a[i + 1] + a[i + 2]) / 3;
        const lb = (b[i] + b[i + 1] + b[i + 2]) / 3;
        const d = Math.abs(la - lb);
        if (d > m) m = d;
      }
    }
    return m;
  };
  const dL = maxDiff(shown, hidden, X - 220, Y - 45, X + 220, Y + 45);
  const ctlD = maxDiff(shown, hidden, c.width - 170, 16, c.width - 30, 116);
  p.mesh.visible = true;
  r.composer.render();
  // Slow embers: any live particle with the dissolve gravity (< line-clear 16).
  let slow = 0, live = 0;
  for (let i = 0; i < r.pCount; i++) {
    if (r.pLife[i] > 0.05) { live++; if (r.pGrav[i] < 10) slow++; }
  }
  return {
    found: true,
    dL,
    ctlD,
    op: p.mat.opacity,
    overDim: r.overDim,
    z: r.camera.position.z,
    bloom: r.bloom.strength,
    bloomBase: r.bloomBase,
    meshes: r.stackMeshes.size,
    dissolveLeft: r.dissolves.length,
    slow, live,
    edgesOp: r.frameEdgesMat.opacity,
  };
});
check('phase3: mid-ramp state reached before sampling', midWait !== null, `after ${midWait}ms`);
check('phase3: GAME OVER banner is bright at its projected point (A/B vs hidden)',
  mid.found && mid.dL > 40 && mid.ctlD < 25,
  `bandMax=${mid.dL?.toFixed(1)} ctl=${mid.ctlD?.toFixed(1)}`);
check('phase3: banner holds on screen mid-ramp (persistent, not fading)',
  mid.op > 0.5, `opacity=${mid.op?.toFixed(2)}`);
check('phase3: dim ramp partway and stage already dimmed',
  mid.overDim > 0.3 && mid.edgesOp < 0.95,
  `overDim=${mid.overDim?.toFixed(2)} edges=${mid.edgesOp?.toFixed(2)}`);
check('phase3: camera pushing back off stage, bloom dimmed below base',
  mid.z > 37.2 && mid.bloom < mid.bloomBase,
  `z=${mid.z?.toFixed(2)} bloom=${mid.bloom?.toFixed(2)}/${mid.bloomBase}`);
check('phase3: dissolve is consuming the tower (meshes shrinking, schedule draining)',
  mid.meshes < t0.meshes && mid.dissolveLeft < t0.dissolves,
  `meshes=${mid.meshes}/${t0.meshes} left=${mid.dissolveLeft}`);
check('phase3: slow-sinking embers are live (dissolve gravity < line-clear 16)',
  mid.slow > 5 && mid.slow <= mid.live, `slow=${mid.slow}/${mid.live}`);

// ---- Phase 4: ramp complete: everything out, dissolve finished ----
// Poll both milestones (SwiftShader skews tick-time vs wall-time): the dim
// ramp finishing, then the last dissolved cell leaving the scene.
const dimDone = await waitUntil(
  () => window.__tetris.renderer.overDim >= 1,
  20000,
);
const dissolveDone = await waitUntil(
  () => window.__tetris.renderer.stackMeshes.size === 0 && window.__tetris.renderer.dissolves.length === 0,
  25000,
);
const sky1 = await skyPoints(SKY);
const done = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  return {
    overDim: r.overDim,
    z: r.camera.position.z,
    bloom: r.bloom.strength,
    bloomBase: r.bloomBase,
    edgesOp: r.frameEdgesMat.opacity,
    starsOp: r.starsNear.material.opacity,
    banner: r.popups.some((p) => p.tier === 'gameover' && p.mesh.visible),
    bannerOp: r.popups.find((p) => p.tier === 'gameover')?.mat.opacity ?? 0,
    barR: r.frameBarMat.color.r,
    barBaseR: r.frameBarColor.r,
  };
});
check('phase4: dim ramp and stack dissolve both completed',
  dimDone !== null && dissolveDone !== null,
  `dim after ${dimDone}ms, dissolve after ${dissolveDone}ms, overDim=${done.overDim}`);
const frozen = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  r.setStack(window.__tetris.game.board); // per-frame call must not re-add
  const n = r.stackMeshes.size;
  return n;
});
check('phase4: per-frame setStack does not resurrect dissolved cells',
  frozen === 0, `meshes=${frozen}`);
check('phase4: aurora curtains dimmed (max sky luminance well below baseline)',
  sky0.valid && sky1.valid && sky1.max < 0.92 * sky0.max,
  `sky ${sky0.max?.toFixed(1)} -> ${sky1.max?.toFixed(1)}`);
check('phase4: full lights-out state (frame/stars/bloom dimmed, camera pushed back)',
  done.edgesOp < 0.45 && done.starsOp < 0.5 && done.bloom < done.bloomBase * 0.8 && done.z > 42,
  `edges=${done.edgesOp.toFixed(2)} stars=${done.starsOp.toFixed(2)} z=${done.z.toFixed(1)} bloom=${done.bloom.toFixed(2)}`);
check('phase4: glow bar dimmed toward the reset-restored base color',
  done.barR < done.barBaseR * 0.6, `r=${done.barR.toFixed(2)} vs base ${done.barBaseR.toFixed(2)}`);
check('phase4: banner still up and breathing long after game over',
  done.banner && done.bannerOp > 0.5, `op=${done.bannerOp?.toFixed(2)}`);

// ---- Phase 5: restart restores full lights, stack rebuilds ----
await key('r');
await sleep(250);
const back = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  return {
    over: r.over,
    overDim: r.overDim,
    dissolves: r.dissolves.length,
    popupsUp: r.popups.some((p) => p.mesh.visible),
    edgesOp: r.frameEdgesMat.opacity,
    starsOp: r.starsNear.material.opacity,
    bloom: r.bloom.strength,
    bloomBase: r.bloomBase,
    z: r.camera.position.z,
    zBase: r.cameraBase.z,
  };
});
check('phase5: restart clears the game-over state',
  back.over === false && back.overDim === 0 && back.dissolves === 0 && back.popupsUp === false,
  `over=${back.over} popups=${back.popupsUp}`);
check('phase5: full lights restored (frame, stars, bloom, camera)',
  back.edgesOp > 0.99 && back.starsOp > 0.8 && Math.abs(back.bloom - back.bloomBase) < 0.01 && Math.abs(back.z - back.zBase) < 0.01,
  `edges=${back.edgesOp.toFixed(2)} bloom=${back.bloom.toFixed(2)} z=${back.z.toFixed(2)}`);
await page.evaluate(() => {
  const g = window.__tetris.game;
  g.board[21][0] = 'I';
  g.board[21][1] = 'T';
  g.board[20][1] = 'S';
});
await sleep(150);
const rebuilt = await page.evaluate(() => window.__tetris.renderer.stackMeshes.size);
check('phase5: stack rebuilds on the new game (per-frame diff works again)',
  rebuilt === 3, `meshes=${rebuilt}`);

// ---- Phase 6: a second game over triggers cleanly (state fully reusable) ----
await fillTowerAndLock();
const again = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  return {
    over: r.over,
    banner: r.popups.some((p) => p.tier === 'gameover' && p.mesh.visible),
    dissolves: r.dissolves.length,
  };
});
check('phase6: second game over re-arms the whole cinematic',
  again.over === true && again.banner && again.dissolves > 100,
  `over=${again.over} banner=${again.banner} dissolves=${again.dissolves}`);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);