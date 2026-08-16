// Browser regression: streak mode — at level 10 the settled crystal stack
// ignites into a living rainbow: every block's hue drifts as a wave
// travelling across the board (world-x/y dependent, time-animated), ramping
// from a faint tint at level 10 to a full rainbow at level 20+. The active
// piece stays pure (pinned-zero uStreak). The ignition moment (9 -> 10)
// fires a full-board rainbow light sweep + stage surge + sonic ring across
// the mirror glass, and a STREAK banner (popupFor, unit-tested).
//
// Proven five ways (the board is a MONOCHROME all-T stack, so any spatial
// hue variation on screen is the wave's, not the piece types'):
//   state  - neutral at level 1; shared live uStreak object wired into every
//            stack material (userData stash), pinned-zero on the hero piece;
//   pixels - a synchronous A/B in ONE evaluate (set the shared uniform to 0
//            between two composer.render() calls: the stack re-hues, the
//            piece and all other stage elements cancel exactly);
//   space  - per-column mean hue spread across the 10 board columns is ~0
//            with the wave off and a wide rainbow spread with it on;
//   time   - one GC-pinned rAF probe proves the wave DRIFTS (the same
//            column's hue rotates as tick time advances);
//   ignite - onStreakIgnite() fires the rainbow trail sweep (caught
//            mid-flight by an in-page rAF probe that A/B-hides the sweep
//            group) and the wide floor ring; the STREAK banner renders;
//   reset  - restart re-arms the exact neutral (no-shimmer) state.
//
// Usage: node test/streak-mode.mjs [url]

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
async function waitUntil(pred, arg, timeoutMs = 15000, pollMs = 25) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred, arg)) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

// ---- Phase 1: fresh game is neutral (no shimmer) ------------------------
const st = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const g = window.__tetris.game;
  // The stack materials only compile once a stack MESH has rendered; a
  // fresh game has no settled blocks yet, so place one temporary block,
  // force-compile (the hero piece group may also be hidden in the spawn
  // rows), read the userData stash, then undo the placement.
  g.board[21][0] = 'T';
  r.setStack(g.board);
  r.pieceGroup.visible = true;
  r.renderer.compile(r.scene, r.camera);
  r.pieceGroup.visible = false;
  g.board[21][0] = null;
  r.setStack(g.board);
  const t = window.__tetris.game.current.type;
  return {
    target: r.streakTarget,
    val: r.streak.value,
    off: r.streakOff.value,
    stackU: r.stackMats['T'].userData.streakUniform ? r.stackMats['T'].userData.streakUniform.value : null,
    pieceU: r.pieceMats[t].userData.streakUniform ? r.pieceMats[t].userData.streakUniform.value : null,
    rainbowTex: !!r.rainbowTex,
    trailTex: !!r.sweepTrailTex,
    distinct: !!r.rainbowTex && r.rainbowTex !== r.sweepTrailTex,
  };
});
check('phase1: level 1 is the neutral stage (starget 0, wave off, hero pinned)',
  st.target === 0 && st.val === 0 && st.off === 0,
  `target=${st.target} val=${st.val} off=${st.off}`);
check('phase1: the shared live uStreak object is wired into the stack materials',
  st.stackU === 0, `stackU=${st.stackU}`);
check('phase1: the hero piece material is pinned to pure (uStreak 0)',
  st.pieceU === 0, `pieceU=${st.pieceU}`);
check('phase1: rainbow trail texture built (distinct from the white ramp)',
  st.rainbowTex && st.distinct);

