// Browser regression: sky meteors — rare shooting stars streaking the
// aurora band (in front of the sky plane, behind the board): a hot round
// head leading a trailing light tail (rotated along the velocity, bright
// end at the head) with a slow spark drizzle shedding off the head. The
// auto-spawn schedule waits for the stage to settle, re-arms after a
// restart, and pauses under the game-over lights out (in-flight meteors
// keep flying but dim with the stage); the level palette re-inks head,
// tail and sparks (live color objects).
//
// Pixel proofs are synchronous A/B (hide the meteor group — or un-ink the
// meteor colors only — between two composer.render() calls in ONE in-page
// evaluate, so every uniform-driven background term cancels exactly):
//   - the head band is the hottest part, the tail band carries light, a
//     coarse-grid control window (excluding the bloom halos) is flat,
//   - the deep level-8 re-ink shifts the head/tail channel mix while the
//     untouched stage holds,
//   - the lights out dims the in-flight meteor (tail opacity + head-band
//     luminance) and suppresses new spawns.
//
// Flight geometry is proven by a GC-pinned in-page rAF probe that samples
// (t, head, tail, opacities) atomically per frame over one full flight,
// checked against the spec's own linear kinematics in Node.
//
// Usage: node test/sky-meteors.mjs [url]

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8901/index.html';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(1200);
// Pause the engine: the meteor FX are renderer-clock driven (r.time) and
// independent of gameplay, while an uncontrolled live game would keep
// locking pieces and could climb into the redline alarm window mid-run —
// its sky wash would then dim the tail band's bloom and bias this suite's
// pixel A/Bs. Every other browser suite pauses too; this one just never
// needed game state, so it was the odd one out.
await page.evaluate(() => { window.__tetris.game.paused = true; });

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

// Deterministic flight: right entry from the left, falling across the sky
// band. The tail (bright texture end) trails opposite the velocity.
const SPEC = { x0: -12, y0: 24, vx: 18, vy: -7, z: -30, life: 1.6, tail: 5 };
const UX = SPEC.vx / Math.hypot(SPEC.vx, SPEC.vy);
const UY = SPEC.vy / Math.hypot(SPEC.vx, SPEC.vy);

// ---- Phase 1: installation + neutral state ----
const s1 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  r.meteorNext = 1e9; // hold auto-spawn for the suite; it re-arms at restart
  return {
    inScene: r.scene.children.includes(r.meteorGroup),
    slots: r.meteors.length,
    headShared: r.meteors.every((s) => s.headMat.color === r.meteorHeadColor),
    tailShared: r.meteors.every((s) => s.tailMat.color === r.meteorTailColor),
    depthTested: r.meteors.every((s) => s.headMat.depthTest === true && s.tailMat.depthTest === true),
    headBase: [r.meteorHeadBase.r, r.meteorHeadBase.g, r.meteorHeadBase.b],
    headNow: [r.meteorHeadColor.r, r.meteorHeadColor.g, r.meteorHeadColor.b],
    hidden: r.meteors.every((s) => !s.m && !s.head.visible && !s.tail.visible),
    count: r.meteorCount,
    z: -30,
  };
});
check('phase1: the meteor rig is in the scene', s1.inScene);
check('phase1: three pooled head/tail entries', s1.slots === 3);
check('phase1: all head/tail materials share the live inked color objects',
  s1.headShared && s1.tailShared);
check('phase1: head + tail are depth-tested (the frosted panel occludes the exit)',
  s1.depthTested);
check('phase1: level 1 is the exact neutral meteor palette',
  Math.max(...s1.headNow.map((v, i) => Math.abs(v - s1.headBase[i]))) < 1e-6);
check('phase1: a fresh game has no meteors in flight', s1.hidden && s1.count === 0);

