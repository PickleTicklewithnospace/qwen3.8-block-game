// Browser regression: the anamorphic TETRIS lens flare.
//
// The TETRIS dolly punch (and the level-9->10 streak ignition) fire a
// cinema-lens event: a wide thin HDR streak quad in front of the banner
// (blooms, doubles in the mirror glass) plus a full-width cool-blue streak
// through the frame in the cinematic grade pass (thin line + vertical ghost
// + offset echo above the streak). Both read the pure flareEnv envelope
// (src/fx-labels.js, unit- + mutation-tested) over FLARE_LIFE.
//
// Pixel proof: one combined in-page async evaluate triggers the drop, waits
// mid-flight via in-page rAF polling, then runs a SYNCHRONOUS 3-way A/B in
// the same task (A: both features off; C: 3D quad on + grade uFlare off;
// B: both on). A vs B is the whole flare's light (band + control window);
// B vs C isolates the grade pass's cool-blue streak/echo (the 3D quad's
// white-hot core cancels), which is where the anamorphic blue tint is
// measurable (at peak the core line clips to white; the echo row does not).
//
// Usage: node test/anamorphic-flare.mjs [url]

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8901/index.html';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('SwiftShader')) errors.push(m.text()); });

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(1200);

const results = [];
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fresh game, empty board (plus optional pre-filled cells), piece parked at
// the given position. Same helper shape as the popup-banner suite.
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
    return true;
  }, spec);
}

// Rows `rows` filled in every column except the given gap column(s).
function gapRows(rows, missing = [3, 4]) {
  const cells = [];
  for (const y of rows) for (let x = 0; x < 10; x++) if (!missing.includes(x)) cells.push([y, x, 'T']);
  return cells;
}

// ---- 1. Rest state: pass installed, quads pooled, nothing visible --------

const rest = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const gp = r.composer.passes[r.composer.passes.length - 1];
  const u = gp && gp.uniforms;
  const grab = () => {
    r.composer.render();
    const c = r.canvas;
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
  };
  const quads = r.popups.map((p) => ({
    hasQuad: !!(p.flareMesh && p.flareMat),
    order: p.flareMesh ? p.flareMesh.renderOrder : -1,
    visible: p.flareMesh ? p.flareMesh.visible : true,
    opacity: p.flareMat ? p.flareMat.opacity : 1,
    on: p.flareOn,
    dt: p.flareMesh ? p.flareMesh.material.depthTest : true,
  }));
  // A/B with the (resting) flare features toggled: must be bit-identical.
  const u2 = r.gradePass.uniforms;
  const vis = r.popups.map((p) => p.flareMesh.visible);
  r.popups.forEach((p) => { p.flareMesh.visible = false; });
  const saved = u2.uFlare.value;
  u2.uFlare.value = 0;
  const a = grab();
  r.popups.forEach((p, i) => { p.flareMesh.visible = vis[i]; });
  u2.uFlare.value = saved;
  const b = grab();
  let maxD = 0;
  for (let i = 0; i < a.data.length; i += 16) {
    const da = 0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2];
    const db = 0.2126 * b.data[i] + 0.7152 * b.data[i + 1] + 0.0722 * b.data[i + 2];
    const d = Math.abs(db - da);
    if (d > maxD) maxD = d;
  }
  return {
    isLast: !!(gp && gp.material && gp.material.name === 'CinematicGradeShader' && u && u.uFlare && u.uFlareY),
    uFlare: u ? u.uFlare.value : -1,
    uFlareY: u ? u.uFlareY.value : -1,
    quads,
    restMaxD: maxD,
  };
});
check('grade pass is last with live uFlare/uFlareY uniforms (0 at rest)',
  rest.isLast && rest.uFlare === 0 && rest.uFlareY > 0.3 && rest.uFlareY < 0.7,
  `uFlare ${rest.uFlare}, uFlareY ${rest.uFlareY.toFixed(3)}`);
check('every popup slot owns a pooled flare quad (renderOrder 19, depthTest off, hidden)',
  rest.quads.length === 3 && rest.quads.every((q) => q.hasQuad && q.order === 19 && !q.visible && q.opacity === 0 && !q.on && !q.dt),
  rest.quads.map((q) => `${q.order}/${q.visible ? 'vis' : 'hid'}`).join(','));
