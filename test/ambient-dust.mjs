// Browser regression: ambient light-dust motes. A field of fine particles
// drifts slowly up through the stage air (camera side of the glow bar),
// each mote twinkling on its own phase with a few "hot" sparkles running
// much brighter; the field is stage-hue tinted (re-inked by the level
// palette), doubles in the mirror glass and dims with the game-over
// lights-out. It is the always-on ambient layer that keeps the stage
// feeling alive between FX moments.
//
// Proven four ways:
//   state  - the dust Points object is live in the scene with the full
//            volume populated, hot sparkles present, neutral tint at level 1;
//   time   - one in-page rAF probe (GC-pinned on window) waits for tick time
//            to advance 1.0 s and proves every mote moved (drift + wrap)
//            and the twinkle buffer changed;
//   pixels - a synchronous A/B in ONE evaluate hides the dust between two
//            composer.render() calls (no tick between renders, so grain /
//            aurora / camera cancel exactly): the top-brightest motes'
//            projected windows differ strongly, a sky control window with no
//            mote inside stays flat;
//   hue    - _applyStageHue(0.37) re-inks the dust material color to the
//            offset-HSL reference and _applyStageHue(0) restores it (the
//            real level-up path is covered by level-palette.mjs);
//   dim    - a real lock-out game over dims the field (brightness sum over
//            all motes, twinkle-averaged) and restart restores full lights.
//
// Usage: node test/ambient-dust.mjs [url]

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
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Phase 1: dust installed, volume populated, motion + twinkle live ----
const st = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const pts = r.dust;
  const pos = pts.geometry.getAttribute('position');
  const n = pos.count;
  let inVol = true;
  let hot = 0;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (x < -8.3 || x > 8.3 || y < -0.4 || y > 24.6 || z < -0.5 || z > 3.3) inVol = false;
  }
  for (const d of r.dustData) if (d.base > 0.8) hot++;
  return {
    exists: !!pts,
    inScene: !!pts && pts.parent === r.scene,
    additive: !!pts && pts.material.blending === 2, // THREE.AdditiveBlending
    n,
    inVol,
    hot,
    dataN: r.dustData.length,
    tintH: pts ? pts.material.color.getHSL({})?.h ?? null : null,
  };
});
check('phase1: dust Points installed and live in the scene', st.exists && st.inScene,
  `exists=${st.exists} inScene=${st.inScene}`);
check('phase1: additive soft-sprite field with the expected population',
  st.additive && st.n === 150 && st.dataN === 150, `n=${st.n} data=${st.dataN}`);
check('phase1: every mote inside the stage volume', st.inVol);
check('phase1: hot sparkles present among the fine dust', st.hot >= 5 && st.hot < 60,
  `hot=${st.hot}`);
check('phase1: neutral cool tint at level 1 (hue ~0.61)',
  st.tintH !== null && Math.abs(st.tintH - 0.608) < 0.01, `hue=${st.tintH?.toFixed(3)}`);

