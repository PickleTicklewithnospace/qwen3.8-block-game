// Browser regression: the theatrical rafter spotlights — three volumetric
// light shafts raking down from just above the frame into the top of the
// well (one central vertical beam, two raked side beams), each with a hot
// lamp cap at its source and a pool of light landing on the well's top
// edge. The beams sit BEHIND the board (the frosted panel's depth test
// occludes them below the frame top), re-ink with the level palette (uHue
// in the shaft shader, shared color objects for caps/pools/wash), flare on
// line clears / level-ups (uPulse, hotter on a TETRIS) and dim with the
// game-over lights out (uDim).
//
// Pixel proofs are synchronous A/B (hide the spots group, composer.render,
// show, composer.render — one in-page evaluate grabs both frames, so every
// uniform-driven background term cancels exactly):
//   - beam/cap/pool bands over the sky and the well gain light vs a
//     feature-free control window (found by coarse grid scan),
//   - a probe row on the board shows no beam (the panel occludes it),
//   - the re-ink shifts the cap band's channel mix while a control holds
//     (level 8 for a 138deg hue turn — a level-2 20deg turn on the
//     near-white caps is below the pixel threshold, so level 2 is pinned
//     by state checks and the pixels by the deep re-ink),
//   - the game-over dim drops the beam band's luminance, restart restores.
//
// Usage: node test/rafter-spots.mjs [url]

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
async function waitUntil(pred, arg, timeoutMs = 8000, pollMs = 15) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred, arg)) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

// ---- Phase 1: installation + neutral state ----
const s1 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  return {
    inScene: r.scene.children.includes(r.spots),
    shafts: r.spotShafts.length,
    caps: r.spotCaps.length,
    pools: r.spotPools.length,
    wash: !!r.spotWash,
    beamZ: r.spotShafts.map((s) => s.mesh.position.z),
    landY: r.spotShafts.map((s) => s.land[1]),
    topY: r.spotShafts.map((s) => s.top[1]),
    uHue: r.spotUniforms.uHue.value,
    uDim: r.spotUniforms.uDim.value,
    pulse: r.spotPulse,
    sharedPulse: r.spotShafts.every((s) => s.mesh.material.uniforms.uPulse === r.spotUniforms.uPulse),
    sharedHue: r.spotShafts.every((s) => s.mesh.material.uniforms.uHue === r.spotUniforms.uHue),
    capOp: r.spotCapMat.opacity,
    capBase: [r.spotCapBase.r, r.spotCapBase.g, r.spotCapBase.b],
    capNow: [r.spotCapColor.r, r.spotCapColor.g, r.spotCapColor.b],
    capShared: r.spotCaps.every((c) => c.material === r.spotCapMat) && r.spotCapMat.color === r.spotCapColor,
    poolShared: r.spotPools.every((p) => p.material === r.spotPoolMat) && r.spotPoolMat.color === r.spotPoolColor,
    depthTested: r.spotShafts.every((s) => s.mesh.material.depthTest === true),
  };
});
check('phase1: spots group is in the scene', s1.inScene);
check('phase1: three beams, three caps, three pools + well wash',
  s1.shafts === 3 && s1.caps === 3 && s1.pools === 3 && s1.wash);
check('phase1: all beams sit behind the board plane',
  s1.beamZ.every((z) => z < 0), `z=${s1.beamZ.join(',')}`);
check('phase1: beams land on the well top edge (y ~20.2), depth-tested so the panel occludes them',
  s1.landY.every((y) => Math.abs(y - 20.2) < 0.05) && s1.depthTested,
  `y=${s1.landY.join(',')}`);
check('phase1: lamps live in the sky band above the frame',
  s1.topY.every((y) => y > 22 && y < 24.5), `y=${s1.topY.join(',')}`);
check('phase1: level 1 is the neutral palette (uHue 0, full lights)',
  Math.abs(s1.uHue) < 1e-9 && s1.uDim < 1e-9 && s1.pulse < 0.01,
  `uHue=${s1.uHue} uDim=${s1.uDim} pulse=${s1.pulse}`);
check('phase1: all shafts share the one uPulse/uHue uniform objects',
  s1.sharedPulse && s1.sharedHue);
check('phase1: all caps share the live inked color object', s1.capShared);
check('phase1: caps start at the exact neutral base color',
  Math.max(...s1.capNow.map((v, i) => Math.abs(v - s1.capBase[i]))) < 1e-6);

