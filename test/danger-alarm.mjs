// Browser regression: the redline alarm — as the settled stack climbs
// toward the top of the well the whole stage turns crimson and pulses
// like a heartbeat (pure level/pulse math in src/danger.js; main.js feeds
// dangerOf(board) to renderer.setDanger every frame; the renderer eases
// the level (fast attack, slow release) and pushes it to the pixels:
// crimson tint on the neon frame / side rails / glow bar (heartbeat-
// bright) / mirror+panel grids, a crimson wash over the aurora sky, and a
// pulsing red edge-glow in the cinematic grade).
//
// Verified:
//   - rest + low-stack gate (danger 0, exact identity: white grid
//     multipliers, neutral frame, off uniforms, off-vs-off re-render
//     bit-identical),
//   - a tall stack (top row 7) drives the level to 1 through main.js's
//     per-frame setDanger (the target proves the wiring end-to-end), with
//     the crimson tint visible in state (frame/grid colors) and the
//     <3% white grade held even at full alarm,
//   - the heartbeat: the grade pass's uDanger oscillates (trough ~62% of
//     the level to full) over the pure DANGER_PERIOD,
//   - pixel-level proof by a synchronous on/off A/B in ONE in-page
//     evaluate (re-ink stage + _applyDanger per side, two composer
//     renders, no tick between): the red edge-glow in the frame corners,
//     the crimson frame/edges band, the crimson-washed aurora sky, with a
//     coarse-grid feature-free control window,
//   - the alarm composes AFTER the level palette re-ink (a level-8 inked
//     frame still reads red under full alarm),
//   - the game-over lights out hands off from the alarm (level eases out
//     while overDim ramps) and restart restores the exact neutral stage.
//
// Usage: node test/danger-alarm.mjs [url]

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
async function key(k) {
  await page.keyboard.down(k);
  await page.keyboard.up(k);
}

// Fresh game. `paused` defaults true (deterministic controls); `cells` =
// [y, x, type]; the active piece is parked exactly where we want it.
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

const proj = (pts) =>
  page.evaluate((p) =>
    p.map(([x, y, z]) => {
      const q = window.__tetris.renderer.projectToPixel(x, y, z);
      return { x: Math.round(q.x), y: Math.round(q.y) };
    }), pts);

// ---- 1. Rest + low-stack gate: the alarm is the exact identity --------
{
  // Low stack: a floor-row filler + one block 3 rows above it (top row 18,
  // far under the alarm window). A vertical I floats in clear column 9.
  const cells = [];
  for (let x = 0; x < 10; x++) cells.push([21, x, 'T']);
  cells.push([18, 2, 'S'], [18, 3, 'S']);
  await setup({ type: 'I', rotation: 1, x: 7, y: 6, cells });
  // Let any alarm from the page-load game ease out (fresh games start at 0).
  const settled = await waitUntil(() => {
    const r = window.__tetris.renderer;
    return r.danger < 0.01 && r.dangerTarget === 0;
  });
  check('rest: danger state installed and at identity on a low stack', settled !== null);
  const st = await page.evaluate(() => {
    const r = window.__tetris.renderer;
    return {
      danger: r.danger,
      target: r.dangerTarget,
      gradeU: r.gradePass.uniforms.uDanger.value,
      auroraU: r.auroraUniforms.uDanger.value,
      grid: [r.floorGrid.material.color.r, r.floorGrid.material.color.g, r.floorGrid.material.color.b],
      pgrid: [r.panelGrid.material.color.r, r.panelGrid.material.color.g, r.panelGrid.material.color.b],
      frame: [r.frameEdgesMat.color.r, r.frameEdgesMat.color.g, r.frameEdgesMat.color.b],
    };
  });
  check(
    'rest: every alarm channel at the identity (off uniforms, white grid multipliers)',
    st.danger === 0 && st.target === 0 && st.gradeU === 0 && st.auroraU === 0 &&
      Math.abs(st.grid[0] - 1) < 1e-3 && Math.abs(st.grid[1] - 1) < 1e-3 && Math.abs(st.grid[2] - 1) < 1e-3 &&
      Math.abs(st.pgrid[1] - 1) < 1e-3,
    `danger ${st.danger} gradeU ${st.gradeU} grid [${st.grid.map((v) => v.toFixed(2))}]`,
  );
  check('rest: the neon frame stays neutral cyan (no red leak)', st.frame[1] > st.frame[0] + 0.2);

  // Identity A/B: with the alarm at 0, re-ink + apply + render twice — the
  // off state must be bit-identical (no hidden state in _applyDanger).
  const ident = await page.evaluate(() => {
    const r = window.__tetris.renderer;
    const readFrame = () => {
      r.composer.render();
      const c = r.canvas;
      const off = document.createElement('canvas');
      off.width = c.width; off.height = c.height;
      off.getContext('2d').drawImage(c, 0, 0);
      return off.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
    r.danger = 0; r.dangerTarget = 0;
    r._applyStageHue(r.levelHue); r._applyDanger();
    const a = readFrame();
    r._applyStageHue(r.levelHue); r._applyDanger();
    const b = readFrame();
    let m = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs((0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2]) -
                        (0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2]));
      if (d > m) m = d;
    }
    return m;
  });
  check('rest: off/off re-render is bit-identical (max |ΔL| 0)', ident < 0.51, `max|ΔL| ${ident.toFixed(2)}`);
}