// ---- Phase 2: one full flight, sampled per frame, vs the spec's kinematics ----
await page.evaluate((spec) => {
  const r = window.__tetris.renderer;
  const S = { ...spec, t0: r.time };
  window.__meteorSpec = S;
  window.__meteorProbe = [];
  window.__meteorProbeDone = false;
  r.spawnMeteor(S);
  const probe = () => {
    const slot = r.meteors.find((s) => s.m && s.m.t0 === S.t0);
    if (!slot) {
      window.__meteorProbeDone = true;
      return;
    }
    window.__meteorProbe.push({
      t: r.time,
      t0: S.t0,
      u: (r.time - S.t0) / S.life,
      hx: slot.head.position.x,
      hy: slot.head.position.y,
      hz: slot.head.position.z,
      tx: slot.tail.position.x,
      ty: slot.tail.position.y,
      rot: slot.tail.rotation.z,
      sx: slot.tail.scale.x,
      hop: slot.headMat.opacity,
      top: slot.tailMat.opacity,
      hv: slot.head.visible,
    });
    if (window.__meteorProbe.length < 500) requestAnimationFrame(probe);
    else window.__meteorProbeDone = true;
  };
  requestAnimationFrame(probe);
}, SPEC);
const flightDone = await waitUntil(() => window.__meteorProbeDone, null, 30000);
const samples = await page.evaluate(() => {
  const s = window.__meteorProbe;
  window.__meteorProbe = null;
  return s;
});
const mid = samples.filter((p) => p.u > 0.25 && p.u < 0.75 && p.hv);
check('phase2: the flight ran to completion with a mid-flight sample window',
  flightDone !== null && mid.length > 3, `samples=${samples.length} mid=${mid.length}`);
const T0 = mid.length ? mid[0].t0 : null;
let posErr = 0, tailErr = 0;
for (const p of mid) {
  const dt = p.t - T0;
  posErr = Math.max(posErr, Math.abs(p.hx - (SPEC.x0 + SPEC.vx * dt)), Math.abs(p.hy - (SPEC.y0 + SPEC.vy * dt)));
  tailErr = Math.max(
    tailErr,
    Math.abs(p.tx - (SPEC.x0 + SPEC.vx * dt - UX * (SPEC.tail / 2))),
    Math.abs(p.ty - (SPEC.y0 + SPEC.vy * dt - UY * (SPEC.tail / 2))),
  );
}
check('phase2: the head flies the spec line (linear in t, one frame of lag allowed)',
  posErr < 0.4, `maxPosErr=${posErr?.toFixed(3)}`);
check('phase2: the tail chases the head at half its length behind',
  tailErr < 0.4, `maxTailErr=${tailErr?.toFixed(3)}`);
const p0 = mid[0];
check('phase2: the tail points along the velocity (bright end leads at the head)',
  Math.abs(p0.rot - Math.atan2(SPEC.vy, SPEC.vx)) < 0.02 && Math.abs(p0.sx - SPEC.tail) < 0.01,
  `rot=${p0.rot?.toFixed(3)} want ${Math.atan2(SPEC.vy, SPEC.vx).toFixed(3)} sx=${p0.sx}`);
check('phase2: the head is hot and the tail is a soft wash mid-flight',
  mid.every((p) => p.hop > 0.9 && p.top > 0.45 && p.top < 0.66) && mid.every((p) => Math.abs(p.hz + 30) < 1e-6),
  `hop~${mid[0]?.hop?.toFixed(2)} top~${mid[0]?.top?.toFixed(2)}`);
const ramp = samples.filter((p) => p.u < 0.12);
check('phase2: the head fades in over the first part of the flight',
  ramp.length > 1 && ramp[0].hop < 0.5 && Math.min(...ramp.map((p) => p.hop)) < Math.max(...samples.filter((p) => p.u > 0.3).map((p) => p.hop)),
  `early=${ramp[0]?.hop?.toFixed(2)}`);