// One GC-pinned in-page probe: snapshot motes now, wait for tick time to
// advance 1.0 s, snapshot again — proves drift (every mote moved, volume
// still respected after wraps) and twinkle (the color buffer changed).
const motion = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const r = window.__tetris.renderer;
      const p = r.dustPos, c = r.dustCol;
      const snap = () => ({
        pos: Float32Array.from(p),
        col: Float32Array.from(c),
        colSum: c.reduce((s, v) => s + v, 0),
        t: r.time,
      });
      const a = snap();
      const out = { a: { colSum: a.colSum }, done: false };
      const finish = () => {
        if (out.done) return;
        out.done = true;
        const b = snap();
        let maxD = 0, minD = Infinity, maxC = 0;
        for (let i = 0; i < a.pos.length; i++) {
          const d = Math.abs(b.pos[i] - a.pos[i]);
          if (d > maxD) maxD = d;
          if (d < minD && d >= 0) minD = d;
          const cd = Math.abs(b.col[i] - a.col[i]);
          if (cd > maxC) maxC = cd;
        }
        // z is static by design; x/y must have moved for EVERY mote.
        let xyMoved = true;
        for (let i = 0; i < a.pos.length / 3; i++) {
          const dx = Math.abs(b.pos[i * 3] - a.pos[i * 3]);
          const dy = Math.abs(b.pos[i * 3 + 1] - a.pos[i * 3 + 1]);
          if (dx < 1e-5 && dy < 1e-5) xyMoved = false;
        }
        let inVol = true;
        for (let i = 0; i < b.pos.length / 3; i++) {
          const x = b.pos[i * 3], y = b.pos[i * 3 + 1];
          if (x < -8.3 || x > 8.3 || y < -0.4 || y > 24.6) inVol = false;
        }
        out.b = { colSum: b.colSum };
        out.maxD = maxD;
        out.minD = minD;
        out.maxC = maxC;
        out.xyMoved = xyMoved;
        out.inVol = inVol;
        out.dt = b.t - a.t;
        resolve(out);
      };
      const step = () => {
        if (out.done) return;
        if (r.time - a.t >= 1.0) return finish();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      // GC pin: slow SwiftShader frames can collect unpinned promises.
      window.__dustProbe = null;
    }),
);
check('phase1: tick advanced >= 1.0 s in the probe', motion.dt >= 1.0, `dt=${motion.dt.toFixed(2)}`);
check('phase1: every mote drifted (x or y moved)', motion.xyMoved === true);
check('phase1: volume respected after drift wraps', motion.inVol === true,
  `maxD=${motion.maxD.toFixed(3)}`);
check('phase1: twinkle buffer animated (per-mote brightness changed)',
  motion.maxC > 0.01, `maxC=${motion.maxC.toFixed(3)}`);

// ---- Phase 2: pixel A/B — the motes really render (and bloom) on screen ----
// Synchronous hide/render/grab/show/render/grab in ONE evaluate: no tick
// runs between the two renders, so grain, aurora, camera sway and every
// other uniform-driven effect cancels exactly; the diff is the dust alone
// (direct sprites + their mirror-glass doubles + bloom halo).
const ab = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const c = r.canvas;
  const W = c.width, H = c.height;
  const grab = () => {
    r.composer.render();
    const o = document.createElement('canvas');
    o.width = W; o.height = H;
    const x2 = o.getContext('2d');
    x2.drawImage(c, 0, 0);
    return x2.getImageData(0, 0, W, H).data;
  };
  const lum = (d, px, py) => {
    if (px < 0 || py < 0 || px >= W || py >= H) return null;
    const i = (py * W + px) * 4;
    return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  };
  // Project every mote; keep the in-canvas ones; rank by current
  // brightness; take the brightest 16 for the diff band.
  const p = r.dustPos, b = r.dustCol;
  const n = p.length / 3;
  const motes = [];
  for (let i = 0; i < n; i++) {
    const q = r.projectToPixel(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    if (q.x < 12 || q.y < 12 || q.x > W - 12 || q.y > H - 12) continue;
    motes.push({ x: Math.round(q.x), y: Math.round(q.y), b: b[i * 3] });
  }
  const bright = motes.filter((m) => m.b > 0.3).sort((u, v) => v.b - u.b).slice(0, 16);
  // Control: a 52x52 window with NO projected mote center within 26 px
  // (sprite + bloom halo clearance). The camera tilts ~9deg down, so high
  // sky points project off the top edge — instead scan a coarse grid over
  // the whole canvas (any static region is valid for a synchronous A/B,
  // bright or not: the diff isolates the motes themselves).
  let ctrl = null;
  outer: for (const fy of [0.15, 0.5, 0.85]) {
    for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const cx = Math.round(fx * W), cy = Math.round(fy * H);
      if (cx < 26 || cy < 26 || cx > W - 26 || cy > H - 26) continue;
      const inside = motes.some(
        (m) => Math.abs(m.x - cx) < 26 && Math.abs(m.y - cy) < 26,
      );
      if (!inside) { ctrl = { x: cx, y: cy }; break outer; }
    }
  }
  const diff = (dA, dB, fn) => {
    let maxD = 0, sum = 0, cnt = 0;
    for (const [px, py] of fn()) {
      const a = lum(dA, px, py);
      const d = lum(dB, px, py);
      if (a === null || d === null) continue;
      const dl = Math.abs(d - a);
      if (dl > maxD) maxD = dl;
      sum += dl;
      cnt++;
    }
    return { maxD, mean: cnt ? sum / cnt : 0, n: cnt };
  };
  const bandPts = () => {
    const pts = [];
    for (const m of bright)
      for (let dy = -6; dy <= 6; dy++)
        for (let dx = -6; dx <= 6; dx++) pts.push([m.x + dx, m.y + dy]);
    return pts;
  };
  const ctrlPts = () => {
    if (!ctrl) return [];
    const pts = [];
    for (let dy = -26; dy <= 26; dy++)
      for (let dx = -26; dx <= 26; dx += 2) pts.push([ctrl.x + dx, ctrl.y + dy]);
    return pts;
  };
  const base = grab(); // dust shown (baseline scene)
  r.dust.visible = false;
  const off = grab(); // dust hidden
  r.dust.visible = true;
  const back = grab(); // dust shown again (sanity: identical to baseline)
  const band = diff(off, back, bandPts);
  const ctrlD = diff(off, back, ctrlPts);
  const sanity = diff(base, back, bandPts);
  return {
    motes: motes.length,
    bright: bright.length,
    band,
    ctrl: { found: !!ctrl, ...ctrlD },
    sanity: { maxD: sanity.maxD, mean: sanity.mean },
  };
});
check('phase2: a solid share of motes project in-canvas (portrait frustum)',
  ab.motes > 60, `motes=${ab.motes}`);