// ---- Phase 2: synchronous pixel A/B (hide spots -> render -> show -> render) ----
const s2 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const c = document.getElementById('board');
  function grab() {
    r.composer.render();
    const off = document.createElement('canvas');
    off.width = c.width;
    off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height).data;
  }
  const lum = (px, i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  function band(dataA, dataB, cx, cy, bw, bh, channels = false) {
    const W = c.width, H = c.height;
    let maxD = 0, sum = 0, n = 0;
    let dR = 0, dG = 0, dB = 0;
    for (let y = cy - bh; y <= cy + bh; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = cx - bw; x <= cx + bw; x++) {
        if (x < 0 || x >= W) continue;
        const i = (y * W + x) * 4;
        if (channels) {
          dR += dataA[i] - dataB[i];
          dG += dataA[i + 1] - dataB[i + 1];
          dB += dataA[i + 2] - dataB[i + 2];
        }
        const d = Math.abs(lum(dataA, i) - lum(dataB, i));
        if (d > maxD) maxD = d;
        sum += d;
        n++;
      }
    }
    return { maxD, meanD: n ? sum / n : 0, dR: n ? dR / n : 0, dG: n ? dG / n : 0, dB: n ? dB / n : 0 };
  }
  const P = (x, y, z) => {
    const p = r.projectToPixel(x, y, z);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  };
  const a = grab();
  r.spots.visible = false;
  const b = grab();
  r.spots.visible = true;
  // Bands (device px): cap/beam centers on the projected beams, the landing
  // pool on the well top, an occlusion probe row on the board (the panel
  // must hide the beam there), and a feature-free control found by scanning
  // a coarse grid for the flattest window in the A/B diff.
  const capC = P(0, 22.5, -2.5);
  const beamC = P(0, 21.4, -2.5);
  const beamL = P(-2.84, 21.7, -5.0);
  const pool = P(0, 20.3, 0.3);
  const occl = P(0, 18.0, 0);
  const out = {
    capC: band(a, b, capC.x, capC.y, 26, 10),
    beamC: band(a, b, beamC.x, beamC.y, 30, 8),
    beamL: band(a, b, beamL.x, beamL.y, 20, 8),
    pool: band(a, b, pool.x, pool.y, 26, 8),
    occl: band(a, b, occl.x, occl.y, 30, 6),
  };
  const W = c.width, H = c.height;
  let best = { maxD: Infinity, x: 0, y: 0 };
  for (let wy = 40; wy < H - 20; wy += 30) {
    for (let wx = 20; wx < W - 30; wx += 30) {
      const st = band(a, b, wx, wy, 14, 7);
      if (st.maxD < best.maxD) best = { ...st, x: wx, y: wy };
    }
  }
  out.ctl = best;
  return out;
});
check('phase2: the center beam sky band carries light (A/B vs hidden)',
  s2.beamC.maxD > 25, `maxD=${s2.beamC.maxD?.toFixed(1)} mean=${s2.beamC.meanD?.toFixed(1)}`);
check('phase2: the lamp cap is the hottest part of the beam',
  s2.capC.maxD >= s2.beamC.maxD, `cap=${s2.capC.maxD?.toFixed(1)} beam=${s2.beamC.maxD?.toFixed(1)}`);
check('phase2: the raked side beam reads in the sky band',
  s2.beamL.maxD > 12, `maxD=${s2.beamL.maxD?.toFixed(1)}`);
check('phase2: the landing pool lights the well top edge',
  s2.pool.maxD > 10, `maxD=${s2.pool.maxD?.toFixed(1)}`);
check('phase2: a board row shows only the decaying bloom halo, not the beam itself (the shaft ends at the frame top and is depth-occluded below it)',
  s2.occl.maxD < 45 && s2.occl.maxD < s2.beamC.maxD * 0.35,
  `occl=${s2.occl.maxD?.toFixed(1)} beamSky=${s2.beamC.maxD?.toFixed(1)}`);
check('phase2: feature-free control window is flat (A/B cancels the background)',
  s2.ctl.maxD < 5, `maxD=${s2.ctl.maxD?.toFixed(1)} at (${s2.ctl.x},${s2.ctl.y})`);

// ---- Phase 3: clear/level flares drive uPulse (TETRIS flares hotter) ----
const s3 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const colors = ['#e7484f', '#38b26d', '#4a9de8'];
  r.spotPulse = 0;
  r.onLineClear([18, 19], [colors, colors]);
  const pDouble = r.spotPulse;
  r.spotPulse = 0;
  r.onLineClear([16, 17, 18, 19], [colors, colors, colors, colors]);
  const pTetris = r.spotPulse;
  return { pDouble, pTetris };
});
check('phase3: a line clear flares the spotlights', s3.pDouble > 0.5, `pulse=${s3.pDouble?.toFixed(2)}`);
check('phase3: a TETRIS flares hotter than a double', s3.pTetris > s3.pDouble,
  `tetris=${s3.pTetris?.toFixed(2)} double=${s3.pDouble?.toFixed(2)}`);
