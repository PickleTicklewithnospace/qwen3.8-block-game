// Browser regression: the cinematic grade — the final screen-space pass
// (vignette + lens chromatic aberration + 24fps film grain) applied to the
// tone-mapped frame.
//
// Each effect is A/B-isolated by zeroing its uniform on r.gradePass.uniforms
// (vignette / chroma / grain are independent terms, so zeroing the other two
// isolates exactly the term under test):
//   - vignette: corner windows measure darker with the grade than without
//     (ratio < 0.92 in all four corners); the center window sits at
//     d < 0.55 where the falloff is exactly 0, so it is untouched,
//   - chromatic aberration: the R/B channels are sampled at a radial offset,
//     so the board frame's top neon line (the only sharp feature in its band)
//     fringes: |ΔL| GATED on locally sharp pixels is ~10x larger on the edge
//     band than on the cleanest star-free sky window (star positions come
//     from the renderer's own Points attributes, since per-load star
//     placement is unseeded),
//   - grain: per-pixel high-frequency roughness (|L - avg(neighbors)|) in a
//     smooth sky window rises well above the no-grain baseline, and grain is
//     ANIMATED: a frame captured 200ms later (uTime advances, the 24fps
//     pattern refreshes) differs per-pixel, while a no-grain pair (camera
//     sway moves < 0.4px, aurora drifts slowly) is nearly identical.
// The grade must also not break the white-clip grade on a dense stack.
//
// Usage: node test/cinematic-grade.mjs [url]

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

// Paused, deterministic setup. `cells` = [y,x,type]; the active piece is
// always parked in a hidden row so it is not rendered (clean controls).
async function setup(cells) {
  return page.evaluate(({ cells }) => {
    const g = window.__tetris.game;
    g.gameOver = false;
    g.paused = true;
    g.level = 1;
    for (let y = 0; y < g.board.length; y++) g.board[y].fill(null);
    for (const [y, x, t] of cells || []) g.board[y][x] = t;
    g.current = { type: 'T', rotation: 0, x: 4, y: 0 };
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
  }, { cells });
}

// ---- 1. Grade pass is installed and last ----
await setup([]);
await waitUntil(() => window.__tetris.renderer.pieceGroup.visible === false, 5000);
const install = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const passes = r.composer.passes;
  const last = passes[passes.length - 1];
  // ShaderPass wraps the shader object in a ShaderMaterial (three r18x).
  return {
    isLast: last && last.material && last.material.name === 'CinematicGradeShader' && !!(last.uniforms && last.uniforms.uVignette),
    vignette: last.uniforms.uVignette.value,
    chroma: last.uniforms.uChroma.value,
    grain: last.uniforms.uGrain.value,
    nPasses: passes.length,
  };
});
check('grade pass is the final composer pass', install.isLast, `pass ${install.nPasses - 1} of ${install.nPasses - 1}`);
check('grade uniforms are live (vignette/chroma/grain)', install.vignette > 0 && install.chroma > 0 && install.grain > 0,
  `v=${install.vignette} c=${install.chroma} g=${install.grain}`);

// ---- 2. Vignette: corners darken, center untouched ----
// Dense stack so the board area is busy; corners sit on sky/floor, both
// bright enough to measure. Other grade terms zeroed to isolate the falloff.
const cells = [];
const types = ['I', 'J', 'L', 'S', 'T', 'Z', 'O'];
for (let y = 12; y <= 21; y++) for (let x = 0; x < 10; x++) if ((x + y) % 3 !== 0) cells.push([y, x, types[(x + y) % 7]]);
await setup(cells);
await sleep(400);
const vig = await page.evaluate(() => {
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
  const winMean = (img, fx0, fy0, fx1, fy1) => {
    const x0 = Math.floor(fx0 * c.width), y0 = Math.floor(fy0 * c.height);
    const x1 = Math.floor(fx1 * c.width), y1 = Math.floor(fy1 * c.height);
    let s = 0, n = 0;
    for (let Y = y0; Y < y1; Y++) for (let X = x0; X < x1; X++) { s += lum(img, X, Y); n++; }
    return s / n;
  };
  const u = r.gradePass.uniforms;
  const saved = { v: u.uVignette.value, c: u.uChroma.value, g: u.uGrain.value };
  u.uVignette.value = 0; u.uChroma.value = 0; u.uGrain.value = 0;
  const imgOff = read();
  u.uVignette.value = saved.v; u.uChroma.value = saved.c; u.uGrain.value = saved.g;
  const imgOn = read();
  const ratio = (a, b) => winMean(imgOn, ...a) / winMean(imgOff, ...a);
  return {
    corners: [
      ratio([0.02, 0.03, 0.16, 0.12]), // TL
      ratio([0.84, 0.03, 0.98, 0.12]), // TR
      ratio([0.02, 0.88, 0.16, 0.97]), // BL
      ratio([0.84, 0.88, 0.98, 0.97]), // BR
    ],
    center: ratio([0.42, 0.42, 0.58, 0.58]),
  };
});
check('vignette darkens all four corners', vig.corners.every((r) => r < 0.92), vig.corners.map((r) => r.toFixed(3)).join('/'));
check('vignette leaves the frame center untouched', Math.abs(vig.center - 1) < 0.02, `center ratio ${vig.center.toFixed(4)}`);