check('phase2: enough bright motes selected for the band', ab.bright >= 8, `bright=${ab.bright}`);
check('phase2: a clean sky control window was found', ab.ctrl.found);
check('phase2 pixels: hiding the dust removes light at the bright motes',
  ab.bright > 0 && ab.band.maxD > 15 && ab.band.n > 200,
  `maxD=${ab.band.maxD.toFixed(1)} mean=${ab.band.mean.toFixed(2)} n=${ab.band.n}`);
check('phase2 pixels: sky control stays flat', ab.ctrl.found && ab.ctrl.maxD < 12,
  `maxD=${ab.ctrl.maxD.toFixed(1)} mean=${ab.ctrl.mean.toFixed(2)}`);
check('phase2 pixels: the band signal dwarfs the control',
  ab.ctrl.found && ab.ctrl.maxD < ab.band.maxD / 2,
  `band=${ab.band.maxD.toFixed(1)} ctrl=${ab.ctrl.maxD.toFixed(1)}`);
check('phase2: show/hide/show is symmetric (A/B sanity)',
  ab.sanity.maxD < 3, `maxD=${ab.sanity.maxD.toFixed(1)}`);

// ---- Phase 3: the dust re-inks with the stage palette (and restores) ----
const hue = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const C = r.dust.material.color.constructor; // THREE.Color class
  const hsl = (col) => col.getHSL({});
  const before = hsl(r.dust.material.color);
  r._applyStageHue(0.37);
  const after = hsl(r.dust.material.color);
  r._applyStageHue(0);
  const restored = hsl(r.dust.material.color);
  const ref = hsl(new C(0xeef4ff).offsetHSL(0.37, 0, 0));
  const circ = (a, b) => {
    let d = Math.abs(a - b) % 1;
    if (d > 0.5) d = 1 - d;
    return d;
  };
  return {
    beforeH: before.h,
    afterH: after.h,
    refH: ref.h,
    restoredH: restored.h,
    dRef: circ(after.h, ref.h),
    dRestored: circ(restored.h, before.h),
  };
});
check('phase3: _applyStageHue re-inks the dust to the offset-HSL reference',
  hue.dRef < 0.02, `after=${hue.afterH.toFixed(3)} ref=${hue.refH.toFixed(3)}`);
