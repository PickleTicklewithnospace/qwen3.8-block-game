// Browser regression: the line-clear light sweep. Each contiguous run of
// cleared rows is wiped by a bright edge that rips across the FULL board
// width (alternating direction per clear), trailing a soft glow tinted
// with the run's row palette behind it. TETRIS runs get a hotter, taller,
// longer wipe; the Reflector doubles the whole wipe in the stage glass.
//
// Proven three ways, all from ONE in-page rAF probe per clear (started
// before the drop so the short mid-flight window can't be missed; pinned
// on window so slow SwiftShader frames can't GC the evaluate promise):
//   state  - exactly one sweep per run (swept counter), direction
//            alternates between back-to-back clears, TETRIS runs carry the
//            tall/hot signature (h=4, gain 1.75, longer duration);
//   time   - in-transit samples read (t, x) atomically in the same frame:
//            the edge sits strictly between the run's start and end, on
//            the constant-velocity line x = lerp(xA, xB, t), and advances
//            monotonically with dir across consecutive frames;
//   pixels - a synchronous A/B inside the same frame that catches the wipe
//            mid-flight: hide the sweep groups, render + grab; restore,
//            render + grab. The row band differs strongly (edge + trail +
//            bloom halo) while a control band well above the run's TOP
//            edge stays flat (a center-relative band sits inside the bloom
//            halo of a tall hot sweep) — no tick runs between the two
//            renders, so every other uniform-driven effect (grain, aurora,
//            camera sway, the concurrent clear flashes) cancels exactly.
//
// Usage: node test/light-sweep.mjs [url]

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
function key(type, k) {
  return page.evaluate(([t, k]) => {
    window.dispatchEvent(new KeyboardEvent(t, { key: k }));
  }, [type, k]);
}
async function waitUntil(pred, arg, timeoutMs = 15000, pollMs = 50) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred, arg)) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(pollMs);
  }
}

// Fresh game: empty board + given cells, piece parked, timing/input reset.
// The sweep pool is cleared but the PARITY is NOT re-armed: direction
// alternation across back-to-back clears is part of what the suite proves,
// so phases observe the renderer's own parity state (returned to the
// caller) and expect the direction it will produce.
async function setup(spec) {
  return page.evaluate((s) => {
    const g = window.__tetris.game;
    const r = window.__tetris.renderer;
    g.gameOver = false;
    g.paused = false;
    g.level = s.level || 1;
    if (s.lines !== undefined) g.lines = s.lines;
    for (let y = 0; y < g.board.length; y++) g.board[y].fill(null);
    for (const [y, x, t] of s.cells || []) g.board[y][x] = t;
    g.current = { type: s.type, rotation: s.rotation || 0, x: s.x, y: s.y };
    g.lock = { resets: 0, lastReset: false };
    g.clearRows = [];
    g.lastClear = 0;
    const t = window.__tetris.timing;
    t.lockTimer = null;
    t.gravityAccum = 0;
    t.softAccum = 0;
    t.das = 0;
    t.arr = 0;
    t.freeze = 0;
    window.__tetris.dirInput.held.length = 0;
    window.__tetris.dirInput.dir = 0;
    for (const sw of r.sweeps) {
      sw.t = 1;
      sw.group.visible = false;
      sw.edge.material.opacity = 0;
      sw.trail.material.opacity = 0;
    }
    return { swept: r.swept, parity: r.sweepParity, level: g.level };
  }, spec);
}

const hardDrop = async () => {
  await key('keydown', ' ');
  await key('keyup', ' ');
};