// ---- Phase 2: rig a MONOCHROME stack + force level 10 --------------------
// The engine is paused (no gravity/locks), the board is one all-T slab
// (rows 12-21: any spatial hue variation is the wave's, not type diversity)
// and the renderer is pushed to level 10 via onLevelUp (the same entry the
// real 9->10 lock crossing uses; level/lines are set consistently so a
// hypothetical no-clear lock would not recompute a different level).
await page.evaluate(() => {
  const g = window.__tetris.game;
  const r = window.__tetris.renderer;
  g.gameOver = false;
  g.paused = true;
  g.level = 10;
  g.lines = 90;
  for (let y = 0; y < g.board.length; y++) g.board[y].fill(null);
  for (let y = 12; y < 22; y++) for (let x = 0; x < 10; x++) g.board[y][x] = 'T';
  r.onLevelUp(10);
});
const rigged = await waitUntil(
  () => window.__tetris.renderer.stackMeshes.size === 100 && window.__tetris.renderer.streak.value > 0.05,
  null,
);
check('phase2: monochrome stack built and the wave eased in (level 10 target 1/11)',
  rigged !== null, `wait=${rigged}ms val=${await page.evaluate(() => window.__tetris.renderer.streak.value)}`);
const live = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  return {
    val: r.streak.value,
    target: r.streakTarget,
    stackU: r.stackMats['T'].userData.streakUniform ? r.stackMats['T'].userData.streakUniform.value : null,
    off: r.streakOff.value,
  };
});
check('phase2: shared object drives every stack material (one update, all blocks)',
  Math.abs(live.stackU - live.val) < 1e-9 && live.target > 0.08 && live.target < 0.1,
  `val=${live.val?.toFixed(4)} target=${live.target?.toFixed(4)}`);
check('phase2: the hero piece stays pure while the stack ignites', live.off === 0, `off=${live.off}`);

// ---- Phase 3: pixel A/B — the wave really re-hues the blocks -------------
// Synchronous, ONE evaluate: crank the shared uniform to full rainbow,
// render; zero it, render; restore. No tick runs between the two renders,
// so grain/aurora/camera/sweep/trail all cancel exactly — the diff is the
// stack's re-hue (+ its mirror doubles + bloom halo), nothing else.
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
  // The stack slab (board rows 12-21) in world: y 0..9, x -4.9..4.9.
  const corners = [
    r.projectToPixel(-4.9, -0.4, 0.3), r.projectToPixel(4.9, -0.4, 0.3),
    r.projectToPixel(-4.9, 9.4, 0.3), r.projectToPixel(4.9, 9.4, 0.3),
  ];
  const x0 = Math.round(Math.min(...corners.map((q) => q.x)));
  const x1 = Math.round(Math.max(...corners.map((q) => q.x)));
  const y0 = Math.round(Math.min(...corners.map((q) => q.y)));
  const y1 = Math.round(Math.max(...corners.map((q) => q.y)));
  const inBox = (px, py) => px >= x0 - 40 && px <= x1 + 40 && py >= y0 - 40 && py <= y1 + 40;
  // Control: a coarse-grid window outside the stack box, upper 55% of the
  // canvas (the mirror floor's reflection of the slab lives lower).
  let ctrl = null;
  outer: for (const fy of [0.12, 0.2, 0.3, 0.42]) {
    for (const fx of [0.12, 0.3, 0.5, 0.7, 0.88]) {
      const cx = Math.round(fx * W), cy = Math.round(fy * H);
      if (cx < 26 || cy < 26 || cx > W - 26 || cy > H - 26) continue;
      if (inBox(cx, cy)) continue;
      ctrl = { x: cx, y: cy };
      break outer;
    }
  }
  const ptsBox = [];
  for (let py = y0; py <= y1; py += 3)
    for (let px = x0; px <= x1; px += 3) ptsBox.push([px, py]);
  const ptsCtrl = [];
  if (ctrl)
    for (let dy = -24; dy <= 24; dy++)
      for (let dx = -24; dx <= 24; dx += 2) ptsCtrl.push([ctrl.x + dx, ctrl.y + dy]);
  const diff = (dA, dB, pts) => {
    let maxD = 0, sum = 0, n = 0;
    for (const [px, py] of pts) {
      const a = lum(dA, px, py), b = lum(dB, px, py);
      if (a === null || b === null) continue;
      const d = Math.abs(b - a);
      if (d > maxD) maxD = d;
      sum += d; n++;
    }
    return { maxD, mean: n ? sum / n : 0, n };
  };
  const saved = r.streak.value;
  r.streak.value = 1; // full rainbow: the strongest, most measurable wave
  const on = grab();
  r.streak.value = 0; // wave off: every block back to its pure base hue
  const off = grab();
  r.streak.value = 1;
  const onAgain = grab(); // same state as `on`: A/B symmetry sanity
  r.streak.value = saved;
  const box = diff(on, off, ptsBox);
  const ctrlD = ctrl ? diff(on, off, ptsCtrl) : { found: false, maxD: 999 };
  const sanity = diff(on, onAgain, ptsBox);
  return { ctrlFound: !!ctrl, box, ctrl: ctrlD, sanity: { maxD: sanity.maxD, mean: sanity.mean }, boxPx: [x0, x1, y0, y1] };
});
check('phase3 pixels: the wave re-hues the stack (uniform A/B over the slab)',
  ab.box.maxD > 25 && ab.box.n > 500,
  `maxD=${ab.box.maxD.toFixed(1)} mean=${ab.box.mean.toFixed(2)} n=${ab.box.n}`);