const s3d = await waitUntil(() => {
  const r = window.__tetris.renderer;
  return r.spotPulse < 0.05 && Math.abs(r.settleDip) < 0.02;
}, null, 10000);
check('phase3: the flare decays back to steady state', s3d !== null, `after ${s3d}ms`);

// ---- Phase 4: level palette re-inks the spotlights ----
await page.evaluate(() => window.__tetris.renderer.onLevelUp(2));
const inkWait = await waitUntil(() => {
  const r = window.__tetris.renderer;
  return Math.abs(r.levelHue - r.levelHueTarget) < 1e-4 && r.spotPulse < 0.05;
}, null, 20000);
check('phase4: the stage hue converges to the level palette', inkWait !== null, `after ${inkWait}ms`);
const s4 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  return {
    uHue: r.spotUniforms.uHue.value,
    capNow: [r.spotCapColor.r, r.spotCapColor.g, r.spotCapColor.b],
    capBase: [r.spotCapBase.r, r.spotCapBase.g, r.spotCapBase.b],
  };
});
check('phase4: the shaft uHue uniform tracks the level palette (rad = levelHue*2pi)',
  Math.abs(s4.uHue - 0.055 * Math.PI * 2) < 0.05, `uHue=${s4.uHue?.toFixed(3)}`);
check('phase4: the caps re-inked off the neutral base',
  Math.max(...s4.capNow.map((v, i) => Math.abs(v - s4.capBase[i]))) > 0.02,
  `base=${s4.capBase.map((v) => v.toFixed(2)).join(',')} now=${s4.capNow.map((v) => v.toFixed(2)).join(',')}`);
// A level-2 shift (20deg) is too subtle to measure on the near-white caps,
// so the PIXEL proof of the re-ink re-inks to level 8 (a 138deg hue turn):
// a synchronous A/B that UN-INKS ONLY the spot rig (spot uHue -> 0,
// cap/pool/wash colors back to base) between two renders — the stage's own
// re-inked aurora/sky stays put, so a flat control window is valid and the
// diff isolates exactly the spotlights' palette shift.
await page.evaluate(() => window.__tetris.renderer.onLevelUp(8));
const ink8Wait = await waitUntil(() => {
  const r = window.__tetris.renderer;
  return Math.abs(r.levelHue - r.levelHueTarget) < 1e-4 && r.spotPulse < 0.05;
}, null, 20000);
check('phase4: the deep re-ink (level 8) converges', ink8Wait !== null, `after ${ink8Wait}ms`);
const s4p = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const c = document.getElementById('board');
  function grab() {
    r.composer.render();
    const off = document.createElement('canvas');
    off.width = c.width;
    off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height).data;
  }
  const lum = (px, i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  function band(dataA, dataB, cx, cy, bw, bh) {
    const W = c.width, H = c.height;
    let maxD = 0, sum = 0, n = 0, dR = 0, dB = 0;
    for (let y = cy - bh; y <= cy + bh; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = cx - bw; x <= cx + bw; x++) {
        if (x < 0 || x >= W) continue;
        const i = (y * W + x) * 4;
        dR += dataA[i] - dataB[i];
        dB += dataA[i + 2] - dataB[i + 2];
        const d = Math.abs(lum(dataA, i) - lum(dataB, i));
        if (d > maxD) maxD = d;
        sum += d;
        n++;
      }
    }
    return { maxD, meanD: n ? sum / n : 0, dR: n ? dR / n : 0, dB: n ? dB / n : 0 };
  }
  const P = (x, y, z) => {
    const p = r.projectToPixel(x, y, z);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  };
  const uHueNow = r.spotUniforms.uHue.value;
  const capNow = r.spotCapColor.clone();
  const poolNow = r.spotPoolColor.clone();
  const washNow = r.spotWashColor.clone();
  const a = grab(); // re-inked spots
  r.spotUniforms.uHue.value = 0;
  r.spotCapColor.copy(r.spotCapBase);
  r.spotPoolColor.copy(r.spotPoolBase);
  r.spotWashColor.copy(r.spotWashBase);
  const b = grab(); // spots un-inked, stage untouched
  r.spotUniforms.uHue.value = uHueNow;
  r.spotCapColor.copy(capNow);
  r.spotPoolColor.copy(poolNow);
  r.spotWashColor.copy(washNow);
  const cap = P(0, 22.5, -2.5);
  const pool = P(0, 20.3, 0.3);
  const out = { cap: band(a, b, cap.x, cap.y, 26, 10), pool: band(a, b, pool.x, pool.y, 26, 8) };
  const W = c.width, H = c.height;
  let best = { maxD: Infinity, x: 0, y: 0 };
  for (let wy = 40; wy < H - 20; wy += 30)
    for (let wx = 20; wx < W - 30; wx += 30) {
      const st = band(a, b, wx, wy, 14, 7);
      if (st.maxD < best.maxD) best = { ...st, x: wx, y: wy };
    }
  out.ctl = best;
  return out;
});
const capShift = Math.abs(s4p.cap.dR) + Math.abs(s4p.cap.dB);
check('phase4: the deep re-ink visibly shifts the cap band channel mix (spot-only A/B)',
  capShift > 10, `|dR|+|dB|=${capShift.toFixed(1)} (dR=${s4p.cap.dR?.toFixed(1)} dB=${s4p.cap.dB?.toFixed(1)})`);
