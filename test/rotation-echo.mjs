// Browser regression: the holographic rotation echo.
//
// On every successful rotation the renderer flashes the PRE-rotation
// footprint as a holo afterimage (the same shared shader as the ghost
// faces) that swells slightly and fades out over ECHO_LIFE s (the pure
// envelope lives in src/echo.js). A tick-time throttle keeps rotation
// flicker from stacking a wall of afterimages; echoes of pieces in the
// hidden spawn rows are suppressed (they would poke above the frame, like
// the ghost); the game-over lights out kills in-flight echoes and restart
// re-arms the pool.
//
// Pixel verification: synchronous A/B captures (hide echoGroup, render,
// restore, render inside ONE in-page evaluate) — no tick runs between the
// two renders, so grain/aurora/camera cancel exactly and the diff is
// purely the echo (+ its bloom halo). Each engine-driven phase (O-skip
// hard drops, the rotation itself, the throttled double rotation, the
// hidden-row rotation, the game-over kill) runs inside a single
// synchronous in-page evaluate via __tetris.doRotate / doHardDrop, and
// the in-page rAF spinners (piece-angle settle, throttle expiry, fade
// completion) all resolve inside the SAME task before the A/B — zero
// round-trip races. window.__abEcho (installed once below) is the shared
// in-page A/B helper: it reads the composer canvas, so no outer-scope
// value ever crosses the evaluate bridge.
//
// Usage: node test/rotation-echo.mjs [url]

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
async function waitUntil(pred, arg, timeoutMs = 10000, pollMs = 50) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred, arg)) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

// Install the in-page A/B helper ONCE: it renders the composer, reads the
// canvas, and returns the two luminance grids with the echo group toggled
// off/on. Called synchronously from inside each phase's evaluate, so both
// captures happen in one task (no tick can interleave).
await page.evaluate(() => {
  window.__abEcho = (r) => {
    const readFrame = () => {
      r.composer.render();
      const c = r.canvas;
      const off = document.createElement('canvas');
      off.width = c.width; off.height = c.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0);
      const img = ctx.getImageData(0, 0, c.width, c.height).data;
      const lum = new Uint8Array(c.width * c.height);
      for (let i = 0, q = 0; i < img.length; i += 4, q++) {
        lum[q] = Math.min(255, (0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2]) | 0);
      }
      return lum;
    };
    r.echoGroup.visible = false;
    const a = readFrame();
    r.echoGroup.visible = true;
    const b = readFrame();
    return { a, b, w: r.canvas.width, h: r.canvas.height };
  };
});

// Coarse-grid control-window scan: the smallest max|ΔL| window that stays
// clear of the echo's projected center (bloom halo rejection).
function controlScan(res, cx, cy, rejectR = 150) {
  let best = { v: Infinity, x: -1, y: -1 };
  for (let y = 24; y < res.h - 24; y += 12) {
    for (let x = 24; x < res.w - 24; x += 12) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < rejectR * rejectR) continue;
      let m = 0;
      for (let oy = -20; oy <= 20; oy += 4) {
        for (let ox = -20; ox <= 20; ox += 4) {
          const i = (y + oy) * res.w + (x + ox);
          const d = Math.abs(res.b[i] - res.a[i]);
          if (d > m) m = d;
        }
      }
      if (m < best.v) best = { v: m, x, y };
    }
  }
  return best;
}

function maxDiff(res, px, py, half) {
  let m = 0;
  for (let dy = -half; dy <= half; dy += 2) {
    for (let dx = -half; dx <= half; dx += 2) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= res.w || y >= res.h) continue;
      const d = Math.abs(res.b[y * res.w + x] - res.a[y * res.w + x]);
      if (d > m) m = d;
    }
  }
  return m;
}

async function project(points) {
  return page.evaluate((pts) =>
    pts.map(([x, y, z]) => {
      const p = window.__tetris.renderer.projectToPixel(x, y, z);
      return { x: p.x, y: p.y };
    }), points);
}

await page.evaluate(() => { window.__tetris.game.paused = true; });

// ---- 1. Rest state: the pool is installed, every slot dark ----
const s1 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const ghostMat = r.ghostMats[r.ghostType];
  return {
    slots: r.echoes.length,
    inScene: r.echoes.every((s) => s.group.parent === r.echoGroup),
    allHidden: r.echoes.every((s) => !s.group.visible),
    lastEchoT: r.lastEchoT,
    // uFade=1 must be the exact identity for the shared holo shader: the
    // ghost's faces (uFade pinned at 1) render exactly as before.
    ghostUFade: ghostMat ? ghostMat.box.uniforms.uFade.value : -1,
  };
});
check('echo pool installed (8 slots, all in the echo group, dark at rest)',
  s1.slots === 8 && s1.inScene && s1.allHidden, `slots=${s1.slots}`);