// ---- 3. Chromatic aberration: sharp frame edge fringes, sky does not ----
// Neon frame line (EdgesGeometry of the board frame) along its top edge
// (world y ≈ 20.5, z = -0.3). With CA on, R/B sample at a radial offset
// (~0.8px near the top edge), so the bright line's R and B profiles
// displace in opposite directions. Raw |ΔL| over a band is contaminated by
// offset-sampling on the sky's own gradients, so the delta is GATED on
// locally sharp pixels (5x5 max-min > 40 in the no-CA frame): the neon line
// is the only sharp feature in the edge band, while the sky band accumulates
// only its stars + hard curtain rims. The sky control window is chosen as
// the cleanest candidate: windows overlapping the projected rafter-spot
// beams are rejected first (the beams' bright rims/bloom are locally sharp
// and their gradients fringe under CA like a real feature would), as are
// windows crossing any in-flight sky meteor's projected remaining path, then
// fewest projected stars (star positions come from the renderer's own
// Points attributes — per-load star placement is unseeded). The beam-free
// sky lives in the narrow side slivers outside the outer beams (x ≲ ∓4.85).
const ca = await page.evaluate(() => {
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
  const localMM = (img, X, Y) => {
    let mn = 999, mx = -1;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const v = lum(img, X + dx, Y + dy);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    return mx - mn;
  };
  const u = r.gradePass.uniforms;
  const saved = { v: u.uVignette.value, c: u.uChroma.value, g: u.uGrain.value };
  u.uChroma.value = 0; u.uVignette.value = 0; u.uGrain.value = 0;
  const imgOff = read();
  u.uVignette.value = saved.v; u.uChroma.value = saved.c; u.uGrain.value = saved.g;
  const imgOn = read();
  // Gated |ΔL| over a band: only pixels that are locally sharp in the
  // no-CA frame (the neon line; soft sky gradients cancel out).
  const band = (px0, py0, px1, py1) => {
    let s = 0;
    for (let Y = py0; Y < py1; Y++) for (let X = px0; X < px1; X++) {
      if (localMM(imgOff, X, Y) > 40) s += Math.abs(lum(imgOn, X, Y) - lum(imgOff, X, Y));
    }
    return s;
  };
  const e = r.projectToPixel(0, 20.475, -0.3); // top frame edge (horizontal neon line)
  const x0 = Math.max(0, Math.round(0.25 * c.width)), x1 = Math.min(c.width, Math.round(0.75 * c.width));
  const y0 = Math.max(0, Math.round(e.y) - 8), y1 = Math.min(c.height, Math.round(e.y) + 8);
  const edge = band(x0, y0, x1, y1);
  // Manual projection (camera matrices are live after the forced renders)
  // to count stars in candidate sky windows and pick the cleanest.
  const mv = r.camera.matrixWorldInverse.elements;
  const pm = r.camera.projectionMatrix.elements;
  const project = (x, y, z) => {
    const x1 = mv[0] * x + mv[1] * y + mv[2] * z + mv[3];
    const y1 = mv[4] * x + mv[5] * y + mv[6] * z + mv[7];
    const z1 = mv[8] * x + mv[9] * y + mv[10] * z + mv[11];
    const w1 = mv[12] * x + mv[13] * y + mv[14] * z + mv[15];
    const x2 = pm[0] * x1 + pm[1] * y1 + pm[2] * z1 + pm[3] * w1;
    const y2 = pm[4] * x1 + pm[5] * y1 + pm[6] * z1 + pm[7] * w1;
    const w2 = pm[12] * x1 + pm[13] * y1 + pm[14] * z1 + pm[15] * w1;
    if (w2 === 0) return null;
    const nx = x2 / w2, ny = y2 / w2;
    if (nx < -1 || nx > 1 || ny < -1 || ny > 1) return null;
    return { x: ((nx + 1) / 2) * c.width, y: ((1 - ny) / 2) * c.height };
  };
  const starPx = [];
  for (const layer of [r.starsNear, r.starsMid, r.starsFar]) {
    const arr = layer.geometry.attributes.position.array;
    for (let i = 0; i < arr.length; i += 3) {
      const p = project(arr[i], arr[i + 1], arr[i + 2]);
      if (p) starPx.push(p);
    }
  }
  const sy0 = Math.max(0, y0 - 72), sy1 = Math.max(0, y0 - 24);
  // Projected x-extent of the rafter-spot beams (their bright caps/bloom
  // rims are locally sharp, so a sky window on a beam fringes under CA).
  const beamX = { min: Infinity, max: -Infinity };
  for (const s of r.spotShafts) {
    const z = s.top[2];
    for (const [bx, by] of [s.top, s.land]) {
      for (const ex of [bx - s.w / 2, bx + s.w / 2]) {
        const p = project(ex, by, z);
        if (!p) continue;
        // Only the part of the beam inside (near) the candidate sky band
        // matters: lamps and the upper shaft.
        if (p.y >= sy0 - 30 && p.y <= sy1 + 30) {
          if (p.x < beamX.min) beamX.min = p.x;
          if (p.x > beamX.max) beamX.max = p.x;
        }
      }
    }
  }
  // Projected path of any in-flight sky meteor (its bright streak is locally
  // sharp and fringes under CA like a real feature): sample the REMAINDER
  // of its flight, since it keeps moving between window selection and the
  // A/B capture below.
  const meteorPx = [];
  for (const s of r.meteors) {
    if (!s.m) continue;
    const m = s.m;
    const t0 = Math.max(r.time, m.t0);
    for (let k = 0; k <= 12; k++) {
      const tt = t0 + ((m.t0 + m.life - t0) * k) / 12;
      const dx = m.x0 + m.vx * (tt - m.t0);
      const dy = m.y0 + m.vy * (tt - m.t0);
      const p = project(dx, dy, m.z);
      if (p && p.y >= sy0 - 30 && p.y <= sy1 + 30) meteorPx.push(p);
    }
  }
  // Pick the cleanest candidate sky window: beam- and meteor-free first,
  // then fewest projected stars. Side slivers sit outside the outer beams.
  let best = null;
  for (const [a, b] of [[0.005, 0.135], [0.865, 0.995], [0.34, 0.60], [0.04, 0.30], [0.64, 0.90]]) {
    const wa = Math.floor(a * c.width), wb = Math.floor(b * c.width);
    const overlapsBeam = wb > beamX.min && wa < beamX.max;
    const nearMeteor = meteorPx.some((p) => p.x >= wa - 20 && p.x <= wb + 20);
    const nStars = starPx.filter((p) => p.x >= wa - 20 && p.x <= wb + 20 && p.y >= sy0 - 20 && p.y <= sy1 + 20).length;
    const rank = overlapsBeam || nearMeteor ? 1e9 + nStars : nStars;
    if (!best || rank < best.rank) best = { rank, n: nStars, a, b };
  }
  sky = band(Math.floor(best.a * c.width), sy0, Math.floor(best.b * c.width), sy1);
  return { edge, sky, skyStars: best.n };
});
check('CA fringes the frame edge (gated ΔL is large)', ca.edge > 8000, `edge ${ca.edge.toFixed(0)}`);
check('CA is negligible on the cleanest sky window', ca.edge > 3 * ca.sky,
  `edge ${ca.edge.toFixed(0)} vs sky ${ca.sky.toFixed(0)} (stars ${ca.skyStars})`);