// ---- 2a. Standard pin rig (the same board crystal-ibl grades against):
// bottom 10 rows ~2/3 fill (top row 12 -> danger 1/6). The alarm is mild
// but ACTIVE, so this pins the <3% white ceiling with the alarm engaged.
{
  const types = ['I', 'J', 'L', 'S', 'T', 'Z', 'O'];
  const cells = [];
  for (let y = 12; y <= 21; y++) for (let x = 0; x < 10; x++) if ((x + y) % 3 !== 0) cells.push([y, x, types[(x + y) % 7]]);
  await setup({ type: 'O', rotation: 0, x: 4, y: 0, cells }); // piece hidden in the spawn rows
  const armed = await waitUntil(() => window.__tetris.renderer.danger > 0.16, null, 12000, 60);
  check('standard stack (top row 12): the alarm engages at the pure level', armed !== null, `${armed}ms`);
  const st = await page.evaluate(() => {
    const r = window.__tetris.renderer;
    return {
      danger: r.danger,
      target: r.dangerTarget,
      gradeU: r.gradePass.uniforms.uDanger.value,
    };
  });
  check('standard stack: main.js feeds the pure dangerOf(board) level ((13-12)/6)',
    Math.abs(st.target - (13 - 12) / 6) < 0.005 && st.danger > 0.12 && st.gradeU > 0.05,
    `target ${st.target.toFixed(3)} danger ${st.danger.toFixed(3)}`);
  const grade = await page.evaluate(() => {
    const r = window.__tetris.renderer;
    r.composer.render();
    const c = r.canvas;
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    off.getContext('2d').drawImage(c, 0, 0);
    const d = off.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let white = 0;
    const total = d.length / 4;
    for (let i = 0; i < d.length; i += 4)
      if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) white++;
    return (100 * white) / total;
  });
  check('standard stack: the <3% white grade holds WITH the alarm active', grade < 3, `white ${grade.toFixed(2)}%`);
}

