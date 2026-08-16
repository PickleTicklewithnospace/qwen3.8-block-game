// Browser regression: the stardust wake — the active piece sheds
// piece-colored stardust as it descends (pure accumulator in
// src/fall-dust.js: every WAKE_STEP of rendered downward motion sheds a
// mote; upward motion drains the bank; hard drops shed nothing because
// the fresh spawn that follows jumps the target back up).
//
// Verified:
//   - state installation + a grounded piece sheds nothing (bank idle),
//   - hidden-row pieces bank descent WITHOUT shedding (visibility gate),
//     and shed the banked burst the moment they cross into the field,
//   - a falling piece sheds motes in the piece's crystal hue (pool
//     signature probe: gravity-0, R < 1.4, B < 1.7 — safe against every
//     other suite's spawner filters), proven at PIXEL level by a
//     synchronous A/B that hides ONLY the dust slots between two renders
//     (band over the live motes' projected bounding box vs a
//     coarse-grid clean-window control),
//   - a grounded (paused) piece sheds nothing and live motes expire,
//   - a hard drop sheds no dust (bank drained by the post-drop spawn),
//   - the game-over lights out KILLS in-flight motes and blocks new
//     ones; restart re-arms the bank (counter back to 0).
//
// Usage: node test/fall-dust.mjs [url]

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
async function waitUntil(pred, arg, timeoutMs = 8000, pollMs = 25) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred, arg)) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