// ---- 4. Grain: roughness rises and the pattern is animated ----
// Empty board: the sky is smooth, so high-frequency neighbor roughness in a
// sky window is ~zero without grain and clearly positive with it.
await setup([]);
await sleep(300);
const grain = await page.evaluate(() => {
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
  const roughness = (img, fx0, fy0, fx1, fy1) => {
    const x0 = Math.ceil(fx0 * c.width) + 1, y0 = Math.ceil(fy0 * c.height) + 1;
    const x1 = Math.floor(fx1 * c.width) - 1, y1 = Math.floor(fy1 * c.height) - 1;
    let s = 0, n = 0;
    for (let Y = y0; Y < y1; Y++) for (let X = x0; X < x1; X++) {
      const m = (lum(img, X + 1, Y) + lum(img, X - 1, Y) + lum(img, X, Y + 1) + lum(img, X, Y - 1)) / 4;
      s += Math.abs(lum(img, X, Y) - m);
      n++;
    }
    return s / n;
  };
  const u = r.gradePass.uniforms;
  const saved = { v: u.uVignette.value, c: u.uChroma.value, g: u.uGrain.value };
  u.uGrain.value = 0; u.uVignette.value = 0; u.uChroma.value = 0;
  const imgOff = read();
  u.uVignette.value = saved.v; u.uChroma.value = saved.c; u.uGrain.value = saved.g;
  const imgOn = read();
  return {
    roughOn: roughness(imgOn, 0.30, 0.05, 0.70, 0.20),
    roughOff: roughness(imgOff, 0.30, 0.05, 0.70, 0.20),
  };
});
check('grain adds filmic micro-roughness', grain.roughOn > grain.roughOff + 0.8 && grain.roughOn > 2.0,
  `on ${grain.roughOn.toFixed(2)} vs off ${grain.roughOff.toFixed(2)}`);