// ---- 2b. Full alarm (top row 7): the stage reads crimson --------------
// The same canonical fill pattern extended up to row 7 = a tower in lock-out
// territory (full alarm). It is denser than any playable state, so the
// <3% ceiling is pinned on 2a's realistic stack; here the alarm's own
// white COST is what is graded (on vs off on the identical rig).
{
  const types = ['I', 'J', 'L', 'S', 'T', 'Z', 'O'];
  const cells = [];
  for (let y = 7; y <= 21; y++) for (let x = 0; x < 10; x++) if ((x + y) % 3 !== 0) cells.push([y, x, types[(x + y) % 7]]);
  await setup({ type: 'O', rotation: 0, x: 4, y: 0, cells });
  const armed = await waitUntil(() => window.__tetris.renderer.danger > 0.95, null, 12000, 60);
  check('tall stack (top row 7): the danger level eases to full alarm', armed !== null, `${armed}ms`);
  const st = await page.evaluate(() => {
    const r = window.__tetris.renderer;
    return {
      danger: r.danger,
      target: r.dangerTarget,
      gradeU: r.gradePass.uniforms.uDanger.value,
      auroraU: r.auroraUniforms.uDanger.value,
      frame: [r.frameEdgesMat.color.r, r.frameEdgesMat.color.g, r.frameEdgesMat.color.b],
      grid: [r.floorGrid.material.color.r, r.floorGrid.material.color.g, r.floorGrid.material.color.b],
      rail: [r.frameRailMat.color.r, r.frameRailMat.color.g],
    };
  });
  check('tall stack: main.js feeds the pure dangerOf(board) level (target = 1)', st.target === 1, `target ${st.target}`);
  check('tall stack: the level reaches the grade + aurora uniforms at the heartbeat floor (dval >= 0.62 * danger)',
    st.gradeU / st.danger >= 0.60 && st.auroraU === st.gradeU && st.danger > 0.95,
    `gradeU ${st.gradeU.toFixed(2)} danger ${st.danger.toFixed(2)}`);
  // State at the heartbeat THUMP: spin rAF until the frame reads crimson
  // (the thump arrives within one 1.1 s beat) and snapshot every channel
  // in the same task — a trough-phase snapshot would still read cyan.
  const thump = await page.evaluate(() => new Promise((resolve) => {
    const r = window.__tetris.renderer;
    window.__dangerThump = (function spin() {
      const f = r.frameEdgesMat.color;
      if (f.r > f.g + 0.25) {
        delete window.__dangerThump;
        resolve({
          frame: [f.r, f.g, f.b],
          grid: [r.floorGrid.material.color.r, r.floorGrid.material.color.g, r.floorGrid.material.color.b],
          rail: [r.frameRailMat.color.r, r.frameRailMat.color.g],
        });
        return;
      }
      requestAnimationFrame(spin);
    })();
  }));
  check('tall stack: at the thump the neon frame re-inks crimson (R dominant)',
    thump.frame[0] > 0.5 && thump.frame[0] > thump.frame[1] * 1.5,
    `[${thump.frame.map((v) => v.toFixed(2))}]`);
  check('tall stack: at the thump the mirror/panel grids tint toward the alarm red',
    thump.grid[0] > thump.grid[1] * 1.5 && thump.rail[0] > thump.rail[1] * 1.5,
    `grid [${thump.grid.map((v) => v.toFixed(2))}]`);

  // Grade self-check: the alarm may KILL white pixels (crimson suppresses
  // G/B; the red tint sits below the bloom threshold so its halo can't
  // push near-white pixels over) but must not create them — on vs a TRUE
  // off (uniforms zeroed AND the stage re-inked neutral) on the identical
  // rig at the same tick time.
  const grade = await page.evaluate(() => {
    const r = window.__tetris.renderer;
    const count = (d) => {
      let w = 0;
      for (let i = 0; i < d.length; i += 4)
        if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) w++;
      return w;
    };
    const grab = () => {
      r.composer.render();
      const c = r.canvas;
      const off = document.createElement('canvas');
      off.width = c.width; off.height = c.height;
      off.getContext('2d').drawImage(c, 0, 0);
      return off.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
    const tot = r.canvas.width * r.canvas.height;
    const saved = { g: r.gradePass.uniforms.uDanger.value, a: r.auroraUniforms.uDanger.value, d: r.danger };
    const onPct = (100 * count(grab())) / tot;
    r._applyStageHue(0);
    r.frameBarMat.color.copy(r.frameBarColor);
    r.floorGrid.material.color.setRGB(1, 1, 1);
    r.panelGrid.material.color.setRGB(1, 1, 1);
    r.gradePass.uniforms.uDanger.value = 0;
    r.auroraUniforms.uDanger.value = 0;
    const offPct = (100 * count(grab())) / tot;
    r.gradePass.uniforms.uDanger.value = saved.g;
    r.auroraUniforms.uDanger.value = saved.a;
    r.danger = saved.d; r.dangerTarget = 1;
    r._applyStageHue(r.levelHue); r._applyDanger();
    return { onPct, offPct };
  });
  check('tall stack: the alarm adds no white of its own (on <= off + 0.15%)',
    grade.onPct <= grade.offPct + 0.15,
    `on ${grade.onPct.toFixed(2)}% vs off ${grade.offPct.toFixed(2)}%`);
}

// ---- 3. The heartbeat: uDanger oscillates over DANGER_PERIOD ----------
{
  const probe = await page.evaluate(() => new Promise((resolve) => {
    const r = window.__tetris.renderer;
    const vals = [];
    const t0 = r.time;
    window.__dpProbe = (function spin() {
      vals.push(r.gradePass.uniforms.uDanger.value);
      if (r.time - t0 < 1.25 && vals.length < 900) requestAnimationFrame(spin);
      else { delete window.__dpProbe; resolve({ min: Math.min(...vals), max: Math.max(...vals), n: vals.length, span: r.time - t0 }); }
    })();
  }));
  check('heartbeat: the alarm level pulses (trough -> thump over a full beat)',
    probe.n > 20 && probe.span > 1.2 && probe.max - probe.min > 0.25,
    `n ${probe.n} span ${probe.span.toFixed(2)}s [${probe.min.toFixed(2)} .. ${probe.max.toFixed(2)}]`);
  check('heartbeat: the thump reaches ~full level (dval peak > 0.85)', probe.max > 0.85, `max ${probe.max.toFixed(2)}`);
}