check('phase3 pixels: a clean control window stays flat', ab.ctrlFound && ab.ctrl.maxD < 8,
  `maxD=${ab.ctrl.maxD.toFixed(1)} mean=${ab.ctrl.mean.toFixed(2)}`);
check('phase3 pixels: the A/B is symmetric (render on / off / on)', ab.sanity.maxD < 3,
  `maxD=${ab.sanity.maxD.toFixed(2)}`);

// ---- Phase 4: spatial wave — per-column hue spread on the mono slab -----
const spread = (hues) => {
  const hs = hues.filter((h) => h !== null);
  if (hs.length < 6) return null;
  return Math.max(...hs) - Math.min(...hs);
};
const spatial = await page.evaluate(
  () => {
    const r = window.__tetris.renderer;
    const c = r.canvas;
    const W = c.width, H = c.height;
    const colHues = () => {
      r.composer.render();
      const o = document.createElement('canvas');
      o.width = W; o.height = H;
      const x2 = o.getContext('2d');
      x2.drawImage(c, 0, 0);
      const img = x2.getImageData(0, 0, W, H).data;
      const out = [];
      for (let x = 0; x < 10; x++) {
        const q = r.projectToPixel(x - 4.5, 5, 0.3); // mid-slab row (row 16)
        const px = Math.round(q.x), py = Math.round(q.y);
        let rs = 0, gs = 0, bs = 0, n = 0;
        for (let dy = -6; dy <= 6; dy++)
          for (let dx = -6; dx <= 6; dx++) {
            const X = px + dx, Y = py + dy;
            if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
            const i = (Y * W + X) * 4;
            const rr = img[i], g = img[i + 1], b = img[i + 2];
            if (Math.max(rr, g, b) - Math.min(rr, g, b) < 30) continue; // desaturated core
            rs += rr; gs += g; bs += b; n++;
          }
        if (n < 8) { out.push(null); continue; }
        rs /= n; gs /= n; bs /= n;
        const mx = Math.max(rs, gs, bs), mn = Math.min(rs, gs, bs);
        if (mx - mn < 24) { out.push(null); continue; }
        let h;
        if (mx === rs) h = ((gs - bs) / (mx - mn)) % 6;
        else if (mx === gs) h = (bs - rs) / (mx - mn) + 2;
        else h = (rs - gs) / (mx - mn) + 4;
        out.push((((h / 6) % 1) + 1) % 1 * 360);
      }
      return out;
    };
    r.streak.value = 1;
    const on = colHues();
    r.streak.value = 0;
    const off = colHues();
    r.streak.value = 1;
    return { on, off };
  },
  {},
);
const onSpread = spread(spatial.on);
const offSpread = spread(spatial.off);
check('phase4: with the wave ON the mono slab carries a wide hue spread across columns',
  onSpread !== null && onSpread > 60, `spread=${onSpread?.toFixed(0)}deg`);
check('phase4: with the wave OFF the mono slab is one uniform hue',
  offSpread !== null && offSpread < 18, `spread=${offSpread?.toFixed(0)}deg`);

