// Browser regression: the holographic hold + next-queue stage displays.
//
// The stage projects the held piece (left of the board) and the 3-deep
// next queue (right) as mini holo pieces in cradle rings — the same holo
// shader as the ghost faces — each display lit by a faint light pillar
// from the mirror floor and an emitter pool on the glass (both doubled by
// the Reflector), with a small caption. A hold swap pops the held piece
// in, flares the hold-side emitter and sends a small floor ripple in the
// piece's color; a queue shift pops the changed slots. Game over powers
// the displays down with the rest of the stage; restart re-arms them.
//
// Pixel verification: synchronous A/B captures — hide the display groups
// (or just one), composer.render(), restore, composer.render(), all inside
// ONE in-page evaluate. Because no tick() runs between the two renders,
// every uniform-driven effect (grain, aurora, camera sway) is bit-identical
// and cancels exactly; the diff is purely the hidden feature (+ its bloom
// halo). The emitter pools are A/B'd on the mirror floor with the aurora
// dimmed (uDim=1, restored after) so the additive pools can't clip against
// the saturated reflected sky. Engine-driven phases (hold swap, hard-drop
// queue shift) run inside a single synchronous in-page evaluate via
// __tetris.doHold / doHardDrop so no tick can fire between the state
// capture and the action.
//
// Usage: node test/holo-queue.mjs [url]

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
async function waitUntil(pred, arg, timeoutMs = 8000, pollMs = 50) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred, arg)) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

// Display geometry (world units) — must match renderer3d.js constants.
const HOLO_X = 6.0;
const HOLD_Y = 10.4;
const NEXT_MID_Y = 12.0;
const SKY_CTL = [0, 21.5, 0]; // above the board frame: static sky between sync renders

// Synchronous A/B: hide the given renderer members, render, restore,
// render — one in-page evaluate so grain/aurora/camera cancel exactly.
// dimAurora pulls the aurora curtains to 30% (uDim) for the capture so
// additive floor pools can't clip against the saturated reflected sky.
async function abGrab(hideKeys, dimAurora = false) {
  return page.evaluate((spec) => {
    const hide = spec.hide;
    const dim = spec.dim;
    const r = window.__tetris.renderer;
    const read = () => {
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
      return lum;
    };
    const save = {};
    for (const k of hide) save[k] = r[k].visible;
    let savedDim = 0;
    if (dim) { savedDim = r.auroraUniforms.uDim.value; r.auroraUniforms.uDim.value = 1; }
    for (const k of hide) r[k].visible = false;
    const a = read(); // feature hidden
    for (const k of hide) r[k].visible = save[k];
    const b = read(); // feature shown
    if (dim) r.auroraUniforms.uDim.value = savedDim;
    return { a, b, w: r.canvas.width, h: r.canvas.height };
  }, { hide: hideKeys, dim: dimAurora });
}

// Max per-pixel |ΔL| in a window around (px, py).
function maxDiff(res, px, py, half) {
  let m = 0;
  for (let dy = -half; dy <= half; dy += 2) {
    for (let dx = -half; dx <= half; dx += 2) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= res.w || y >= res.h) continue;
      const i = y * res.w + x;
      const d = Math.abs(res.b[i] - res.a[i]);
      if (d > m) m = d;
    }
  }
  return m;
}

// Project world points to canvas device pixels (renderer's live camera).
async function project(points) {
  return page.evaluate((pts) =>
    pts.map(([x, y, z]) => {
      const p = window.__tetris.renderer.projectToPixel(x, y, z);
      return { x: p.x, y: p.y };
    }), points);
}

// Freeze the engine so nothing locks/falls under the suite; the render
// loop keeps driving the renderer (pixel captures stay deterministic).
await page.evaluate(() => { window.__tetris.game.paused = true; });

// ---- 1. Initial state: empty hold cradle, next queue mirrors the engine ----
const s1 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const g = window.__tetris.game;
  const firstBox = r.holoNext[0].piece.children[0];
  return {
    holdType: r.holoHold.type,
    holdChildren: r.holoHold.piece.children.length,
    holdCradle: r.holoHold.cradle.visible,
    nextTypes: r.holoNext.map((s) => s.type),
    queue: g.queue.slice(0, 3),
    holdGroup: r.holoHoldGroup.visible,
    nextGroup: r.holoNextGroup.visible,
    holdBeamOp: r.holoHoldBeam.material.opacity,
    nextBeamOp: r.holoNextBeam.material.opacity,
    holdEmitterY: r.holoHoldEmitter.position.y,
    holdEmitterX: r.holoHoldEmitter.position.x,
    nextEmitterX: r.holoNextEmitter.position.x,
    slotX: r.holoNext.map((s) => s.x),
    slotY: r.holoNext.map((s) => s.y),
    boxIsHolo: firstBox ? firstBox.material.isShaderMaterial : false,
  };
});
check('hold display starts empty (bare cradle, no piece)',
  s1.holdType === null && s1.holdChildren === 0 && s1.holdCradle === true,
  `type=${s1.holdType} children=${s1.holdChildren}`);