// ---- Phase 3: synchronous pixel A/B (hide the meteor rig between renders) ----
const SPEC2 = { x0: 12, y0: 23, vx: -16, vy: -6, z: -30, life: 1.8, tail: 5 };
await page.evaluate((spec) => {
  const r = window.__tetris.renderer;
  window.__meteorSpec2 = { ...spec, t0: r.time + 0.25 };
  r.spawnMeteor(window.__meteorSpec2);
}, SPEC2);
const mid2 = await waitUntil(() => {
  const r = window.__tetris.renderer;
  const S = window.__meteorSpec2;
  const u = (r.time - S.t0) / S.life;
  return u > 0.35 && u < 0.6;
}, null, 25000);
const s3 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const S = window.__meteorSpec2;
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
    let maxD = 0, sum = 0, n = 0;
    for (let y = cy - bh; y <= cy + bh; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = cx - bw; x <= cx + bw; x++) {
        if (x < 0 || x >= W) continue;
        const i = (y * W + x) * 4;
        const d = Math.abs(lum(dataA, i) - lum(dataB, i));
        if (d > maxD) maxD = d;
        sum += d;
        n++;
      }
    }
    return { maxD, meanD: n ? sum / n : 0 };
  }
  const P = (x, y, z) => {
    const p = r.projectToPixel(x, y, z);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  };
  // Current screen positions of EVERY active meteor (halo-exclusion for the
  // control scan; the A/B itself cancels co-flying meteors exactly).
  const actives = [];
  for (const slot of r.meteors) {
    if (!slot.m) continue;
    const m = slot.m;
    const dt = Math.max(0, r.time - m.t0);
    const x = m.x0 + m.vx * dt;
    const y = m.y0 + m.vy * dt;
    const vl = Math.hypot(m.vx, m.vy);
    actives.push([P(x, y, m.z), P(x - (m.vx / vl) * (m.tail || 5) / 2, y - (m.vy / vl) * (m.tail || 5) / 2, m.z)]);
  }
  const a = grab();
  r.meteorGroup.visible = false;
  const b = grab();
  r.meteorGroup.visible = true;
  const dt = Math.max(0, r.time - S.t0);
  const hx = S.x0 + S.vx * dt;
  const hy = S.y0 + S.vy * dt;
  const vl = Math.hypot(S.vx, S.vy);
  const head = P(hx, hy, S.z);
  const tail = P(hx - (S.vx / vl) * (S.tail / 2), hy - (S.vy / vl) * (S.tail / 2), S.z);
  function near(px, py, R) {
    return actives.some((pair) => pair.some((q) => Math.hypot(q.x - px, q.y - py) < R));
  }
  const out = {
    head: band(a, b, head.x, head.y, 24, 10),
    tail: band(a, b, tail.x, tail.y, 20, 8),
    headPx: [head.x, head.y],
    tailPx: [tail.x, tail.y],
  };
  const W = c.width, H = c.height;
  let best = { maxD: Infinity, x: 0, y: 0 };
  for (let wy = 40; wy < H - 20; wy += 30) {
    for (let wx = 20; wx < W - 30; wx += 30) {
      if (near(wx, wy, 200)) continue; // clear the head/tail bloom halos
      const st = band(a, b, wx, wy, 14, 7);
      if (st.maxD < best.maxD) best = { ...st, x: wx, y: wy };
    }
  }
  out.ctl = best;
  return out;
});
check('phase3: the in-flight head carries hot light (A/B vs hidden)',
  mid2 !== null && s3.head.maxD > 30, `maxD=${s3.head?.maxD?.toFixed(1)} at (${s3.headPx?.join(',')})`);
check('phase3: the head is hotter than the tail band',
  s3.head.maxD > s3.tail.maxD && s3.tail.maxD > 8,
  `head=${s3.head?.maxD?.toFixed(1)} tail=${s3.tail?.maxD?.toFixed(1)}`);