// ---- Phase 5: the wave drifts with time ---------------------------------
const drift = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const r = window.__tetris.renderer;
      r.streak.value = 1;
      const sample = () => {
        r.composer.render();
        const c = r.canvas;
        const W = c.width, H = c.height;
        const o = document.createElement('canvas');
        o.width = W; o.height = H;
        const x2 = o.getContext('2d');
        x2.drawImage(c, 0, 0);
        const img = x2.getImageData(0, 0, W, H).data;
        const q = r.projectToPixel(-4.5, 5, 0.3); // leftmost column
        const px = Math.round(q.x), py = Math.round(q.y);
        let rs = 0, gs = 0, bs = 0, n = 0;
        for (let dy = -6; dy <= 6; dy++)
          for (let dx = -6; dx <= 6; dx++) {
            const X = px + dx, Y = py + dy;
            if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
            const i = (Y * W + X) * 4;
            const rr = img[i], g = img[i + 1], b = img[i + 2];
            if (Math.max(rr, g, b) - Math.min(rr, g, b) < 30) continue;
            rs += rr; gs += g; bs += b; n++;
          }
        if (n < 8) return null;
        rs /= n; gs /= n; bs /= n;
        const mx = Math.max(rs, gs, bs), mn = Math.min(rs, gs, bs);
        if (mx - mn < 24) return null;
        let h;
        if (mx === rs) h = ((gs - bs) / (mx - mn)) % 6;
        else if (mx === gs) h = (bs - rs) / (mx - mn) + 2;
        else h = (rs - gs) / (mx - mn) + 4;
        return (((h / 6) % 1) + 1) % 1 * 360;
      };
      const out = { done: false };
      const a = sample();
      const t0 = r.time;
      const finish = (timeout) => {
        if (out.done) return;
        out.done = true;
        const b = sample();
        out.dt = r.time - t0;
        out.a = a;
        out.b = b;
        let dh = null;
        if (a !== null && b !== null) {
          dh = Math.abs(a - b) % 360;
          if (dh > 180) dh = 360 - dh;
        }
        out.dh = dh;
        r.streak.value = r.streakTarget; // hand the wave back to the eased level value
        resolve(out);
      };
      const step = () => {
        if (out.done) return;
        if (r.time - t0 >= 1.3) return finish(false);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      window.__streakDriftProbe = null;
    }),
);
check('phase5: the wave DRIFTS — the same column rotates hue as time advances',
  drift.dh !== null && drift.dh > 8 && drift.dh < 90,
  `dt=${drift.dt?.toFixed(2)}s dh=${drift.dh?.toFixed(1)}deg (expect ~37)`);