// Animated: two frames 200ms apart (uTime advances => the 24fps grain
// pattern refreshes) differ per-pixel with grain on, but not with it off
// (camera sway moves < 0.4px over 200ms and the aurora drifts slowly).
const animated = await page.evaluate(async () => {
  const r = window.__tetris.renderer;
  const c = r.canvas;
  const off2 = document.createElement('canvas');
  off2.width = c.width;
  off2.height = c.height;
  const ctx = off2.getContext('2d');
  const read = () => {
    r.composer.render();
    ctx.drawImage(c, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height).data;
  };
  const lum = (img, X, Y) => {
    const i = (Y * c.width + X) * 4;
    return 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
  };
  const winDiff = (a, b) => {
    const x0 = Math.floor(0.30 * c.width), y0 = Math.floor(0.05 * c.height);
    const x1 = Math.floor(0.70 * c.width), y1 = Math.floor(0.20 * c.height);
    let s = 0, n = 0;
    for (let Y = y0; Y < y1; Y++) for (let X = x0; X < x1; X++) { s += Math.abs(lum(a, X, Y) - lum(b, X, Y)); n++; }
    return s / n;
  };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const u = r.gradePass.uniforms;
  const saved = { v: u.uVignette.value, c: u.uChroma.value, g: u.uGrain.value };
  u.uVignette.value = 0; u.uChroma.value = 0;
  const a1 = read();
  await sleep(200);
  const b1 = read();
  u.uGrain.value = 0;
  const a2 = read();
  await sleep(200);
  const b2 = read();
  u.uVignette.value = saved.v; u.uChroma.value = saved.c; u.uGrain.value = saved.g;
  return { on: winDiff(a1, b1), off: winDiff(a2, b2) };
});
check('grain pattern animates between frames', animated.on > animated.off + 1.5 && animated.on > 2.5,
  `on ${animated.on.toFixed(2)} vs off ${animated.off.toFixed(2)}`);

// ---- 5. Grade holds on a dense stack (white clip < 3%) ----
await setup(cells);
await sleep(400);
const wp = await page.evaluate(() => {
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
check('graded dense stack keeps the white-clip grade under 3%', wp < 3, `white ${wp.toFixed(2)}%`);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);