check('phase3: feature-free control window is flat (A/B cancels the background)',
  s3.ctl.maxD < 5, `maxD=${s3.ctl?.maxD?.toFixed(1)} at (${s3.ctl?.x},${s3.ctl?.y})`);

// ---- Phase 4: the in-flight meteor sheds its spark drizzle ----
const SPEC3 = { x0: 8, y0: 21, vx: -10, vy: -4, z: -30, life: 1.5, tail: 5 };
await page.evaluate((spec) => {
  const r = window.__tetris.renderer;
  window.__meteorSpec3 = { ...spec, t0: r.time + 0.5 };
  r.spawnMeteor(window.__meteorSpec3);
}, SPEC3);
const s4wait = await waitUntil(() => {
  const r = window.__tetris.renderer;
  let n = 0;
  for (let i = 0; i < r.pCount; i++)
    if (r.pLife[i] > 0 && r.pBase[i * 3 + 2] >= 1.7) n++;
  return n >= 5;
}, null, 25000);
const s4 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  let n = 0, g13 = 0;
  for (let i = 0; i < r.pCount; i++)
    if (r.pLife[i] > 0 && r.pBase[i * 3 + 2] >= 1.7) {
      n++;
      if (Math.abs(r.pGrav[i] - 13) < 0.01) g13++;
    }
  return { n, g13 };
});
check('phase4: the in-flight meteor sheds spark drizzle (cool B-base signature, no other spawner writes it)',
  s4wait !== null && s4.n >= 5, `after ${s4wait}ms n=${s4.n}`);
check('phase4: every meteor spark uses the mid gravity (above the dissolve-ember probe, below line-clear)',
  s4.g13 === s4.n, `g13=${s4.g13}/${s4.n}`);

// ---- Phase 5: the level palette re-inks head, tail and sparks ----
await page.evaluate(() => window.__tetris.renderer.onLevelUp(8));
const inkWait = await waitUntil(() => {
  const r = window.__tetris.renderer;
  return Math.abs(r.levelHue - r.levelHueTarget) < 1e-4 && r.spotPulse < 0.05;
}, null, 30000);
check('phase5: the stage hue converges to the deep (level 8) palette', inkWait !== null, `after ${inkWait}ms`);
const s5a = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const d = (c, b) => Math.max(Math.abs(c.r - b.r), Math.abs(c.g - b.g), Math.abs(c.b - b.b));
  return {
    headD: d(r.meteorHeadColor, r.meteorHeadBase),
    tailD: d(r.meteorTailColor, r.meteorTailBase),
    sparkD: d(r.meteorSparkColor, r.meteorSparkBase),
  };
});
check('phase5: the meteor palette re-inked off the neutral base (head/tail/sparks)',
  s5a.headD > 0.02 && s5a.tailD > 0.02 && s5a.sparkD > 0.02,
  `head=${s5a.headD?.toFixed(3)} tail=${s5a.tailD?.toFixed(3)} spark=${s5a.sparkD?.toFixed(3)}`);