// ---- Phase 6: ignition — rainbow sweep + floor ring (rAF probe) ---------
const ignite = await page.evaluate(
  () =>
    new Promise((resolve) => {
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
      const out = { done: false, fired: false, abDone: false };
      const before = r.swept;
      const t0 = performance.now();
      r.onStreakIgnite();
      // Control candidates: a coarse grid; the full-height hot edge's bloom
      // halo reaches a couple of world units either side, so reject any
      // window closer than 240px to the edge column (any static region is
      // a valid control for a synchronous A/B — beams/aurora cancel).
      const cand = [];
      for (const fy of [0.08, 0.16, 0.28, 0.4, 0.55])
        for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9])
          cand.push({ x: Math.round(fx * W), y: Math.round(fy * H) });
      const step = () => {
        if (out.done) return;
        const sw = r.sweeps.find(
          (s) => s.group.visible && s.t > 0.18 && s.t < 0.8 && s.trail.material.map === r.rainbowTex,
        );
        if (sw) {
          out.fired = true;
          out.rainbowEntry = sw.trail.material.map === r.rainbowTex;
          out.sweptDelta = r.swept - before;
          const x = sw.xA + (sw.xB - sw.xA) * sw.t;
          const q = r.projectToPixel(x, 10, 0.3);
          const ex = Math.round(q.x), ey = Math.round(q.y);
          const ring = r.impacts.some((im) => im.ring.visible && im.k === 2.2);
          out.ring = ring;
          // Synchronous A/B on THIS frame: hide only the sweep group.
          const a = grab();
          sw.group.visible = false;
          const b = grab();
          sw.group.visible = true;
          const band = (cx) => {
            let maxD = 0, sum = 0, n = 0;
            for (let dy = -Math.round(H * 0.22); dy <= Math.round(H * 0.22); dy += 2)
              for (let dx = -8; dx <= 8; dx++) {
                const la = lum(a, cx + dx, ey + dy);
                const lb = lum(b, cx + dx, ey + dy);
                if (la === null || lb === null) continue;
                const d = Math.abs(lb - la);
                if (d > maxD) maxD = d;
                sum += d; n++;
              }
            return { maxD, mean: n ? sum / n : 0, n };
          };
          const win = (cx) => {
            let maxD = 0, sum = 0, n = 0;
            for (let dy = -22; dy <= 22; dy += 2)
              for (let dx = -22; dx <= 22; dx += 2) {
                const la = lum(a, cx + dx, ey + dy);
                const lb = lum(b, cx + dx, ey + dy);
                if (la === null || lb === null) continue;
                const d = Math.abs(lb - la);
                if (d > maxD) maxD = d;
                sum += d; n++;
              }
            return { maxD, mean: n ? sum / n : 0, n };
          };
          let ctrl = cand.find((w) => Math.abs(w.x - ex) > 240 && w.y > 22 && w.y < H - 22);
          if (!ctrl) ctrl = cand[0];
          out.band = band(ex);
          out.ctrl = win(ctrl.x);
          out.ctrlPos = ctrl;
          out.ex = ex;
          out.abDone = true;
          out.done = true;
          resolve(out);
          return;
        }
        if (performance.now() - t0 > 12000) {
          out.timeout = true;
          out.done = true;
          resolve(out);
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      window.__streakIgniteProbe = null;
    }),
);
check('phase6: onStreakIgnite fires the full-board rainbow sweep (rainbow trail texture)',
  ignite.fired && ignite.rainbowEntry === true && ignite.sweptDelta === 1,
  `fired=${ignite.fired} sweptΔ=${ignite.sweptDelta}`);
check('phase6: the ignition also rings the mirror glass (k=2.2 floor ring)', ignite.ring === true);
check('phase6 pixels: the rainbow edge carries light mid-flight (group A/B)',
  ignite.abDone && ignite.band.maxD > 30 && ignite.band.n > 100,
  `maxD=${ignite.band.maxD.toFixed(1)} mean=${ignite.band.mean?.toFixed(2)}`);
check('phase6 pixels: the far control stays flat', ignite.abDone && ignite.ctrl.maxD < 30,
  `maxD=${ignite.ctrl.maxD?.toFixed(1)} at (${ignite.ctrlPos?.x},${ignite.ctrlPos?.y}) vs edge x=${ignite.ex} (full-height edge's bloom-diff tail on the narrow canvas; the band carries ~100+)`);