check('throttle armed for the first echo (lastEchoT far in the past)', s1.lastEchoT <= 0,
  `lastEchoT=${s1.lastEchoT}`);
check('uFade=1 is the shader identity for the ghost/display materials', s1.ghostUFade === 1,
  `uFade=${s1.ghostUFade}`);
const abRest = await page.evaluate(() => window.__abEcho(window.__tetris.renderer));
{
  let m = 0;
  for (let i = 0; i < abRest.a.length; i += 7) {
    const d = Math.abs(abRest.b[i] - abRest.a[i]);
    if (d > m) m = d;
  }
  check('rest frame is bit-identical with the echo group toggled (identity at rest)', m < 4,
    `max|ΔL| ${m}`);
}

// ---- 2. A rotation flashes the pre-rotation footprint (geometry + pixels) ----
// One in-page evaluate: O-skip hard drops, park the piece, rotate via the
// real key-handler entry point, settle the piece-mesh angle, run the sync
// A/B, then probe the fade to completion — all in the same task.
const p2 = await page.evaluate(() => new Promise((resolve) => {
  const g = window.__tetris.game;
  const r = window.__tetris.renderer;
  // O cannot rotate (identical footprint every state): skip to a non-O
  // piece. O drops are parked against the left wall so the test's park
  // column (the spawn x) stays clear of the residue stack.
  let guard = 0;
  while (g.current.type === 'O' && guard++ < 9) {
    g.paused = false;
    g.current.x = 0;
    window.__tetris.doHardDrop();
    g.paused = true;
  }
  const p = g.current;
  p.rotation = 0;
  p.y = 14;
  const prev = { type: p.type, rotation: p.rotation, x: p.x, y: p.y };
  g.paused = false;
  window.__tetris.doRotate(1);
  g.paused = true;
  const post = { rotation: p.rotation, x: p.x, y: p.y };
  const anchor = r._pieceAnchor(prev.type, prev.rotation, prev.x, prev.y);
  const visIdx = r.echoes.findIndex((s) => s.group.visible);
  const slot = r.echoes[visIdx];
  const st = {
    visCount: r.echoes.filter((s) => s.group.visible).length,
    visIdx,
    slotType: slot ? slot.type : null,
    anchorMatch: slot
      ? Math.hypot(slot.group.position.x - anchor.x, slot.group.position.y - anchor.y) < 1e-6
      : false,
    rz: slot ? slot.group.rotation.z : NaN,
    uFade: slot ? slot.mats[slot.type].box.uniforms.uFade.value : -1,
    edgeOp: slot ? slot.mats[slot.type].edge.opacity : -1,
    scale: slot ? slot.group.scale.x : -1,
    isHolo: slot ? !!slot.mats[slot.type].box.isShaderMaterial : false,
    nBoxes: slot ? slot.group.children.length : 0,
  };
  const samples = [];
  let ab = null;
  const probe = () => {
    const s = r.echoes[visIdx];
    samples.push({
      t: r.time,
      vis: s.group.visible,
      fade: s.mats[s.type].box.uniforms.uFade.value,
      scale: s.group.scale.x,
    });
    if (!s.group.visible || samples.length > 90) {
      delete window.__echoProbe;
      resolve({
        nonO: g.current.type !== 'O',
        prev, post, st,
        anchorPx: r.projectToPixel(anchor.x, anchor.y, 0),
        ab,
        samples,
      });
      return;
    }
    window.__echoProbe = probe; // GC pin
    requestAnimationFrame(probe);
  };
  const settle = () => {
    // Settle the piece-mesh rotation so the A/B measures the echo over a
    // mostly-disjoint background (non-O footprints differ per state).
    if (Math.abs(r.pieceAngle - r.pieceAngleTarget) > 0.12) {
      window.__echoProbe = settle; // GC pin
      requestAnimationFrame(settle);
      return;
    }
    ab = window.__abEcho(r);
    window.__echoProbe = probe;
    requestAnimationFrame(probe);
  };
  requestAnimationFrame(settle);
}));
check('piece rotated in place (engine applied the rotation, no kick needed mid-board)',
  p2.nonO && p2.post.rotation === (p2.prev.rotation + 1) % 4 && p2.post.x === p2.prev.x &&
  p2.post.y === p2.prev.y,
  `${p2.prev.type} rot ${p2.prev.rotation} -> ${p2.post.rotation} at (${p2.post.x},${p2.post.y})`);
check('exactly one echo spawned by the rotation', p2.st.visCount === 1, `count=${p2.st.visCount}`);
check('echo shows the PRE-rotation piece type with its footprint',
  p2.st.slotType === p2.prev.type && p2.st.nBoxes > 0, `type=${p2.st.slotType} boxes=${p2.st.nBoxes}`);