// Fresh game. `paused` defaults true (deterministic controls); `cells` =
// [y,x,type]. The active piece is parked exactly where we want it.
async function setup(spec) {
  return page.evaluate((s) => {
    const g = window.__tetris.game;
    g.gameOver = false;
    g.paused = s.paused !== false;
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

const key = (k, type = 'keydown') =>
  page.evaluate(
    ([k, t]) => window.dispatchEvent(new KeyboardEvent(t, { key: k })),
    [k, type],
  );

// Live stardust motes in the shared particle pool: the gravity-0
// signature no other spawner writes (embers 2.1, meteor sparks 13,
// line-clear/lock bursts 16).
const liveDust = () =>
  page.evaluate(() => {
    const r = window.__tetris.renderer;
    let n = 0;
    for (let i = 0; i < r.pCount; i++)
      if (r.pLife[i] > 0 && r.pGrav[i] < 1) n++;
    return n;
  });

// Node-side poll over liveDust (the count can't cross the evaluate bridge
// inside a serialized in-page predicate).
async function waitDust(predFn, timeoutMs = 8000, pollMs = 100) {
  const t0 = Date.now();
  for (;;) {
    if (predFn(await liveDust())) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

// ---- 0. State installation + a grounded piece sheds nothing ------------
{
  const st = await page.evaluate(() => {
    const r = window.__tetris.renderer;
    return {
      hasWake: !!r.wake && typeof r.wake.acc === 'number' && 'lastY' in r.wake,
      motes: r.wakeMotes,
    };
  });
  check('wake state installed (accumulator + lastY + shed counter)', st.hasWake, `motes so far ${st.motes}`);

  // Park the O grounded on a floor-row filler (paused: no gravity, no
  // lock), then let any in-flight motes from the initial auto-fall expire.
  await setup({ type: 'O', rotation: 0, x: 4, y: 19, level: 1, cells: [[21, 0, 'T'], [21, 1, 'T'], [21, 2, 'T'], [21, 3, 'T'], [21, 4, 'T'], [21, 5, 'T'], [21, 6, 'T'], [21, 7, 'T'], [21, 8, 'T'], [21, 9, 'T']] });
  const expired = await waitDust((n) => n === 0, 8000, 100);
  check('in-flight motes expire on their own (nothing keeps resupplying)', expired !== null, `${expired}ms`);
  const b0 = await page.evaluate(() => window.__tetris.renderer.wakeMotes);
  await sleep(450);
  const b1 = await page.evaluate(() => window.__tetris.renderer.wakeMotes);
  check('grounded piece sheds nothing (no descent, bank idle)', b0 === b1, `motes ${b0} -> ${b1}`);
}

// ---- 1. Hidden rows: bank descent without shedding ----------------------
await setup({ type: 'T', rotation: 0, x: 4, y: 0, level: 3, paused: false });
await waitUntil(() => window.__tetris.renderer.pieceGroup.visible === false, null, 5000);
{
  const h0 = await page.evaluate(() => ({
    m: window.__tetris.renderer.wakeMotes,
    a: window.__tetris.renderer.wake.acc,
    v: window.__tetris.renderer.pieceGroup.visible,
  }));
  check('piece starts in the hidden rows (not rendered)', h0.v === false);
  await sleep(900); // >= one gravity step while hidden
  const h1 = await page.evaluate(() => ({
    m: window.__tetris.renderer.wakeMotes,
    a: window.__tetris.renderer.wake.acc,
    v: window.__tetris.renderer.pieceGroup.visible,
  }));
  check('hidden piece banks descent without shedding (visibility gate)',
    h1.m === h0.m, `motes ${h0.m} -> ${h1.m} (bank ${h0.a.toFixed(2)} -> ${h1.a.toFixed(2)})`);
  check('hidden piece actually banked fall distance in the accumulator', h1.a > 0.1, `bank ${h1.a.toFixed(2)}`);
  const vis = await waitUntil(() => window.__tetris.renderer.pieceGroup.visible === true, null, 8000);
  check('piece crosses into the visible field', vis !== null, `${vis}ms`);
  // The burst sheds on the very frame the piece becomes visible (setPiece
  // before tick in one frame), so by the time the poll observes visible the
  // shed has already happened.
  const burstM = await page.evaluate(() => window.__tetris.renderer.wakeMotes);
  check('the banked burst sheds the moment the piece becomes visible', burstM > h1.m,
    `motes ${h1.m} -> ${burstM}`);
}

// ---- 2. Falling piece sheds piece-colored stardust (pixel A/B) ----------
await setup({ type: 'T', rotation: 0, x: 4, y: 5, level: 5, paused: false });
await waitUntil(() => window.__tetris.renderer.pieceGroup.visible === true, null, 8000);
{
  const ab = await page.evaluate(async () => {
    const r = window.__tetris.renderer;
    const g = window.__tetris.game;
    const spin = (n) =>
      new Promise((res) => {
        let k = 0;
        const f = () => (++k >= n ? res() : requestAnimationFrame(f));
        f();
      });
    const keydown = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
    const keyup = (k) => window.dispatchEvent(new KeyboardEvent('keyup', { key: k }));
    const dustIdx = () => {
      const out = [];
      for (let i = 0; i < r.pCount; i++)
        if (r.pLife[i] > 0 && r.pGrav[i] < 1) out.push(i);
      return out;
    };

    await spin(2);
    const before = r.wakeMotes;
    // 4 rows in one task: the next tick sheds the whole bank at once.
    for (let i = 0; i < 4; i++) keydown('ArrowDown');
    keyup('ArrowDown'); // stop the soft-drop repeat (gravity still runs)

    // Wait for the shed motes to be alive (min 300ms so a tick ran).
    const t0 = performance.now();
    let idx = [];
    for (let k = 0; k < 500; k++) {
      await new Promise((res) => requestAnimationFrame(res));
      idx = dustIdx();
      if (idx.length >= 5 && performance.now() - t0 > 300) break;
    }
    const after = r.wakeMotes;
    // Signature audit over every live mote: gravity 0, probe-safe bases,
    // and the piece's own hue (T purple: B > R > G).
    let sig = idx.length > 0;
    for (const i of idx) {
      const R = r.pBase[i * 3], G = r.pBase[i * 3 + 1], B = r.pBase[i * 3 + 2];
      if (r.pGrav[i] < 0 || r.pGrav[i] > 1) sig = false;
      if (R >= 1.4 || B >= 1.7) sig = false;
      if (!(B > R && R > G - 1e-6)) sig = false;
    }
    const saved = idx.map((i) => ({
      x: r.pPos[i * 3], y: r.pPos[i * 3 + 1], z: r.pPos[i * 3 + 2],
      cr: r.pCol[i * 3], cg: r.pCol[i * 3 + 1], cb: r.pCol[i * 3 + 2],
    }));

    // Synchronous A/B: hide ONLY the dust slots between two renders.
    const pa = r.particles.geometry.attributes.position;
    const ca = r.particles.geometry.attributes.color;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      r.pPos[i * 3 + 1] = -9999;
      r.pCol[i * 3] = 0; r.pCol[i * 3 + 1] = 0; r.pCol[i * 3 + 2] = 0;
    }
    pa.needsUpdate = true; ca.needsUpdate = true;
    r.composer.render();
    const c = r.canvas;
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    const octx = off.getContext('2d');
    const snap = () => {
      octx.clearRect(0, 0, off.width, off.height);
      octx.drawImage(c, 0, 0);
      return octx.getImageData(0, 0, off.width, off.height).data;
    };
    const A = snap();
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k]; const s = saved[k];
      r.pPos[i * 3] = s.x; r.pPos[i * 3 + 1] = s.y; r.pPos[i * 3 + 2] = s.z;
      r.pCol[i * 3] = s.cr; r.pCol[i * 3 + 1] = s.cg; r.pCol[i * 3 + 2] = s.cb;
    }
    pa.needsUpdate = true; ca.needsUpdate = true;
    r.composer.render();
    const B = snap();
    const lum = (img, x, y) => {
      const i = (y * c.width + x) * 4;
      return 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
    };

    // Band: bounding box of the motes' projected positions + margin.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, proj = 0;
    for (const s of saved) {
      const q = r.projectToPixel(s.x, s.y, 0.2);
      if (q.x < 0 || q.y < 0 || q.x >= c.width || q.y >= c.height) continue;
      proj++;
      const px = Math.round(q.x), py = Math.round(q.y);
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
    }
    if (proj < 3) return { n: idx.length, before, after, sig, bandMax: 0, ctlMax: 0, proj };
    const M = 40;
    const bx0 = Math.max(0, x0 - M), bx1 = Math.min(c.width - 1, x1 + M);
    const by0 = Math.max(0, y0 - M), by1 = Math.min(c.height - 1, y1 + M);
    let bandMax = 0;
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        const d = Math.abs(lum(A, x, y) - lum(B, x, y));
        if (d > bandMax) bandMax = d;
      }
    // Control: coarse grid scan for the cleanest window outside the band's
    // bloom halo (reject anything within 56 px of the band rect).
    let ctlMax = Infinity;
    for (let wy = 20; wy + 60 < c.height; wy += 60) {
      for (let wx = 20; wx + 40 < c.width; wx += 40) {
        if (wx + 40 > bx0 - 56 && wx < bx1 + 56 && wy + 60 > by0 - 56 && wy < by1 + 56) continue;
        let m = 0;
        for (let y = wy; y < wy + 60; y += 4)
          for (let x = wx; x < wx + 40; x += 4) {
            const d = Math.abs(lum(A, x, y) - lum(B, x, y));
            if (d > m) m = d;
          }
        if (m < ctlMax) ctlMax = m;
      }
    }
    if (!isFinite(ctlMax)) ctlMax = 0;
    return { n: idx.length, before, after, sig, bandMax, ctlMax, proj };
  });
  check('falling piece shed motes (shed counter advanced)', ab.after > ab.before + 4,
    `motes ${ab.before} -> ${ab.after}, ${ab.n} live at capture`);
  check('live motes carry the probe-safe signature (grav 0, R<1.4, B<1.7) in the piece hue (B>R>G)',
    ab.sig === true, `n=${ab.n}`);
  check('stardust is visible on screen (A/B over the motes band)', ab.bandMax > 20,
    `bandMax=${ab.bandMax?.toFixed(1)}`);
  check('...and it is the dust, not the stage (clean window stays flat)', ab.ctlMax < 12,
    `ctlMax=${ab.ctlMax?.toFixed(1)}`);
}

// ---- 3. Grounded piece: no shedding, motes expire ------------------------
{
  // Drop the piece to the floor (40 one-shot soft drops) and freeze the
  // engine so the lock delay can't consume it mid-test.
  await page.evaluate(() => {
    const g = window.__tetris.game;
    const keydown = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
    for (let i = 0; i < 40; i++) keydown('ArrowDown');
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' }));
    g.paused = true;
  });
  const g0 = await page.evaluate(() => window.__tetris.renderer.wakeMotes);
  await sleep(500);
  const g1 = await page.evaluate(() => window.__tetris.renderer.wakeMotes);
  check('grounded (paused) piece sheds nothing', g0 === g1, `motes ${g0} -> ${g1}`);
  const expired = await waitDust((n) => n === 0, 8000, 100);
  check('last motes drift away and fade (pool clean)', expired !== null, `${expired}ms`);
}

// ---- 4. A hard drop sheds no dust (bank drained by the spawn jump) -------
await setup({ type: 'O', rotation: 0, x: 4, y: 2, level: 3, paused: false });
await waitUntil(() => window.__tetris.renderer.pieceGroup.visible === true, null, 8000);
{
  const hd = await page.evaluate(() => {
    const g = window.__tetris.game;
    const r = window.__tetris.renderer;
    const b = r.wakeMotes;
    // Freeze the engine, then thaw + hard drop in the same task: no
    // gravity step can interleave between the baseline and the drop.
    g.paused = true;
    g.paused = false;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    return b;
  });
  await sleep(450);
  const hd2 = await page.evaluate(() => ({
    m: window.__tetris.renderer.wakeMotes,
    vis: window.__tetris.renderer.pieceGroup.visible,
  }));
  check('hard drop sheds no dust (fresh spawn jumps the target up, draining the bank)',
    hd2.m === hd, `motes ${hd} -> ${hd2.m}`);
  check('...while the next piece is still hidden (the gate holds, not an artifact)',
    hd2.vis === false);
}

// ---- 5. Lights out kills in-flight motes; restart re-arms ----------------
await setup({ type: 'T', rotation: 0, x: 4, y: 6, level: 3, paused: false });
await waitUntil(() => window.__tetris.renderer.pieceGroup.visible === true, null, 8000);
{
  await key('ArrowDown');
  await key('ArrowDown', 'keyup');
  const lit = await waitDust((n) => n >= 4, 8000, 100);
  check('game-over phase: motes are in flight before the lights out', lit !== null, `${lit}ms`);
  const kill = await page.evaluate(() => {
    const r = window.__tetris.renderer;
    const g = window.__tetris.game;
    const live = () => {
      let n = 0;
      for (let i = 0; i < r.pCount; i++)
        if (r.pLife[i] > 0 && r.pGrav[i] < 1) n++;
      return n;
    };
    const before = live();
    g.gameOver = true; // stop the game loop from driving new piece state
    r.onGameOver(); // the lights out
    const after = live();
    return { before, after, over: r.over };
  });
  check('lights out kills the in-flight stardust (synchronous)',
    kill.before > 0 && kill.after === 0 && kill.over === true,
    `live ${kill.before} -> ${kill.after}`);
  const dim = await waitUntil(
    () => window.__tetris.renderer.overDim > 0.3,
    null,
    8000,
  );
  check('mid-ramp: no new motes shed while the lights are out', dim !== null, `${dim}ms`);
  await sleep(500);
  const stayed = await liveDust();
  check('still clean 500ms into the ramp (emission gate holds)', stayed === 0, `live ${stayed}`);

  await page.keyboard.press('r');
  const rearm = await waitUntil(
    () => {
      const r = window.__tetris.renderer;
      return r.wakeMotes === 0 && r.wake.lastY !== null;
    },
    null,
    8000,
  );
  check('restart re-arms the wake (counter 0, tracking the fresh piece)', rearm !== null, `${rearm}ms`);
  await sleep(300);
  const fresh = await page.evaluate(() => window.__tetris.renderer.wakeMotes);
  check('fresh (hidden) piece sheds nothing after restart', fresh === 0, `motes ${fresh}`);
}

// ---- errors ----------------------------------------------------------------
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);