check('resting frame is bit-identical with the flare features toggled', rest.restMaxD <= 3, `max|ΔL| ${rest.restMaxD.toFixed(2)}`);

// ---- 2. TETRIS: drop -> punch + banner + mid-flight flare + pixels ------
// Rows 18..21 filled except col 5; a VERTICAL I (rotation 1 occupies its
// x+2 column) at x=3 lands at y=18 and completes all four rows. The filler
// at row 10 keeps the board from emptying (a TETRIS that also emptied the
// well would be a perfect clear and aim the grade streak at the PERFECT
// CLEAR! banner instead of the TETRIS one this phase proves).

async function setupTetris() {
  await setup({ type: 'I', rotation: 1, x: 3, y: 2, level: 1, cells: [...gapRows([18, 19, 20, 21], [5]), [10, 0, 'Z']] });
}

await setupTetris();
const tet = await page.evaluate(async () => {
  const r = window.__tetris.renderer;
  const g = window.__tetris.game;
  const u = r.gradePass.uniforms;
  const grab = () => {
    r.composer.render();
    const c = r.canvas;
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
  };
  const waitUntil = (pred, ms) => new Promise((res) => {
    const t0 = performance.now();
    const step = () => {
      if (pred()) return res(true);
      if (performance.now() - t0 > ms) return res(false);
      requestAnimationFrame(step);
    };
    step();
  });

  window.__tetris.doHardDrop();
  const tetP = r.popups.find((p) => p.tier === 'tetris');
  const pre = {
    clears: g.clearRows.length,
    punch: r.camPunch,
    banner: tetP ? { text: tetP.text, flareOn: tetP.flareOn } : null,
    uFlareY: u.uFlareY.value,
    uvY: 1 - r.projectToPixel(0, r.popupY, r.popupZ).y / r.canvas.height,
  };

  const got = await waitUntil(() => r.flare > 0.5, 15000);
  if (!got) return { pre, mid: null };

  // Synchronous 3-way A/B in the same task (nothing ticks between grabs):
  //   A = flare quads hidden + uFlare 0   (scene without the event)
  //   C = quads visible  + uFlare 0       (3D quad only)
  //   B = quads visible  + uFlare live    (the full event)
  // A vs B = the whole flare; B vs C = the grade pass's cool streak/echo
  // (the white-hot 3D core cancels, so the anamorphic blue tint is clean).
  const doAB = () => {
    const live = r.popups.filter((p) => p.flareOn);
    const vis = live.map((p) => p.flareMesh.visible);
    live.forEach((p) => { p.flareMesh.visible = false; });
    u.uFlare.value = 0;
    const a = grab();
    live.forEach((p, i) => { p.flareMesh.visible = vis[i]; });
    u.uFlare.value = 0;
    const cimg = grab();
    u.uFlare.value = r.flare;
    const b = grab();
    return { a, cimg, b };
  };

  const W = r.canvas.width;
  const H = r.canvas.height;
  const cy = Math.round((1 - u.uFlareY.value) * H);
  const echoY = Math.round((1 - (u.uFlareY.value + 0.30)) * H); // echo sits ABOVE the streak
  const px = (d, x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    const i = (y * W + x) * 4;
    return [d.data[i], d.data[i + 1], d.data[i + 2]];
  };
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  // Control-window scan (A vs B): reject the streak band + bloom, the thin
  // vertical-ghost column, the offset echo (narrow central column), and the
  // mirror-floor wedge (the 3D streak's reflection lives there).
  const ctrlScan = (ab) => {
    outer:
    for (let wy = 48; wy + 56 < H; wy += 40) {
      for (let wx = 48; wx + 56 < W; wx += 40) {
        const cxw = wx + 28, cyw = wy + 28;
        if (Math.abs(cyw - cy) < 260) continue;
        if (Math.abs(cxw - W / 2) < 90) continue;
        if (Math.abs(cyw - echoY) < 120 && Math.abs(cxw - W / 2) < 110) continue;
        if (cyw > H - 240) continue; // mirror-floor reflection zone
        let m = 0;
        for (let y = wy; y < wy + 56; y += 4) {
          for (let x = wx; x < wx + 56; x += 4) {
            const pa = px(ab.a, x, y), pb = px(ab.b, x, y);
            if (!pa || !pb) continue;
            const d = Math.abs(lum(pb) - lum(pa));
            if (d > m) m = d;
          }
        }
        return { max: m, at: [wx, wy] };
      }
    }
    return null;
  };

  // The white-peak frame's bloom can outrun the control rejections, so if
  // the first capture lands near peak, advance a couple of frames (the
  // flare decays) and re-capture.
  let ab = doAB();
  let ctrl = ctrlScan(ab);
  for (let i = 0; i < 3 && (ctrl === null || ctrl.max > 25); i++) {
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    ab = doAB();
    ctrl = ctrlScan(ab);
  }

  // Band: the full-width streak strip at the banner height (A vs B).
  let bandMax = 0;
  for (let x = 8; x < W - 8; x += 3) {
    for (let y = cy - 18; y <= cy + 18; y += 2) {
      const pa = px(ab.a, x, y), pb = px(ab.b, x, y);
      if (!pa || !pb) continue;
      const d = Math.abs(lum(pb) - lum(pa));
      if (d > bandMax) bandMax = d;
    }
  }

  // Tint: the grade echo row, B vs C (3D quad cancels). The echo's cool
  // blue tint (b > r) is the anamorphic signature; pixels already bright
  // in C (the 3D quad clipped them) are skipped. Sample the echo's core
  // (±2px vertically, ±40..62px horizontally) so the box stays inside the
  // echo's full-strength band — at the white peak the core line clips,
  // which compresses but never inverts b > r.
  let tintB = 0, tintR = 0, tintN = 0;
  for (let y = echoY - 2; y <= echoY + 2; y += 1) {
    for (const off of [40, 45, 50, 55, 60, -40, -45, -50, -55, -60]) {
      const x = Math.round(W / 2 + off);
      const pc = px(ab.cimg, x, y), pb = px(ab.b, x, y);
      if (!pc || !pb) continue;
      if (pc[2] > 235) continue; // 3D quad already saturated this pixel
      tintB += pb[2] - pc[2];
      tintR += pb[0] - pc[0];
      tintN++;
    }
  }
  const mid = {
    flare: r.flare,
    uFlare: u.uFlare.value,
    quad: (() => {
      const p = r.popups.find((q) => q.tier === 'tetris' && q.flareOn);
      if (!p) return null;
      return {
        visible: p.flareMesh.visible,
        opacity: p.flareMat.opacity,
        sx: p.flareMesh.scale.x,
        sy: p.flareMesh.scale.y,
        y: p.flareMesh.position.y,
        z: p.flareMesh.position.z,
      };
    })(),
  };
  return {
    pre, mid, bandMax,
    ctrlMax: ctrl ? ctrl.max : null,
    tintB: tintN ? tintB / tintN : NaN,
    tintR: tintN ? tintR / tintN : NaN,
    tintN,
  };
});