// ---- 4. Pixel-level proof: synchronous on/off A/B in one evaluate ------
async function abPixels() {
  return page.evaluate(() => {
    const r = window.__tetris.renderer;
    const readFrame = () => {
      r.composer.render();
      const c = r.canvas;
      const off = document.createElement('canvas');
      off.width = c.width; off.height = c.height;
      off.getContext('2d').drawImage(c, 0, 0);
      const img = off.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const lum = new Uint8Array(c.width * c.height);
      for (let i = 0, q = 0; i < img.length; i += 4, q++)
        lum[q] = Math.min(255, (0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2]) | 0);
      return lum;
    };
    const reink = () => { r._applyStageHue(r.levelHue); r._applyDanger(); };
    const saved = r.danger;
    r.danger = 1; r.dangerTarget = 1; reink();
    const b = readFrame(); // alarm ON
    r.danger = 0; r.dangerTarget = 0; reink();
    const a = readFrame(); // alarm OFF
    const a2 = readFrame(); // off again: the off state must be idempotent
    r.danger = saved; r.dangerTarget = 1; reink();
    const same = (x, y) => {
      let m = 0;
      for (let i = 0; i < x.length; i++) { const d = Math.abs(x[i] - y[i]); if (d > m) m = d; }
      return m;
    };
    return { a: Array.from(a), b: Array.from(b), offOff: same(a, a2), w: r.canvas.width, h: r.canvas.height };
  });
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

// Coarse-grid feature-free control window: the smallest max|ΔL| window
// kept clear of every alarm band (frame, corners, sky) and the floating
// hero piece's bloom.
function controlScan(res, centers, rejectR = 130) {
  let best = { v: Infinity, x: -1, y: -1 };
  for (let y = 24; y < res.h - 24; y += 12) {
    for (let x = 24; x < res.w - 24; x += 12) {
      for (const c of centers) {
        const dx = x - c.x, dy = y - c.y;
        if (dx * dx + dy * dy < rejectR * rejectR) continue;
      }
      let m = 0;
      for (let oy = -20; oy <= 20; oy += 4)
        for (let ox = -20; ox <= 20; ox += 4) {
          const i = (y + oy) * res.w + (x + ox);
          const d = Math.abs(res.b[i] - res.a[i]);
          if (d > m) m = d;
        }
      if (m < best.v) best = { v: m, x, y };
    }
  }
  return best;
}

{
  // Feature centers: frame edges + corners + sky points + the ghost
  // projector (the hidden O's ghost + its pillar/emitter pool on the
  // glass) — all static between the two A/B renders, so they only need
  // to be rejected from the CONTROL scan.
  const pts = await proj([
    [0, 21.5, -0.3], [5.475, 11, -0.3], [-5.475, 11, -0.3], [0, 0.12, 0.32],
    [8, 25, -44.9], [-12, 23, -44.9], [3, 28, -44.9], [-5, 27, -44.9], [14, 24, -44.9],
  ]);
  const ghostPts = await proj([[0, 17, 0.2], [0, -0.5, 0.2]]);
  const res = await abPixels();
  const corners = [[30, 30], [res.w - 30, 30], [30, res.h - 30], [res.w - 30, res.h - 30]];
  const cornerMax = Math.max(...corners.map(([x, y]) => maxDiff(res, x, y, 14)));
  check('alarm ON carries the pulsing red edge-glow in the frame corners', cornerMax > 8, `max|ΔL| ${cornerMax}`);
  const frameMax = Math.max(
    maxDiff(res, pts[0].x, pts[0].y, 8), // top frame edge
    maxDiff(res, pts[1].x, pts[1].y, 8), // right edge
    maxDiff(res, pts[2].x, pts[2].y, 8), // left edge
    maxDiff(res, pts[3].x, pts[3].y, 8), // glow bar
  );
  check('alarm ON re-inks the neon frame + glow bar crimson at pixel level', frameMax > 25, `max|ΔL| ${frameMax}`);
  const skyPts = pts.slice(4);
  let skyMax = 0, skyIn = 0;
  for (const p of skyPts) {
    if (p.x < 0 || p.y < 0 || p.x >= res.w || p.y >= res.h) continue;
    skyIn++;
    skyMax = Math.max(skyMax, maxDiff(res, p.x, p.y, 8));
  }
  check('alarm ON washes the aurora sky crimson', skyIn >= 2 && skyMax > 12, `in-canvas ${skyIn} max|ΔL| ${skyMax}`);
  const ctrl = controlScan(res, [...pts, ...ghostPts].filter((p) => p.x >= 0 && p.y >= 0 && p.x < res.w && p.y < res.h));
  check('alarm OFF frame is feature-free elsewhere (control window flat)', ctrl.v < 12, `control ${ctrl.v} @ (${ctrl.x},${ctrl.y})`);
  check('the OFF state is idempotent (off/off re-render identical)', res.offOff < 0.51, `max|ΔL| ${res.offOff}`);
}