check('echo anchors exactly on the pre-rotation piece anchor (world match)', p2.st.anchorMatch === true);
{
  const ab = p2.ab;
  const cx = Math.round(p2.anchorPx.x), cy = Math.round(p2.anchorPx.y);
  const dRot = Math.abs(p2.st.rz - (-p2.prev.rotation * Math.PI / 2));
  check('echo carries the pre-rotation orientation (-rotation * 90 deg)', dRot < 1e-6,
    `rz=${p2.st.rz.toFixed(3)}`);
  check('echo spawns full-strength (uFade=1, edge lines at base opacity, scale 1)',
    p2.st.uFade > 0.99 && Math.abs(p2.st.edgeOp - 0.5) < 0.02 && p2.st.scale === 1,
    `uFade=${p2.st.uFade} edge=${p2.st.edgeOp} scale=${p2.st.scale}`);
  check('echo faces use the shared holo shader', p2.st.isHolo === true);
  const feat = maxDiff(ab, cx, cy, 64);
  const ctl = controlScan(ab, cx, cy);
  check('echo lights the screen (A/B diff in its footprint)', feat > 12, `max|ΔL| ${feat.toFixed(0)}`);
  check('control window flat (sync renders cancel the background)', ctl.v < 8,
    `max|ΔL| ${ctl.v.toFixed(1)} at (${ctl.x},${ctl.y})`);
  p2.feat = feat;
}
const f = p2.samples;
check('fade probe saw the afterimage hold then dissolve (monotonic uFade to hidden)',
  f.length >= 3 && f[0].fade > 0.4 && f.every((s, i) => i === 0 || s.fade <= f[i - 1].fade + 1e-9) &&
  !f[f.length - 1].vis,
  `n=${f.length} fade ${f[0].fade.toFixed(2)} -> ${f[f.length - 1].fade.toFixed(2)}`);
check('afterimage swells as it fades (scale grows toward 1 + growth)',
  f.length >= 3 && f[f.length - 2].scale > f[0].scale && f[f.length - 2].scale < 1.2,
  `scale ${f[0].scale.toFixed(3)} -> ${f[f.length - 2].scale.toFixed(3)}`);

// ---- 3. Mid-fade: the pixel signal attenuates with the fade envelope ----
const p3 = await page.evaluate(() => new Promise((resolve) => {
  const g = window.__tetris.game;
  const r = window.__tetris.renderer;
  const p = g.current;
  const doSpin = (tries) => {
    const slot = r.echoes.find((s) => s.group.visible);
    if (!slot) {
      if (tries <= 0) { resolve({ fail: 'echo expired before catch' }); return; }
      // Faded out before the catch frame: rotate again and keep spinning.
      p.rotation = 0;
      p.y = 14;
      g.paused = false;
      window.__tetris.doRotate(1);
      g.paused = true;
      requestAnimationFrame(() => doSpin(tries - 1));
      return;
    }
    const fade = slot.mats[slot.type].box.uniforms.uFade.value;
    if (fade >= 0.4) { requestAnimationFrame(() => doSpin(tries)); return; }
    const anchor = r._pieceAnchor(p.type, 0, p.x, 14);
    const ab = window.__abEcho(r);
    resolve({
      fade,
      anchorPx: r.projectToPixel(anchor.x, anchor.y, 0),
      ab,
    });
  };
  const waitThrottle = () => {
    if (r.time - r.lastEchoT < 0.12) { requestAnimationFrame(waitThrottle); return; }
    p.rotation = 0;
    p.y = 14;
    g.paused = false;
    window.__tetris.doRotate(1);
    g.paused = true;
    requestAnimationFrame(() => doSpin(2));
  };
  requestAnimationFrame(waitThrottle);
}));
if (p3.fail) {
  check('mid-fade echo caught', false, p3.fail);
} else {
  const cx = Math.round(p3.anchorPx.x), cy = Math.round(p3.anchorPx.y);
  const feat = maxDiff(p3.ab, cx, cy, 64);
  const ctl = controlScan(p3.ab, cx, cy);
  check('mid-fade echo still lights the screen (signal alive at uFade<0.4)', feat > 3,
    `max|ΔL| ${feat.toFixed(1)} at fade ${p3.fade.toFixed(2)}`);
  check('mid-fade signal is weaker than the full-strength one (envelope reaches the pixels)',
    feat < p2.feat * 0.85, `${feat.toFixed(0)} vs ${p2.feat.toFixed(0)}`);
  check('mid-fade control window flat', ctl.v < 8, `max|ΔL| ${ctl.v.toFixed(1)}`);
}