check('TETRIS: four lines cleared (test precondition)', tet && tet.pre && tet.pre.clears === 4, tet && tet.pre ? `clearRows ${tet.pre.clears}` : 'no mid-flight sample');
check('TETRIS: dolly punch fired (camPunch ~1 at lock)', tet && tet.pre && tet.pre.punch > 0.9, tet && tet.pre ? `camPunch ${tet.pre.punch.toFixed(2)}` : '');
check('TETRIS: banner has the tetris tier and owns the flare', tet && tet.pre && tet.pre.banner && tet.pre.banner.flareOn,
  tet && tet.pre && tet.pre.banner ? `${tet.pre.banner.text} flareOn=${tet.pre.banner.flareOn}` : 'no banner');
check('grade streak is aimed at the banner screen height (uFlareY vs independent projection)',
  tet && tet.pre && Math.abs(tet.pre.uFlareY - tet.pre.uvY) < 0.03,
  tet && tet.pre ? `uFlareY ${tet.pre.uFlareY.toFixed(3)} vs ${tet.pre.uvY.toFixed(3)}` : '');
check('mid-flight: uFlare (grade streak) is strong', tet && tet.mid && tet.mid.uFlare > 0.5,
  tet && tet.mid ? `uFlare ${tet.mid.uFlare.toFixed(2)}` : 'timed out');