const SPEC5 = { x0: -12, y0: 24, vx: 6, vy: -2, z: -30, life: 2.2, tail: 5 };
await page.evaluate((spec) => {
  const r = window.__tetris.renderer;
  window.__meteorSpec5 = { ...spec, t0: r.time + 0.2 };
  r.spawnMeteor(window.__meteorSpec5);
}, SPEC5);
const mid5 = await waitUntil(() => {
  const r = window.__tetris.renderer;
  const S = window.__meteorSpec5;
  const u = (r.time - S.t0) / S.life;
  return u > 0.2 && u < 0.7;
}, null, 25000);
const s5 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const S = window.__meteorSpec5;
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
  const m = S;
  const dt = Math.max(0, r.time - m.t0);
  const hx = m.x0 + m.vx * dt;
  const hy = m.y0 + m.vy * dt;
  const vl = Math.hypot(m.vx, m.vy);
  const head = P(hx, hy, m.z);
  const tail = P(hx - (m.vx / vl) * (m.tail / 2), hy - (m.vy / vl) * (m.tail / 2), m.z);
  // Synchronous A/B that UN-INKS only the meteor palette between renders —
  // the re-inked stage stays put, so a flat control window is valid and the
  // diff isolates exactly the meteor's palette shift.
  const hN = [r.meteorHeadColor.r, r.meteorHeadColor.g, r.meteorHeadColor.b];
  const tN = [r.meteorTailColor.r, r.meteorTailColor.g, r.meteorTailColor.b];
  const a = grab(); // re-inked meteor
  r.meteorHeadColor.setRGB(r.meteorHeadBase.r, r.meteorHeadBase.g, r.meteorHeadBase.b);
  r.meteorTailColor.setRGB(r.meteorTailBase.r, r.meteorTailBase.g, r.meteorTailBase.b);
  const b = grab(); // meteor un-inked, stage untouched
  r.meteorHeadColor.setRGB(hN[0], hN[1], hN[2]);
  r.meteorTailColor.setRGB(tN[0], tN[1], tN[2]);
  const out = {
    head: band(a, b, head.x, head.y, 24, 10),
    tail: band(a, b, tail.x, tail.y, 20, 8),
    headPx: [head.x, head.y],
  };
  const W = c.width, H = c.height;
  let best = { maxD: Infinity, x: 0, y: 0 };
  for (let wy = 40; wy < H - 20; wy += 30) {
    for (let wx = 20; wx < W - 30; wx += 30) {
      if (Math.hypot(wx - head.x, wy - head.y) < 200) continue;
      if (Math.hypot(wx - tail.x, wy - tail.y) < 200) continue;
      const st = band(a, b, wx, wy, 14, 7);
      if (st.maxD < best.maxD) best = { ...st, x: wx, y: wy };
    }
  }
  out.ctl = best;
  return out;
});
check('phase5: the deep re-ink visibly shifts the head band channel mix (meteor-only A/B)',
  mid5 !== null && Math.abs(s5.head.dR) + Math.abs(s5.head.dB) > 8,
  `|dR|+|dB|=${(Math.abs(s5.head?.dR || 0) + Math.abs(s5.head?.dB || 0)).toFixed(1)} at (${s5.headPx?.join(',')})`);
check('phase5: the tail re-ink shows in its band', s5.tail.maxD > 6, `maxD=${s5.tail?.maxD?.toFixed(1)}`);
check('phase5: the stage (aurora/sky) is untouched by the meteor A/B — control holds',
  s5.ctl.maxD < 5, `maxD=${s5.ctl?.maxD?.toFixed(1)} at (${s5.ctl?.x},${s5.ctl?.y})`);