// ---- Phase 7: the STREAK banner renders (new gradient tier) -------------
const banner = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const r = window.__tetris.renderer;
      const c = r.canvas;
      const W = c.width, H = c.height;
      const out = { done: false };
      r.showPopup({ text: 'STREAK', tier: 'streak' });
      const t0 = performance.now();
      const step = () => {
        const p = r.popups.find((q) => q.tier === 'streak' && q.t > 0.08 && q.t < 0.7);
        if (p && p.mesh.visible) {
          out.shown = true;
          out.text = p.text;
          out.gain = p.mat.color.r;
          // Synchronous A/B: hide the banner mesh. The anamorphic flare
          // that rides this tier (quad + grade uFlare) is suppressed in
          // BOTH frames so the A/B isolates the banner itself — the flare's
          // baseline bloom would shift the far-corner diffs through bloom
          // nonlinearity.
          const u = r.gradePass.uniforms;
          const savedFlare = u.uFlare.value;
          if (p.flareOn) p.flareMesh.visible = false;
          u.uFlare.value = 0;
          r.composer.render();
          const o = document.createElement('canvas');
          o.width = W; o.height = H;
          const x2 = o.getContext('2d');
          x2.drawImage(c, 0, 0);
          const on = x2.getImageData(0, 0, W, H).data;
          p.mesh.visible = false;
          r.composer.render();
          x2.drawImage(c, 0, 0);
          const off = x2.getImageData(0, 0, W, H).data;
          p.mesh.visible = true;
          if (p.flareOn) p.flareMesh.visible = true;
          u.uFlare.value = savedFlare;
          const q = r.projectToPixel(0, r.popupY + 0.5, r.popupZ);
          const px = Math.round(q.x), py = Math.round(q.y);
          const lum = (d, X, Y) => {
            if (X < 0 || Y < 0 || X >= W || Y >= H) return null;
            const i = (Y * W + X) * 4;
            return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          };
          const scan = (cx, cy) => {
            let maxD = 0, n = 0;
            for (let dy = -22; dy <= 22; dy += 2)
              for (let dx = -22; dx <= 22; dx += 2) {
                const a = lum(on, cx + dx, cy + dy);
                const b = lum(off, cx + dx, cy + dy);
                if (a === null || b === null) continue;
                const dl = Math.abs(b - a);
                if (dl > maxD) maxD = dl;
                n++;
              }
            return { maxD, n };
          };
          // Banner band: wide window around the projected banner center.
          let bandMax = 0, bandN = 0;
          for (let dy = -40; dy <= 40; dy += 2)
            for (let dx = -120; dx <= 120; dx += 3) {
              const a = lum(on, px + dx, py + dy);
              const b = lum(off, px + dx, py + dy);
              if (a === null || b === null) continue;
              const dl = Math.abs(b - a);
              if (dl > bandMax) bandMax = dl;
              bandN++;
            }
          out.band = { maxD: bandMax, n: bandN };
          // Control: the banner's wide bloom halo reaches >100px, so scan a
          // coarse grid for a window well clear of it (any static region
          // is valid for a synchronous A/B).
          const cand = [];
          for (const fy of [0.08, 0.2, 0.5, 0.8, 0.92])
            for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9])
              cand.push({ x: Math.round(fx * W), y: Math.round(fy * H) });
          let ctrl = cand.find(
            (w) => Math.abs(w.x - px) > 220 && Math.abs(w.y - py) > 220 && w.y > 22 && w.y < H - 22,
          );
          if (!ctrl) ctrl = cand[0];
          out.ctrl = scan(ctrl.x, ctrl.y);
          out.ctrlPos = ctrl;
          out.done = true;
          resolve(out);
          return;
        }
        if (performance.now() - t0 > 12000) {
          out.timeout = true;
          out.done = true;
          resolve(out);
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      window.__streakBannerProbe = null;
    }),
);
check('phase7: the STREAK banner (gradient tier) pops on stage and carries light',
  banner.shown === true && banner.text === 'STREAK' && banner.band.maxD > 20,
  `shown=${banner.shown} maxD=${banner.band.maxD?.toFixed(1)} gain=${banner.gain?.toFixed(2)}`);
check('phase7: banner A/B control stays flat', banner.ctrl && banner.ctrl.maxD < 10,
  `maxD=${banner.ctrl?.maxD?.toFixed(1)} at (${banner.ctrlPos?.x},${banner.ctrlPos?.y})`);

// ---- Phase 8: restart re-arms the exact neutral state -------------------
await page.keyboard.down('r');
await page.keyboard.up('r');
const restored = await waitUntil(
  () => {
    const r = window.__tetris.renderer;
    return r.streakTarget === 0 && r.streak.value === 0 && r.stackMeshes.size === 0 && r.levelHue === 0;
  },
  null,
);
check('phase8: restart re-arms streak to the neutral level-1 state (wave off, stack gone)',
  restored !== null, `wait=${restored}ms`);
const post = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  return {
    target: r.streakTarget,
    val: r.streak.value,
    off: r.streakOff.value,
    hue: r.levelHue,
    uHue: r.auroraUniforms.uHue.value,
    meshes: r.stackMeshes.size,
  };
});
check('phase8: stage palette restored to neutral with the hero still pure',
  post.hue === 0 && Math.abs(post.uHue) < 1e-6 && post.off === 0 && post.meshes === 0,
  `hue=${post.hue} uHue=${post.uHue?.toFixed(4)}`);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);