check('phase3: neutral restore is exact (no HSL drift)', hue.dRestored < 0.004,
  `restored=${hue.restoredH.toFixed(3)} before=${hue.beforeH.toFixed(3)}`);

// ---- Phase 4: game over dims the field; restart restores full lights ----
const sum0 = await page.evaluate(() => {
  const c = window.__tetris.renderer.dustCol;
  return c.reduce((s, v) => s + v, 0);
});
// A dense tower with rows 0-1 empty: the O locks entirely in the hidden
// rows -> lock-out (same trigger as gameover-cinematic.mjs).
await page.evaluate(() => {
  const g = window.__tetris.game;
  g.gameOver = false;
  g.paused = false;
  const types = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  for (let y = 0; y < g.board.length; y++)
    for (let x = 0; x < 10; x++) g.board[y][x] = y >= 2 ? types[(y + x) % 7] : null;
  g.current = { type: 'O', rotation: 0, x: 4, y: 0 };
  g.lock = { resets: 0, lastReset: false };
  const t = window.__tetris.timing;
  t.lockTimer = null; t.gravityAccum = 0; t.softAccum = 0;
  t.das = 0; t.arr = 0; t.freeze = 0;
});
await sleep(120);
await page.keyboard.down(' ');
await page.keyboard.up(' ');
const dimmed = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const r = window.__tetris.renderer;
      const out = { done: false };
      const t0 = performance.now();
      const sum = () => r.dustCol.reduce((s, v) => s + v, 0);
      const finish = (timeout) => {
        if (out.done) return;
        out.done = true;
        out.timeout = timeout;
        out.over = r.over;
        out.overDim = r.overDim;
        out.sum = sum();
        resolve(out);
      };
      const step = () => {
        if (out.done) return;
        if (r.over && r.overDim > 0.6) return finish(false);
        if (performance.now() - t0 > 30000) return finish(true);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      // GC pin: slow SwiftShader frames can collect unpinned promises.
      window.__dustDimProbe = null;
    }),
);
check('phase4: lock-out entered the lights-out ramp', !dimmed.timeout && dimmed.over === true,
  `overDim=${(dimmed.overDim ?? 0).toFixed(2)}`);
check('phase4: the dust field dims with the stage (brightness sum drops)',
  dimmed.sum < 0.8 * sum0 && dimmed.sum > 0,
  `sum ${sum0.toFixed(1)} -> ${dimmed.sum?.toFixed(1)} (dim=${(dimmed.sum / sum0).toFixed(2)})`);
// Restart: full lights, dust back at full brightness.
await page.keyboard.down('r');
await page.keyboard.up('r');
const restored = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const r = window.__tetris.renderer;
      const out = { done: false };
      const t0 = performance.now();
      const finish = (timeout) => {
        if (out.done) return;
        out.done = true;
        out.timeout = timeout;
        out.overDim = r.overDim;
        out.sum = r.dustCol.reduce((s, v) => s + v, 0);
        out.tintH = r.dust.material.color.getHSL({}).h;
        resolve(out);
      };
      const step = () => {
        if (out.done) return;
        if (!r.over && r.overDim === 0 && r.stackMeshes.size === 0) return finish(false);
        if (performance.now() - t0 > 15000) return finish(true);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }),
);
check('phase4: restart restores the lights (over cleared, dim back to 0)',
  !restored.timeout && restored.overDim === 0, `overDim=${restored.overDim}`);
check('phase4: dust brightness restored to full', restored.sum > 0.75 * sum0,
  `sum ${sum0.toFixed(1)} -> ${restored.sum?.toFixed(1)}`);
check('phase4: tint back to the neutral cool palette',
  Math.abs(restored.tintH - 0.608) < 0.01, `hue=${restored.tintH?.toFixed(3)}`);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);