check('phase4: the pool re-ink shows on the well top edge',
  s4p.pool.maxD > 10, `maxD=${s4p.pool.maxD?.toFixed(1)}`);
check('phase4: the stage (aurora/sky) is untouched by the spot A/B — control holds',
  s4p.ctl.maxD < 5, `maxD=${s4p.ctl.maxD?.toFixed(1)} at (${s4p.ctl.x},${s4p.ctl.y})`);

// ---- Phase 5: restart restores the exact neutral spotlights ----
await page.keyboard.press('r');
const rstWait = await waitUntil(() => {
  const r = window.__tetris.renderer;
  return r.over === false && r.levelHue === 0 && r.spotPulse < 0.01;
}, null, 10000);
const s5 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  return {
    uHue: r.spotUniforms.uHue.value,
    uDim: r.spotUniforms.uDim.value,
    cap: [r.spotCapColor.r, r.spotCapColor.g, r.spotCapColor.b],
    capBase: [r.spotCapBase.r, r.spotCapBase.g, r.spotCapBase.b],
    capOp: r.spotCaps[0].material.opacity,
  };
});
check('phase5: restart restored the neutral spotlights',
  rstWait !== null && Math.abs(s5.uHue) < 1e-9 && s5.uDim < 1e-9,
  `uHue=${s5.uHue} uDim=${s5.uDim}`);
check('phase5: caps back at the exact level-1 base, full opacity',
  Math.max(...s5.cap.map((v, i) => Math.abs(v - s5.capBase[i]))) < 1e-6 && Math.abs(s5.capOp - 0.55) < 0.01,
  `op=${s5.capOp}`);

// ---- Phase 6: the game-over lights out dims the spotlights ----
const pre = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const c = document.getElementById('board');
  r.composer.render();
  const off = document.createElement('canvas');
  off.width = c.width;
  off.height = c.height;
  const ctx = off.getContext('2d');
  ctx.drawImage(c, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const W = c.width;
  const p = r.projectToPixel(0, 21.7, -2.5);
  const px = Math.round(p.x), py = Math.round(p.y);
  let s = 0, n = 0;
  for (let y = py - 10; y <= py + 10; y++)
    for (let x = px - 30; x <= px + 30; x++) {
      const i = (y * W + x) * 4;
      if (i < 0 || i + 3 >= d.length) continue;
      s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      n++;
    }
  return { n, lum: n ? s / n : null };
});
await page.evaluate(() => window.__tetris.renderer.onGameOver());
const dimWait = await waitUntil(() => window.__tetris.renderer.overDim > 0.5, null, 20000);
const s6 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const c = document.getElementById('board');
  r.composer.render();
  const off = document.createElement('canvas');
  off.width = c.width;
  off.height = c.height;
  const ctx = off.getContext('2d');
  ctx.drawImage(c, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const W = c.width;
  const p = r.projectToPixel(0, 21.7, -2.5);
  const px = Math.round(p.x), py = Math.round(p.y);
  let s = 0, n = 0;
  for (let y = py - 10; y <= py + 10; y++)
    for (let x = px - 30; x <= px + 30; x++) {
      const i = (y * W + x) * 4;
      if (i < 0 || i + 3 >= d.length) continue;
      s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      n++;
    }
  return {
    lum: n ? s / n : null,
    uDim: r.spotUniforms.uDim.value,
    capOp: r.spotCapMat.opacity,
  };
});
check('phase6: the lights-out ramp reached the spotlight dim', dimWait !== null && s6.uDim > 0.4,
  `after ${dimWait}ms uDim=${s6.uDim?.toFixed(2)}`);
check('phase6: the beam band dims with the stage',
  pre.lum !== null && s6.lum !== null && s6.lum < pre.lum * 0.75,
  `${pre.lum?.toFixed(1)} -> ${s6.lum?.toFixed(1)}`);
check('phase6: lamp caps dim with the lights out', s6.capOp < 0.45, `op=${s6.capOp?.toFixed(2)}`);
await page.keyboard.press('r');
const backWait = await waitUntil(() => window.__tetris.renderer.overDim === 0 && !window.__tetris.renderer.over, null, 10000);
check('phase6: restart relights the stage (and the spotlights)', backWait !== null, `after ${backWait}ms`);

check('no page/console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}: ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);