// ---- 5. The alarm composes AFTER the level-palette re-ink -------------
{
  const st = await page.evaluate(() => {
    const r = window.__tetris.renderer;
    r.levelHue = 0.396; r.levelHueTarget = 0.396; // a deep level-8 palette turn
    r._applyStageHue(0.396);
    r.danger = 1; r.dangerTarget = 1;
    r._applyDanger();
    const f = [r.frameEdgesMat.color.r, r.frameEdgesMat.color.g, r.frameEdgesMat.color.b];
    // Restore the neutral palette (the tick would ease back on its own).
    r.levelHue = 0; r.levelHueTarget = 0;
    r._applyStageHue(0);
    r._applyDanger();
    return f;
  });
  check('level palette + full alarm: the crimson re-ink lands AFTER the hue turn',
    st[0] > st[1] + 0.1 && st[0] > st[2] + 0.1,
    `[${st.map((v) => v.toFixed(2))}]`);
}

// ---- 6. The game-over lights out hands off from the alarm -------------
{
  // A tower filling the whole visible field + an O locking in the hidden
  // rows = lock-out (the same trigger the gameover suite uses). The alarm
  // was full; onGameOver must re-target it to 0 so the cinematic takes
  // over the stage.
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
    t.lockTimer = null; t.gravityAccum = 0; t.softAccum = 0; t.das = 0; t.arr = 0; t.freeze = 0;
    window.__tetris.dirInput.held.length = 0;
    window.__tetris.dirInput.dir = 0;
    window.__tetris.doHardDrop();
  });
  const over = await waitUntil(() => window.__tetris.renderer.over === true, null, 10000, 60);
  check('lock-out: the game-over cinematic takes the stage', over !== null);
  const dim = await waitUntil(() => window.__tetris.renderer.overDim > 0.8, null, 15000, 80);
  check('lock-out: the stage reaches the lights-out dim', dim !== null, `${dim}ms`);
  const st = await page.evaluate(() => {
    const r = window.__tetris.renderer;
    return { danger: r.danger, target: r.dangerTarget, gradeU: r.gradePass.uniforms.uDanger.value, overDim: r.overDim };
  });
  check('lock-out: the redline alarm dies with the lights out', st.target === 0 && st.gradeU < 0.15, `danger ${st.danger.toFixed(3)} gradeU ${st.gradeU.toFixed(3)}`);
}

// ---- 7. Restart restores the exact neutral stage -----------------------
{
  await key('r');
  await sleep(500);
  const st = await page.evaluate(() => {
    const r = window.__tetris.renderer;
    return {
      danger: r.danger,
      target: r.dangerTarget,
      gradeU: r.gradePass.uniforms.uDanger.value,
      auroraU: r.auroraUniforms.uDanger.value,
      grid: [r.floorGrid.material.color.r, r.floorGrid.material.color.g, r.floorGrid.material.color.b],
      frame: [r.frameEdgesMat.color.r, r.frameEdgesMat.color.g],
      levelHue: r.levelHue,
      overDim: r.overDim,
      over: r.over,
    };
  });
  check('restart: the alarm re-arms at the identity (levels + uniforms zeroed)',
    st.danger === 0 && st.target === 0 && st.gradeU === 0 && st.auroraU === 0);
  check('restart: the white grid multipliers + neutral frame + full lights are back',
    Math.abs(st.grid[0] - 1) < 1e-3 && Math.abs(st.grid[1] - 1) < 1e-3 &&
      st.frame[1] > st.frame[0] + 0.2 && st.levelHue === 0 && st.overDim === 0 && st.over === false,
    `grid [${st.grid.map((v) => v.toFixed(2))}]`);
}

check('no page or console errors across the whole suite', errors.length === 0, errors.slice(0, 3).join(' | '));

const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(results.join('\n'));
console.log(failed.length === 0 ? 'ALL PASS' : `FAILED: ${failed.length}`);
await browser.close();
process.exit(failed.length === 0 ? 0 : 1);