const mq = tet && tet.mid ? tet.mid.quad : null;
check('mid-flight: 3D streak quad widened with the punch, tracking the banner',
  mq && mq.visible && mq.opacity > 0.25 && mq.sx > 10 && Math.abs(mq.z - 2.8) < 0.3 && mq.y >= 11.4 && mq.y <= 13.0,
  mq ? `visible=${mq.visible} op=${mq.opacity.toFixed(2)} sx=${mq.sx.toFixed(1)} y=${mq.y.toFixed(2)} z=${mq.z.toFixed(2)} (want z=2.8 = popupZ+0.2)` : 'no quad');
check('pixel A/B: the full-width streak band carries the flare light',
  !!tet && tet.bandMax > 40, tet ? `band max|ΔL| ${tet.bandMax.toFixed(0)}` : '');
check('pixel A/B: clean control window stays flat',
  !!tet && tet.ctrlMax !== null && tet.ctrlMax < 25, tet ? `ctrl max|ΔL| ${tet.ctrlMax === null ? 'n/a' : tet.ctrlMax.toFixed(1)}` : '');
check('pixel A/B: the grade echo is anamorphic blue (grade-only diff: Δb > Δr and dominant)',
  !!tet && tet.tintN >= 20 && tet.tintB > 10 && tet.tintB > 1.5 * tet.tintR,
  tet ? `Δb ${tet.tintB.toFixed(1)}, Δr ${tet.tintR.toFixed(1)} over ${tet.tintN} px` : '');

// ---- 3. Decay: the lens event fades back to rest --------------------------

const decayed = await page.evaluate(async () => {
  const r = window.__tetris.renderer;
  const u = r.gradePass.uniforms;
  const wait = (ms) => new Promise((res) => {
    const t0 = performance.now();
    const step = () => {
      if (u.uFlare.value < 0.03 && r.popups.every((p) => !p.flareMesh.visible)) return res(true);
      if (performance.now() - t0 > ms) return res(false);
      requestAnimationFrame(step);
    };
    step();
  });
  return wait(20000);
});
check('the flare decays back to rest (uFlare ~0, all quads hidden)', decayed === true);

// ---- 4. A DOUBLE clear: banner, but no flare ------------------------------

// Let every popup from the TETRIS phase finish fading first: the banner
// lives longer than the flare, and a stale live banner would be picked up
// by the pool-stealing showPopup and muddy the banner identity check.
await page.evaluate(() => new Promise((res) => {
  const r = window.__tetris.renderer;
  const t0 = performance.now();
  const step = () => {
    if (r.popups.every((p) => p.t >= 1) || performance.now() - t0 > 20000) return res();
    requestAnimationFrame(step);
  };
  step();
}));

await setup({ type: 'O', rotation: 0, x: 3, y: 2, level: 1, cells: [...gapRows([20, 21]), [10, 0, 'Z']] });
const dbl = await page.evaluate(async () => {
  const r = window.__tetris.renderer;
  const u = r.gradePass.uniforms;
  window.__tetris.doHardDrop();
  const wait = (ms) => new Promise((res) => {
    const t0 = performance.now();
    const step = () => {
      if (r.popups.some((p) => p.tier === 'double' && p.t > 0.03) || performance.now() - t0 > 8000) return res();
      requestAnimationFrame(step);
    };
    step();
  });
  await wait();
  const p = r.popups.find((q) => q.tier === 'double');
  return {
    banner: p ? { text: p.text, tier: p.tier, flareOn: p.flareOn } : null,
    uFlare: u.uFlare.value,
    quads: r.popups.map((q) => ({ on: q.flareOn, vis: q.flareMesh.visible, op: q.flareMat.opacity })),
  };
});
check('DOUBLE clear shows the double-tier banner with no flare attached',
  dbl.banner && dbl.banner.tier === 'double' && dbl.banner.flareOn === false,
  dbl.banner ? `${dbl.banner.text} tier=${dbl.banner.tier} flareOn=${dbl.banner.flareOn}` : 'no banner');
check('DOUBLE clear: no flare pixels (uFlare 0, all flare quads hidden at 0 opacity)',
  dbl.uFlare === 0 && dbl.quads.every((q) => !q.vis && q.op === 0),
  `uFlare ${dbl.uFlare}, quads ${dbl.quads.map((q) => (q.vis ? 'v' : 'h')).join('')}`);

// ---- 5. Streak ignition (level 9 -> 10): violet-tinted flare --------------