check('next slots mirror the engine queue (all 3)',
  s1.nextTypes.length === 3 && s1.nextTypes.every((t, i) => t === s1.queue[i] && t !== null),
  `slots [${s1.nextTypes}] vs queue [${s1.queue}]`);
check('both display groups are on stage', s1.holdGroup === true && s1.nextGroup === true);
check('display light pillars are alive (opacity driven in tick)',
  s1.holdBeamOp > 0.02 && s1.nextBeamOp > 0.02,
  `hold ${s1.holdBeamOp.toFixed(3)} next ${s1.nextBeamOp.toFixed(3)}`);
check('display pieces use the holo shader', s1.boxIsHolo === true);
check('emitter pools sit on the floor under the display columns',
  Math.abs(s1.holdEmitterX - -HOLO_X) < 0.01 && Math.abs(s1.nextEmitterX - HOLO_X) < 0.01 &&
  Math.abs(s1.holdEmitterY + 0.505) < 0.01,
  `hold (${s1.holdEmitterX},${s1.holdEmitterY}) next x=${s1.nextEmitterX}`);
check('next slots are stacked down the right column',
  s1.slotX.every((x) => Math.abs(x - HOLO_X) < 0.01) &&
  s1.slotY[0] > s1.slotY[1] && s1.slotY[1] > s1.slotY[2],
  `x [${s1.slotX}] y [${s1.slotY}]`);

// ---- 2. Pixel A/B: both displays hidden between two sync renders ----
const abBoth = await abGrab(['holoHoldGroup', 'holoNextGroup']);
const pts = await project([[-HOLO_X, HOLD_Y, 0.4], [HOLO_X, NEXT_MID_Y, 0.4], SKY_CTL]);
const holdD = maxDiff(abBoth, Math.round(pts[0].x), Math.round(pts[0].y), 42);
const nextD = maxDiff(abBoth, Math.round(pts[1].x), Math.round(pts[1].y), 42);
const ctlD = maxDiff(abBoth, Math.round(pts[2].x), Math.round(pts[2].y), 30);
check('hold display renders on screen (A/B diff in its column)', holdD > 12,
  `max|ΔL| ${holdD.toFixed(0)}`);
check('next display renders on screen (A/B diff in its column)', nextD > 12,
  `max|ΔL| ${nextD.toFixed(0)}`);
check('far sky control is flat (sync renders cancel background)', ctlD < 8,
  `max|ΔL| ${ctlD.toFixed(1)}`);

// ---- 3. Hold swap: the held piece pops into the display, queue shifts ----
// One synchronous in-page evaluate: capture pre-state, run the SAME hold
// entry point the 'c' key uses, capture post-state — no tick can fire in
// between, so no lock can steal the current piece out from under the test.
const hp = await page.evaluate(() => {
  const g = window.__tetris.game;
  const pre = { type: g.current.type, canHold: g.canHold, queue: g.queue.slice(0, 4) };
  g.paused = false; // holdPiece/lockPiece reject while paused
  window.__tetris.doHold();
  const post = {
    held: g.held,
    canHold: g.canHold,
    current: g.current.type,
    queue: g.queue.slice(0, 4),
  };
  g.paused = true;
  return { pre, post };
});
check('hold swap stores the current piece in hold', hp.pre.canHold && hp.post.held === hp.pre.type,
  `held=${hp.post.held} (was current ${hp.pre.type})`);
check('hold swap spawns the first next piece', hp.post.current === hp.pre.queue[0],
  `current=${hp.post.current} (was next ${hp.pre.queue[0]})`);
check('hold swap advances the queue (new head = old second)',
  hp.post.queue[0] === hp.pre.queue[1], `new [${hp.post.queue}]`);
check('hold is locked out until the next drop', hp.post.canHold === false);
const syncHold = await waitUntil(
  (held) => {
    const r = window.__tetris.renderer;
    const g = window.__tetris.game;
    return r.holoHold.type === held && r.holoNext[0].type === g.queue[0];
  },
  hp.post.held,
  8000,
);
const s3 = await page.evaluate((held) => {
  const r = window.__tetris.renderer;
  const g = window.__tetris.game;
  return {
    holdType: r.holoHold.type,
    holdChildren: r.holoHold.piece.children.length,
    ping: r.lastHoloPing ? { wx: r.lastHoloPing.wx, type: r.lastHoloPing.type } : null,
    nextSync: r.holoNext.every((s, i) => s.type === g.queue[i]),
  };
}, hp.post.held);
check('hold display shows the swapped piece', syncHold !== null && s3.holdType === hp.post.held &&
  s3.holdChildren > 0, `type=${s3.holdType} children=${s3.holdChildren} in ${syncHold}ms`);