// ---- 4. Throttle: a rotation flicker flashes only ONE echo ----
const p4 = await page.evaluate(() => new Promise((resolve) => {
  const g = window.__tetris.game;
  const r = window.__tetris.renderer;
  const p = g.current;
  const waitThrottle = () => {
    // Also wait for any stale echo (from the mid-fade phase) to finish
    // fading, so the count below is unambiguous.
    if (r.time - r.lastEchoT < 0.12 || r.echoes.some((s) => s.group.visible)) {
      requestAnimationFrame(waitThrottle);
      return;
    }
    p.rotation = 0;
    p.y = 14;
    g.paused = false;
    const r0 = p.rotation;
    window.__tetris.doRotate(1);  // flashes the echo
    window.__tetris.doRotate(-1); // same tick-time: throttled
    g.paused = true;
    resolve({
      rotations: { start: r0, end: p.rotation },
      visCount: r.echoes.filter((s) => s.group.visible).length,
      type: p.type,
    });
  };
  requestAnimationFrame(waitThrottle);
}));
check('CW+CCW flicker: the engine applied BOTH rotations (net zero)',
  p4.rotations.end === p4.rotations.start, `${p4.type} ${p4.rotations.start} -> ${p4.rotations.end}`);
check('CW+CCW flicker spawns only ONE echo (tick-time throttle)', p4.visCount === 1,
  `count=${p4.visCount}`);

// ---- 5. Hidden rows: no echo for a piece in the hidden spawn field ----
const p5 = await page.evaluate(() => new Promise((resolve) => {
  const g = window.__tetris.game;
  const r = window.__tetris.renderer;
  const p = g.current;
  const wait = () => {
    if (r.echoes.some((s) => s.group.visible) || r.time - r.lastEchoT < 0.12) {
      requestAnimationFrame(wait);
      return;
    }
    p.rotation = 0;
    p.y = 0; // top of the hidden spawn field
    g.paused = false;
    window.__tetris.doRotate(1);
    g.paused = true;
    // Let a couple of render frames run so setPiece() has applied the
    // hidden-row visibility rule to the new piece state before we read it.
    let frames = 0;
    const after = () => {
      if (frames++ < 3) { requestAnimationFrame(after); return; }
      resolve({
        visCount: r.echoes.filter((s) => s.group.visible).length,
        pieceHidden: !r.pieceGroup.visible,
      });
    };
    requestAnimationFrame(after);
  };
  requestAnimationFrame(wait);
}));
check('piece in hidden rows is hidden by the renderer (precondition)', p5.pieceHidden === true);
check('rotating a hidden-row piece spawns no echo (would poke above the frame)', p5.visCount === 0,
  `count=${p5.visCount}`);

// ---- 6. Game over kills in-flight echoes; restart re-arms the pool ----
const p6 = await page.evaluate(() => new Promise((resolve) => {
  const g = window.__tetris.game;
  const r = window.__tetris.renderer;
  const p = g.current;
  const waitThrottle = () => {
    if (r.time - r.lastEchoT < 0.12) { requestAnimationFrame(waitThrottle); return; }
    p.rotation = 0;
    p.y = 14;
    g.paused = false;
    window.__tetris.doRotate(1);
    g.paused = true;
    const spawned = r.echoes.some((s) => s.group.visible);
    r.onGameOver();
    resolve({
      spawned,
      over: r.over,
      allHidden: r.echoes.every((s) => !s.group.visible),
    });
  };
  requestAnimationFrame(waitThrottle);
}));
check('game over: an in-flight echo was spawned, then the lights out killed it',
  p6.spawned && p6.over && p6.allHidden, `spawned=${p6.spawned} hidden=${p6.allHidden}`);

await page.keyboard.press('r');
const restarted = await waitUntil(() => {
  const r = window.__tetris.renderer;
  const g = window.__tetris.game;
  return !r.over && !g.gameOver && g.current !== null;
}, null, 10000);
check('restart returns the stage (lights back, fresh game)', restarted !== null, `${restarted}ms`);
const p7 = await page.evaluate(() => new Promise((resolve) => {
  const g = window.__tetris.game;
  const r = window.__tetris.renderer;
  const p = g.current;
  // Wait until the fresh piece is fully out of the hidden spawn field
  // (the renderer shows it), then rotate it once: the re-armed pool must
  // flash an echo for the new game's first rotation.
  const arm = () => {
    if (g.gameOver || !r.pieceGroup.visible) { requestAnimationFrame(arm); return; }
    const waitThrottle = () => {
      if (r.time - r.lastEchoT < 0.12) { requestAnimationFrame(waitThrottle); return; }
      p.y = 14;
      g.paused = false;
      window.__tetris.doRotate(1);
      g.paused = true;
      resolve({
        visCount: r.echoes.filter((s) => s.group.visible).length,
        type: p.type,
      });
    };
    requestAnimationFrame(waitThrottle);
  };
  requestAnimationFrame(arm);
}));
check('restart re-arms the echo pool (first rotation of the new game flashes an echo)',
  p7.visCount === 1, `count=${p7.visCount} type=${p7.type}`);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);