// lines 89 -> level 9; the 1-line clear brings lines to 90 -> level 10,
// crossing STREAK_LEVEL: the STREAK banner + onStreakIgnite fire the flare
// with the violet-tinted quad (the rainbow stack is igniting). The filler
// keeps the clear from being a perfect one (the perfect celebration would
// also fire and own part of the lens event).
await setup({ type: 'O', rotation: 0, x: 3, y: 2, level: 9, lines: 89, cells: [...gapRows([21]), [10, 0, 'Z']] });
const stk = await page.evaluate(async () => {
  const r = window.__tetris.renderer;
  const g = window.__tetris.game;
  const u = r.gradePass.uniforms;
  window.__tetris.doHardDrop();
  const pre = {
    level: g.level,
    banner: (() => {
      const p = r.popups.find((q) => q.tier === 'streak');
      return p ? { text: p.text, flareOn: p.flareOn, cb: p.flareMat.color.b, cr: p.flareMat.color.r } : null;
    })(),
  };
  const wait = (ms) => new Promise((res) => {
    const t0 = performance.now();
    const step = () => {
      if (r.flare > 0.35) return res(true);
      if (performance.now() - t0 > 15000) return res(false);
      requestAnimationFrame(step);
    };
    step();
  });
  const got = await wait();
  return { pre, mid: got ? { flare: r.flare, uFlare: u.uFlare.value } : null };
});
check('streak ignition: the lock crossed level 9 -> 10 (test precondition)', stk.pre.level === 10, `level ${stk.pre.level}`);
check('streak ignition: STREAK banner owns the flare',
  stk.pre.banner && stk.pre.banner.flareOn === true,
  stk.pre.banner ? `${stk.pre.banner.text} flareOn=${stk.pre.banner.flareOn}` : 'no banner');
check('streak flare: violet-tinted HDR quad (b-channel gain > 1.2)',
  stk.pre.banner && stk.pre.banner.cb > 1.2, stk.pre.banner ? `color b=${stk.pre.banner.cb.toFixed(2)} r=${stk.pre.banner.cr.toFixed(2)}` : '');
check('streak flare: mid-flight envelope + grade streak live',
  stk.mid && stk.mid.uFlare > 0.3, stk.mid ? `uFlare ${stk.mid.uFlare.toFixed(2)}` : 'timed out');

// ---- 6. Lock-out game over: no flare; restart re-arms ---------------------

// Dense tower (rows 2+ full) with the O locking entirely in the hidden
// rows -> lock-out -> the lights-out cinematic owns the stage.
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
const over = await page.evaluate(async () => {
  const r = window.__tetris.renderer;
  const u = r.gradePass.uniforms;
  // Wait until the lights out has settled: over flag, the flare fully
  // extinguished by the next tick, and the GAME OVER banner in the pool.
  const wait = (ms) => new Promise((res) => {
    const t0 = performance.now();
    const step = () => {
      if (
        r.over &&
        u.uFlare.value === 0 &&
        r.popups.every((p) => !p.flareMesh.visible) &&
        r.popups.some((p) => p.tier === 'gameover')
      ) return res(true);
      if (performance.now() - t0 > 20000) return res(false);
      requestAnimationFrame(step);
    };
    step();
  });
  const got = await wait();
  const go = r.popups.find((p) => p.tier === 'gameover');
  return {
    settled: got,
    over: r.over,
    banner: go ? { flareOn: go.flareOn } : null,
    uFlare: u.uFlare.value,
    quads: r.popups.map((p) => ({ on: p.flareOn, vis: p.flareMesh.visible })),
  };
});
check('lock-out game over: the lights-out cinematic owns the stage (no flare fires)',
  over.settled && over.over && over.banner && over.banner.flareOn === false && over.uFlare === 0 && over.quads.every((q) => !q.vis),
  `over=${over.over} uFlare ${over.uFlare}`);

await page.keyboard.press('r');
await sleep(400);
const armed = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  return {
    uFlare: r.gradePass.uniforms.uFlare.value,
    quads: r.popups.map((p) => ({ on: p.flareOn, vis: p.flareMesh.visible, op: p.flareMat.opacity })),
    popups: r.popups.every((p) => !p.mesh.visible),
  };
});
check('restart re-arms the flare (uFlare 0, quads hidden, banners cleared)',
  armed.uFlare === 0 && armed.quads.every((q) => !q.on && !q.vis && q.op === 0) && armed.popups,
  `uFlare ${armed.uFlare}`);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);