check('hold swap pinged the hold side with the piece', !!s3.ping &&
  Math.abs(s3.ping.wx - -HOLO_X) < 0.01 && s3.ping.type === hp.post.held,
  `ping=${s3.ping ? `(${s3.ping.wx},${s3.ping.type})` : 'none'}`);
check('next display followed the queue shift', s3.nextSync === true);

// Pixel A/B of the hold display ALONE: the next display is still visible
// in both frames, so its column is a same-frame spatial control.
const abHold = await abGrab(['holoHoldGroup']);
const holdD2 = maxDiff(abHold, Math.round(pts[0].x), Math.round(pts[0].y), 42);
const nextCtl = maxDiff(abHold, Math.round(pts[1].x), Math.round(pts[1].y), 42);
check('hold display pixels isolated by A/B (its column lights up)', holdD2 > 12,
  `max|ΔL| ${holdD2.toFixed(0)}`);
check('next-column control flat while only the hold display is toggled', nextCtl < 8,
  `max|ΔL| ${nextCtl.toFixed(1)}`);

// ---- 4. A second hold on the same drop is rejected (engine + display) ----
const hp2 = await page.evaluate(() => {
  const g = window.__tetris.game;
  const before = g.held;
  g.paused = false;
  window.__tetris.doHold();
  g.paused = true;
  return { before, after: g.held, canHold: g.canHold };
});
check('second hold on the same drop is a no-op', hp2.after === hp2.before && hp2.canHold === false,
  `held=${hp2.after} canHold=${hp2.canHold}`);

// ---- 5. Emitter pool on the mirror glass (aurora dimmed so it can't clip) ----
const abEm = await abGrab(['holoNextEmitter'], true);
const [em] = await project([[HOLO_X, -0.505, 0.15]]);
{
  const px = Math.round(em.x), py = Math.round(em.y);
  let best = { v: -1, dx: 0, dy: 0 };
  for (let dy = 4; dy <= 52; dy += 2) {
    for (let dx = -44; dx <= 44; dx += 2) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= abEm.w || y >= abEm.h) continue;
      const i = y * abEm.w + x;
      const d = abEm.b[i] - abEm.a[i]; // pool shown vs hidden
      if (d > best.v) best = { v: d, dx, dy };
    }
  }
  check('next-side emitter pool lights the mirror floor', best.v > 6,
    `+${best.v} lum at dx ${best.dx}, dy ${best.dy}`);
}

// ---- 6. Hard drop: the next display follows the spawn ----
const dd = await page.evaluate(() => {
  const g = window.__tetris.game;
  const pre = { q0: g.queue[0], q1: g.queue[1] };
  g.paused = false;
  window.__tetris.doHardDrop();
  g.paused = true;
  return { pre, post: { q0: g.queue[0], current: g.current.type } };
});
check('hard drop advances the queue (new head = old second, not old head)',
  dd.post.q0 === dd.pre.q1 && dd.post.q0 !== dd.pre.q0,
  `queue head ${dd.pre.q0} -> ${dd.post.q0}`);
const syncDrop = await waitUntil(
  (q0) => {
    const r = window.__tetris.renderer;
    const g = window.__tetris.game;
    return r.holoNext.every((s, i) => s.type === g.queue[i]);
  },
  dd.post.q0,
  8000,
);
check('next display followed the hard-drop spawn', syncDrop !== null, `${syncDrop}ms`);

// ---- 7. Game over powers the displays down with the stage ----
await page.evaluate(() => {
  const g = window.__tetris.game;
  g.paused = false;
  window.__tetris.renderer.onGameOver();
});
const s7 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  return { h: r.holoHoldGroup.visible, n: r.holoNextGroup.visible, over: r.over };
});
check('game over hides both display groups', s7.over === true && s7.h === false && s7.n === false,
  `hold=${s7.h} next=${s7.n}`);

// ---- 8. Restart re-arms the displays on the fresh stage ----
await page.keyboard.press('r');
const s8 = await waitUntil(
  () => {
    const r = window.__tetris.renderer;
    const g = window.__tetris.game;
    return r.holoHoldGroup.visible && r.holoNextGroup.visible && r.holoHold.type === null &&
      r.holoNext[0].type === g.queue[0] && r.holoNext[0].type !== null;
  },
  null,
  10000,
);
const s8b = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const g = window.__tetris.game;
  return {
    hold: r.holoHold.type,
    nextSync: r.holoNext.every((s, i) => s.type === g.queue[i]),
  };
});
check('restart re-arms the displays (hold empty, queue repopulated)',
  s8 !== null && s8b.hold === null && s8b.nextSync === true, `${s8}ms`);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);