// One in-page rAF probe per clear. Collects in-transit sweep samples each
// frame (t and x read atomically in the SAME frame — a second evaluate
// would resolve a frame late and read stale positions) and, on the first
// frame whose visible sweep t lands in [abMin, abMax], runs the
// synchronous A/B pixel capture (hide sweep groups -> render + grab ->
// restore -> render + grab; no tick between renders). Resolves when all
// spawned sweeps finished (marking the A/B missed if no mid-flight frame
// landed) or at the deadline. GC-pinned on window for slow frames.
function startSweepProbe(sweptBefore, abMin, abMax, ms = 12000) {
  return page.evaluate(
    ([s0, a, b, ms]) => {
      const r = window.__tetris.renderer;
      const out = { samples: [], ab: null };
      const seen = {};
      const t0 = performance.now();
      let finished = false;
      const p = new Promise((resolve) => {
        const finish = () => {
          if (finished) return;
          finished = true;
          if (!out.ab) out.ab = { missed: true };
          resolve(out);
        };
        const step = () => {
          if (finished) return;
          // State samples: one per (sweep, t) so a slow frame that jumps
          // t is still sampled at its new value.
          for (let i = 0; i < r.sweeps.length; i++) {
            const sw = r.sweeps[i];
            if (sw.t > 0.12 && sw.t < 0.92) {
              seen[i] = seen[i] || [];
              if (!seen[i].includes(sw.t)) {
                seen[i].push(sw.t);
                out.samples.push({
                  i,
                  t: sw.t,
                  dir: sw.dir,
                  h: sw.h,
                  gain: sw.gain,
                  dur: sw.dur,
                  xA: sw.xA,
                  xB: sw.xB,
                  x: sw.edge.position.x,
                  y: sw.edge.position.y,
                  vis: sw.group.visible,
                });
              }
            }
          }
          // Pixel A/B on the first mid-flight frame.
          if (!out.ab) {
            const sw = r.sweeps.find((s) => s.t >= a && s.t <= b && s.group.visible);
            if (sw) {
              const proj = (wx, wy) => {
                const pp = r.projectToPixel(wx, wy, 0.3);
                return { x: Math.round(pp.x), y: Math.round(pp.y) };
              };
              const rect = (yc, x0, x1, ySpan) => {
                const q0 = proj(x0, yc - ySpan);
                const q1 = proj(x1, yc + ySpan);
                return {
                  x0: Math.min(q0.x, q1.x),
                  x1: Math.max(q0.x, q1.x),
                  y0: Math.min(q0.y, q1.y),
                  y1: Math.max(q0.y, q1.y),
                };
              };
              // Wipe band: full board width at the run's world y. Control
              // band sits well ABOVE the run's top edge (not above its
              // center): a tall hot sweep's bloom halo reaches a couple of
              // world units beyond its edge, so a center-relative control
              // band measures the halo, not sky.
              const band = rect(sw.y, -5, 5, 0.95);
              const ctrl = rect(sw.y + sw.h / 2 + 3.6, -5, 5, 0.95);
              const renderGrab = () => {
                r.composer.render();
                const c = r.canvas;
                const o = document.createElement('canvas');
                o.width = c.width;
                o.height = c.height;
                const x2 = o.getContext('2d');
                x2.drawImage(c, 0, 0);
                const d = x2.getImageData(0, 0, c.width, c.height).data;
                return (px, py) => {
                  if (px < 0 || py < 0 || px >= c.width || py >= c.height) return null;
                  const i = (py * c.width + px) * 4;
                  return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
                };
              };
              const groups = r.sweeps.map((s) => s.group);
              const vis = groups.map((g) => g.visible);
              groups.forEach((g) => { g.visible = false; });
              const la = renderGrab();
              groups.forEach((g, i) => { g.visible = vis[i]; });
              const lb = renderGrab();
              const diff = (bb, fA, fB) => {
                let maxD = 0;
                let sum = 0;
                let n = 0;
                for (let y = bb.y0; y <= bb.y1; y += 2) {
                  for (let x = bb.x0; x <= bb.x1; x += 2) {
                    const da = fA(x, y);
                    const db = fB(x, y);
                    if (da === null || db === null) continue;
                    const dL = Math.abs(db - da);
                    if (dL > maxD) maxD = dL;
                    sum += dL;
                    n++;
                  }
                }
                return { maxD, mean: n ? sum / n : 0, n };
              };
              out.ab = { t: sw.t, dir: sw.dir, band: diff(band, la, lb), ctrl: diff(ctrl, la, lb) };
            }
          }
          if ((r.swept > s0 && r.sweeps.every((s) => s.t >= 1)) || performance.now() - t0 > ms) {
            finish();
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      // Pin the promise on window: slow SwiftShader frames give the page
      // GC time, and an unpinned evaluate promise can be collected ("Resulting
      // promise was garbage collected").
      window.__swpProbe = p;
      p.finally(() => { delete window.__swpProbe; });
      return p;
    },
    [sweptBefore, abMin, abMax, ms],
  );
}

// ---- Phase 1: single clear -> one right-to-left wipe, pixel-proven ----
// Row 21 full except the O's lane (cols 0-1); markers I(3,20) T(5,19)
// I(7,20) above it. O completes row 21: one contiguous run of height 1.
const gapRowsBottom = [];
for (let x = 2; x < 10; x++) gapRowsBottom.push([21, x, 'Z']);
const s0 = await setup({
  type: 'O',
  rotation: 0,
  x: 0,
  y: 10,
  level: 1,
  lines: 0,
  cells: [...gapRowsBottom, [20, 3, 'I'], [19, 5, 'T'], [20, 7, 'I']],
});
await waitUntil(
  (n) => window.__tetris.renderer.stackMeshes.size >= n,
  8 + 3,
  15000,
);
const probe1 = startSweepProbe(s0.swept, 0.3, 0.8);
await hardDrop();
const r1 = await probe1;
const swept1 = await page.evaluate(() => window.__tetris.renderer.swept);
check('phase1: exactly one sweep fired (one contiguous run)', swept1 - s0.swept === 1,
  `swept ${s0.swept} -> ${swept1}`);
check('phase1: wipe caught in transit', r1.samples.length >= 1,
  `samples=${r1.samples.length}`);
const wantDir1 = s0.parity === 0 ? -1 : 1;
if (r1.samples.length) {
  const c = r1.samples[0];
  check('phase1: wipe direction follows the armed parity', c.dir === wantDir1,
    `dir=${c.dir} wanted=${wantDir1} (parity=${s0.parity})`);
  check('phase1: run height is the single cleared row, normal heat', c.h === 1 && c.gain === 1.4,
    `h=${c.h} gain=${c.gain}`);
  const inRange = r1.samples.every(
    (q) => q.x > Math.min(q.xA, q.xB) + 0.1 && q.x < Math.max(q.xA, q.xB) - 0.1 && q.vis,
  );
  check('phase1: samples in transit strictly inside the sweep span, visible', inRange,
    r1.samples.map((q) => `t=${q.t.toFixed(2)} x=${q.x.toFixed(2)}`).join(' '));
  const onLine = r1.samples.every(
    (q) => Math.abs(q.x - (q.xA + (q.xB - q.xA) * q.t)) < 0.02,
  );
  check('phase1: edge sits on the constant-velocity line x=lerp(xA,xB,t)', onLine);
  const mono = r1.samples.length < 2
    ? true
    : r1.samples.slice(1).every((q, i) => (q.x - r1.samples[i].x) * q.dir >= 0);
  check('phase1: edge advances monotonically with dir across frames', mono,
    r1.samples.map((q) => q.x.toFixed(1)).join(','));
}
check('phase1 pixels: wipe caught mid-flight for the A/B', !r1.ab.missed,
  r1.ab.missed ? 'window missed' : `t=${r1.ab.t.toFixed(2)}`);
if (!r1.ab.missed) {
  check('phase1 pixels: the row band differs from its own hidden-scene A/B',
    r1.ab.band.maxD > 30 && r1.ab.band.n > 100,
    `maxD=${r1.ab.band.maxD.toFixed(1)} mean=${r1.ab.band.mean.toFixed(1)} n=${r1.ab.band.n}`);
  check('phase1 pixels: control band above the run top stays flat', r1.ab.ctrl.maxD < 18,
    `maxD=${r1.ab.ctrl.maxD.toFixed(1)}`);
}
const idle1 = await waitUntil(
  () => {
    const r = window.__tetris.renderer;
    return r.sweeps.every((s) => s.t >= 1 && !s.group.visible) && r.slides.length === 0;
  },
  null,
  15000,
);
check('phase1: sweep pool idle and hidden after the wipe', idle1);

// ---- Phase 2: TETRIS -> one tall, hot, longer left-to-right wipe ----
// Rows 18..21 filled except col 5; a VERTICAL I (rotation 1 occupies its
// x+2 column) at x=3 completes all four rows in one run of height 4. The
// filler at row 10 keeps the board from emptying (a TETRIS that also
// emptied the well would be a perfect clear and fire a SECOND, rainbow
// sweep on top of the run's wipe).
const tetRows = [];
for (const y of [18, 19, 20, 21]) for (let x = 0; x < 10; x++) if (x !== 5) tetRows.push([y, x, 'T']);
const s2 = await setup({ type: 'I', rotation: 1, x: 3, y: 2, level: 1, lines: 1, cells: [...tetRows, [10, 0, 'Z']] });
await waitUntil((n) => window.__tetris.renderer.stackMeshes.size >= n, 36, 15000);
const swept2a = s2.swept;
const probe2 = startSweepProbe(swept2a, 0.3, 0.8);
await hardDrop();
const r2 = await probe2;
const swept2b = await page.evaluate(() => window.__tetris.renderer.swept);
const lines2 = await page.evaluate(() => window.__tetris.game.lines);
check('phase2: four lines cleared (precondition)', lines2 === 5, `lines=${lines2}`);
check('phase2: exactly one sweep fired for the 4-row run', swept2b - swept2a === 1,
  `${swept2a} -> ${swept2b}`);
check('phase2: TETRIS wipe caught in transit', r2.samples.length >= 1,
  `samples=${r2.samples.length}`);
if (r2.samples.length) {
  const c2 = r2.samples[0];
  const wantDir2 = s2.parity === 0 ? -1 : 1;
  check('phase2: direction alternated vs phase 1', c2.dir === wantDir2 && wantDir2 !== wantDir1,
    `dir=${c2.dir} wanted=${wantDir2} (parity=${s2.parity}, phase1=${wantDir1})`);
  check('phase2: wipe is tall (h=4) and hot (gain 1.75)', c2.h === 4 && c2.gain === 1.75,
    `h=${c2.h} gain=${c2.gain}`);
  check('phase2: TETRIS wipe runs longer', c2.dur > 0.42, `dur=${c2.dur.toFixed(2)}`);
}
check('phase2 pixels: TETRIS wipe proven on screen via A/B',
  !r2.ab.missed && r2.ab.band.maxD > 30,
  r2.ab.missed ? 'window missed'
    : `maxD=${r2.ab.band.maxD.toFixed(1)}`);
check('phase2 pixels: control band above the hot run top stays flat',
  !r2.ab.missed && r2.ab.ctrl.maxD < 18,
  !r2.ab.missed ? `ctrl maxD=${r2.ab.ctrl.maxD.toFixed(1)}` : 'skipped');

// ---- Phase 3: a no-clear lock spawns no sweep ----
const s3 = await setup({ type: 'O', rotation: 0, x: 7, y: 10, level: 1, lines: 5, cells: [] });
await hardDrop();
await sleep(300);
const swept3 = await page.evaluate(() => window.__tetris.renderer.swept);
check('phase3: no-clear lock fires no sweep', swept3 === s3.swept, `${s3.swept} -> ${swept3}`);
const noActive = await page.evaluate(
  () => window.__tetris.renderer.sweeps.every((s) => !s.group.visible),
);
check('phase3: sweep pool stays hidden', noActive);

// ---- Phase 4: restart resets the sweep pool ----
await key('keydown', 'r');
await key('keyup', 'r');
const clean = await waitUntil(
  () => {
    const r = window.__tetris.renderer;
    return (
      r.stackMeshes.size === 0 &&
      r.sweeps.every((s) => s.t >= 1 && !s.group.visible && s.edge.material.opacity === 0)
    );
  },
  null,
  10000,
);
check('phase4: restart hides the sweep pool and clears opacities', clean);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);