// ---- Phase 6: the lights out dims the in-flight meteor and holds new spawns ----
const s6pre = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  r.meteorNext = r.time; // due immediately: a lit stage would auto-spawn now
  r.spawnMeteor({ x0: 10, y0: 22, vx: -8, vy: -3, z: -30, t0: r.time + 0.15, life: 3.0, tail: 5 });
  return { count: r.meteorCount };
});
const mid6 = await waitUntil(() => {
  const r = window.__tetris.renderer;
  const slot = r.meteors.find((s) => s.m && s.m.life === 3.0);
  if (!slot) return false;
  return (r.time - slot.m.t0) / slot.m.life > 0.3;
}, null, 25000);
const s6a = await page.evaluate(() => {
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
  const slot = r.meteors.find((s) => s.m && s.m.life === 3.0);
  const m = slot.m;
  const dt = Math.max(0, r.time - m.t0);
  const p = r.projectToPixel(m.x0 + m.vx * dt, m.y0 + m.vy * dt, m.z);
  const px = Math.round(p.x), py = Math.round(p.y);
  let s = 0, n = 0;
  for (let y = py - 10; y <= py + 10; y++)
    for (let x = px - 24; x <= px + 24; x++) {
      if (x < 0 || x >= W || y < 0 || y >= c.height) continue;
      const i = (y * W + x) * 4;
      s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      n++;
    }
  return { lum: n ? s / n : null, top: slot.tailMat.opacity, count: r.meteorCount };
});
await page.evaluate(() => window.__tetris.renderer.onGameOver());
const dimWait = await waitUntil(() => window.__tetris.renderer.overDim > 0.5, null, 30000);
const s6b = await page.evaluate(() => {
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
  const slot = r.meteors.find((s) => s.m && s.m.life === 3.0);
  let lum = null, top = null, hv = null;
  if (slot) {
    const m = slot.m;
    const dt = Math.max(0, r.time - m.t0);
    const p = r.projectToPixel(m.x0 + m.vx * dt, m.y0 + m.vy * dt, m.z);
    const px = Math.round(p.x), py = Math.round(p.y);
    let s = 0, n = 0;
    for (let y = py - 10; y <= py + 10; y++)
      for (let x = px - 24; x <= px + 24; x++) {
        if (x < 0 || x >= W || y < 0 || y >= c.height) continue;
        const i = (y * W + x) * 4;
        s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        n++;
      }
    lum = n ? s / n : null;
    top = slot.tailMat.opacity;
    hv = slot.head.visible;
  }
  return { lum, top, hv, count: r.meteorCount, overDim: r.overDim };
});
check('phase6: the lights-out ramp reached the meteor dim', dimWait !== null, `after ${dimWait}ms`);
check('phase6: the in-flight meteor dims with the stage (tail opacity down, still flying)',
  mid6 !== null && s6a.top !== null && s6b.top !== null && s6b.top < s6a.top * 0.8 && s6b.hv === true,
  `tail ${s6a.top?.toFixed(2)} -> ${s6b.top?.toFixed(2)} overDim=${s6b.overDim?.toFixed(2)}`);
check('phase6: the meteor head band dims with the lights out',
  s6a.lum !== null && s6b.lum !== null && s6b.lum < s6a.lum * 0.9,
  `${s6a.lum?.toFixed(1)} -> ${s6b.lum?.toFixed(1)}`);
check('phase6: no new meteor spawns while the stage is dark (auto-spawn was due)',
  s6b.count === s6pre.count + 1, `count ${s6pre.count} -> ${s6b.count}`);

// ---- Phase 7: restart clears the pool, restores the neutral palette, re-arms ----
await page.keyboard.press('r');
const rstWait = await waitUntil(() => {
  const r = window.__tetris.renderer;
  return r.over === false && r.levelHue === 0;
}, null, 10000);
const s7 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const d = (c, b) => Math.max(Math.abs(c.r - b.r), Math.abs(c.g - b.g), Math.abs(c.b - b.b));
  return {
    cleared: r.meteors.every((s) => !s.m && !s.head.visible && !s.tail.visible && s.headMat.opacity === 0 && s.tailMat.opacity === 0),
    headNeutral: d(r.meteorHeadColor, r.meteorHeadBase) < 1e-6,
    tailNeutral: d(r.meteorTailColor, r.meteorTailBase) < 1e-6,
    reArmed: r.meteorNext > r.time,
  };
});
check('phase7: restart cleared the meteor pool', rstWait !== null && s7.cleared);
check('phase7: the exact neutral meteor palette is restored', s7.headNeutral && s7.tailNeutral);
check('phase7: the auto-spawn schedule re-armed for the fresh game', s7.reArmed);
const autoWait = await waitUntil(() => {
  const r = window.__tetris.renderer;
  return r.meteors.some((s) => s.m && s.head.visible);
}, null, 45000);
check('phase7: the auto-spawn scheduler fires a meteor on its own', autoWait !== null, `after ${autoWait}ms`);

check('no page/console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}: ${results.length - failed}/${results.length}`);