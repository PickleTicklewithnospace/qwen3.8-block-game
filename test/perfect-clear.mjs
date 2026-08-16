// Browser regression: the perfect-clear celebration. When a line clear
// empties the board to ZERO blocks (the pure boardEmpty signal), the stage
// throws the full show: the gold-white PERFECT CLEAR! banner (yOff 3.1,
// floating above a concurrent TETRIS banner) with its anamorphic flare +
// dolly punch, the full-screen bloom flash, a full-board rainbow light
// sweep (the pooled rainbow texture), a DOUBLE sonic ring across the
// mirror glass (staggered 0.18 s via negative start times), a gold-white
// spark fountain off the well center, and the aurora/spot surge.
//
// Proven in-page:
//   state  - one combined in-page evaluate triggers the real hard drop via
//            window.__tetris.doHardDrop() and reads every event's state
//            synchronously (engine board, flash, punch, banners, rings,
//            rainbow sweep, fountain, uFlareY aiming);
//   pixels - an in-page rAF probe waits for the rainbow sweep mid-flight
//            (t in [0.3, 0.85]) and runs a SYNCHRONOUS A/B in the same
//            task (hide the perfect banner mesh + flare quads + zero
//            uFlare -> render + grab; restore -> render + grab). The
//            banner's projected band differs strongly; a coarse-grid
//            control window (streak row, echo, mirror wedge, banner
//            halo, and the in-flight sweep's bloom column all rejected)
//            stays flat — nothing ticks between the two renders, so the
//            concurrent sweep/flash/grain/aurora cancel exactly.
//
// Usage: node test/perfect-clear.mjs [url]

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8901/index.html';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('SwiftShader')) errors.push(m.text()); });

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(1500);

const results = [];
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fresh game: empty board + given cells, piece parked, timing/input reset,
// and the renderer's transient FX pools parked (popups, impacts, sweeps,
// flash, flare, punch) so each phase reads a clean slate.
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
    for (const p of r.popups) {
      p.t = 1;
      p.mesh.visible = false;
      p.mat.opacity = 0;
      p.yOff = 0;
      p.flareOn = false;
      p.flareMesh.visible = false;
      p.flareMat.opacity = 0;
    }
    for (const im of r.impacts) {
      im.t = 1;
      im.disc.visible = false;
      im.ring.visible = false;
    }
    for (const sw of r.sweeps) {
      sw.t = 1;
      sw.group.visible = false;
      sw.edge.material.opacity = 0;
      sw.trail.material.opacity = 0;
      sw.trail.material.map = r.sweepTrailTex; // stale rainbow maps from earlier phases
    }
    r.flash = 0;
    r.camPunch = 0;
    r.shake = 0;
    r.gradePass.uniforms.uFlare.value = 0;
    return { swept: r.swept };
  }, spec);
}

const waitIdlePopups = (ms = 20000) =>
  page.evaluate((ms) =>
    new Promise((res) => {
      const r = window.__tetris.renderer;
      const t0 = performance.now();
      const step = () => {
        if (
          r.popups.every((p) => p.t >= 1) &&
          r.gradePass.uniforms.uFlare.value < 0.03 &&
          r.flash === 0
        )
          return res(true);
        if (performance.now() - t0 > ms) return res(false);
        requestAnimationFrame(step);
      };
      step();
    }),
  ms);

// Rows `rows` filled in every column except the given gap column(s).
function gapRows(rows, missing = [5]) {
  const cells = [];
  for (const y of rows) for (let x = 0; x < 10; x++) if (!missing.includes(x)) cells.push([y, x, 'T']);
  return cells;
}

// One in-page evaluate: trigger the hard drop, read every event's state
// synchronously (nothing ticks between the drop and the reads), then
// rAF-poll for the RAINBOW sweep mid-flight (t in [abMin, abMax]) and run
// the synchronous A/B in that same frame. GC-pinned on window.
function dropAndProbe(abMin, abMax, ms = 15000) {
  return page.evaluate(
    ([a, b, ms]) => {
      const r = window.__tetris.renderer;
      const g = window.__tetris.game;
      const u = r.gradePass.uniforms;
      const out = { pre: null, ab: null };

      const grab = () => {
        r.composer.render();
        const c = r.canvas;
        const off = document.createElement('canvas');
        off.width = c.width;
        off.height = c.height;
        const ctx = off.getContext('2d');
        ctx.drawImage(c, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height);
      };
      const lum = (d, x, y) => {
        if (x < 0 || y < 0 || x >= r.canvas.width || y >= r.canvas.height) return null;
        const i = (y * r.canvas.width + x) * 4;
        return 0.2126 * d.data[i] + 0.7152 * d.data[i + 1] + 0.0722 * d.data[i + 2];
      };

      window.__tetris.doHardDrop();

      // ---- synchronous state reads (same task as the drop) ----
      const perfect = r.popups.find((p) => p.tier === 'perfect');
      const tetris = r.popups.find((p) => p.tier === 'tetris');
      const projY = (wy) => 1 - r.projectToPixel(0, wy, r.popupZ).y / r.canvas.height;
      const rainbowSweep = r.sweeps.find((s) => s.trail.material.map === r.rainbowTex && s.t < 1);
      const rings22 = r.impacts.filter((im) => Math.abs(im.k - 2.2) < 1e-9 && im.t < 1);
      let fountain = 0;
      for (let i = 0; i < r.pCount; i++) {
        if (r.pLife[i] > 0 && r.pBase[i * 3] >= 1.4) fountain++;
      }
      out.pre = {
        popupY: r.popupY,
        clears: g.clearRows.length,
        boardEmpty: g.board.every((row) => row.every((c) => c === null)),
        level: g.level,
        lines: g.lines,
        flash: r.flash,
        punch: r.camPunch,
        uFlareY: u.uFlareY.value,
        banner: perfect
          ? {
              text: perfect.text,
              yOff: perfect.yOff,
              pos: perfect.mesh.position.y,
              flareOn: perfect.flareOn,
              cr: perfect.flareMat.color.r,
              cg: perfect.flareMat.color.g,
              cb: perfect.flareMat.color.b,
              aim: projY(r.popupY + perfect.yOff),
            }
          : null,
        tetris: tetris
          ? { text: tetris.text, yOff: tetris.yOff, pos: tetris.mesh.position.y, flareOn: tetris.flareOn }
          : null,
        popTiers: r.popups.filter((p) => p.t < 1).map((p) => p.tier),
        rainbow: rainbowSweep
          ? { visible: rainbowSweep.group.visible, h: rainbowSweep.h, gain: rainbowSweep.gain }
          : null,
        whiteSweep: r.sweeps.some(
          (s) => s.trail.material.map !== r.rainbowTex && s.group.visible,
        ),
        rings22: rings22.map((im) => ({ t: im.t, vis: im.disc.visible })),
        fountain,
        sweepDir: r.sweepParity === 0 ? -1 : 1,
      };

      // ---- A/B on the first mid-flight rainbow-sweep frame ----
      // Captures are retried on later frames while the white-peak bloom
      // keeps a control window hot (the flare decays, the sweep keeps
      // flying); once the sweep exits the window the last capture stands.
      const capture = () => {
        const sw = r.sweeps.find(
          (s) => s.trail.material.map === r.rainbowTex && s.t >= a && s.t <= b && s.group.visible,
        );
        if (!sw) return;
        // Band: the live perfect banner's projected quad (its own bloom
        // halo is the feature).
        const pb = r.popups.find((p) => p.tier === 'perfect' && p.mesh.visible);
        const by = pb ? pb.mesh.position.y : r.popupY + 3.1;
        const bw = pb ? pb.w / 2 : 4.4;
        const bh = pb ? (pb.w * pb.aspect) / 2 : 1.1;
        const q = (wx, wy) => {
          const pp = r.projectToPixel(wx, wy, r.popupZ);
          return { x: Math.round(pp.x), y: Math.round(pp.y) };
        };
        const c0 = q(-bw, by - bh), c1 = q(bw, by - bh), c2 = q(bw, by + bh), c3 = q(-bw, by + bh);
        const band = {
          x0: Math.min(c0.x, c1.x, c2.x, c3.x),
          x1: Math.max(c0.x, c1.x, c2.x, c3.x),
          y0: Math.min(c0.y, c1.y, c2.y, c3.y),
          y1: Math.max(c0.y, c1.y, c2.y, c3.y),
        };
        const W = r.canvas.width;
        const H = r.canvas.height;
        // Only the PERFECT features are toggled in the A/B (its banner
        // mesh + flare quad + the grade streak it owns). Everything else
        // — the concurrent TETRIS banner/flare (phase 3), the line-clear
        // sweeps (rainbow AND white), flashes, rings, shards, grain,
        // aurora — is static between the two renders and cancels exactly,
        // so none of it needs a control rejection.
        const toggled = r.popups.filter((p) => p.tier === 'perfect' && p.flareOn);
        const Wc = r.canvas.width;
        const Hc = r.canvas.height;
        const streakY = Math.round((1 - u.uFlareY.value) * Hc);
        const echoY = Math.round((1 - (u.uFlareY.value + 0.3)) * Hc);
        const bannerRows = toggled
          .filter((p) => p.mesh.visible)
          .map((p) => Math.round(r.projectToPixel(0, p.mesh.position.y, r.popupZ).y));
        // The grade streak's bloom band is wide only while uFlare is hot.
        const streakBand = u.uFlare.value > 0.3 ? 260 : 100;
        const ctrlScan = (imA, imB) => {
          outer:
          for (let wy = 48; wy + 56 < Hc; wy += 40) {
            for (let wx = 48; wx + 56 < Wc; wx += 40) {
              const cxw = wx + 28;
              const cyw = wy + 28;
              if (Math.abs(cyw - streakY) < streakBand) continue;
              if (Math.abs(cxw - Wc / 2) < 90) continue; // vertical ghost column
              if (Math.abs(cyw - echoY) < 120 && Math.abs(cxw - Wc / 2) < 110) continue;
              if (cyw > Hc - 240) continue; // mirror-floor wedge (flare quad reflection)
              for (const byPx of bannerRows) if (Math.abs(cyw - byPx) < 200) continue outer;
              let m = 0;
              for (let y = wy; y < wy + 56; y += 4) {
                for (let x = wx; x < wx + 56; x += 4) {
                  const da = lum(imA, x, y);
                  const db = lum(imB, x, y);
                  if (da === null || db === null) continue;
                  const d = Math.abs(db - da);
                  if (d > m) m = d;
                }
              }
              return { max: m, at: [wx, wy] };
            }
          }
          return null;
        };
        const doAB = () => {
          const live = r.popups.filter((p) => p.tier === 'perfect' && p.flareOn);
          const vis = live.map((p) => p.flareMesh.visible);
          const meshVis = live.map((p) => p.mesh.visible);
          live.forEach((p) => {
            p.flareMesh.visible = false;
            p.mesh.visible = false;
          });
          u.uFlare.value = 0;
          const imA = grab();
          live.forEach((p, i) => {
            p.flareMesh.visible = vis[i];
            p.mesh.visible = meshVis[i];
          });
          u.uFlare.value = r.flare;
          const imB = grab();
          return { imA, imB };
        };
        const bandDiff = (imA, imB) => {
          let maxD = 0;
          let sum = 0;
          let n = 0;
          for (let y = band.y0; y <= band.y1; y += 2) {
            for (let x = band.x0; x <= band.x1; x += 2) {
              const da = lum(imA, x, y);
              const db = lum(imB, x, y);
              if (da === null || db === null) continue;
              const d = Math.abs(db - da);
              if (d > maxD) maxD = d;
              sum += d;
              n++;
            }
          }
          return { maxD, mean: n ? sum / n : 0, n };
        };
        const { imA, imB } = doAB();
        const ctrl = ctrlScan(imA, imB);
        const stillFlying = r.sweeps.some(
          (s) => s.trail.material.map === r.rainbowTex && s.t < 1 && s.group.visible,
        );
        // Every ALIVE perfect ring must be visible: the staggered one
        // (spawned at t = -0.18) only turns live when tick() arms it at
        // the t >= 0 crossing.
        const ringsOk = r.impacts
          .filter((im) => Math.abs(im.k - 2.2) < 1e-9 && im.t < 1)
          .every((im) => im.disc.visible && im.ring.visible);
        if ((ctrl !== null && ctrl.max <= 25) || !stillFlying) {
          out.ab = {
            t: r.sweeps.find((s) => s.trail.material.map === r.rainbowTex && s.t < 1).t,
            band: bandDiff(imA, imB),
            ctrl: ctrl ? ctrl.max : null,
            ringsOk,
          };
        } else if (!out.ab) {
          // Hot control: remember the capture and retry next frame.
          out.ab = { t: sw.t, band: bandDiff(imA, imB), ctrl: ctrl ? ctrl.max : null, ringsOk, retry: true };
        }
      };
      let settled = false;
      const p = new Promise((resolve) => {
        const t0 = performance.now();
        const finish = (o) => {
          if (settled) return;
          settled = true;
          resolve(o);
        };
        const step = () => {
          if (settled) return;
          if (out.ab && !out.ab.retry) return finish(out);
          if (performance.now() - t0 > ms) {
            if (!out.ab) out.ab = { missed: true };
            else delete out.ab.retry;
            return finish(out);
          }
          capture();
          requestAnimationFrame(step);
        };
        step();
      });
      window.__pcProbe = p;
      p.finally(() => {
        delete window.__pcProbe;
      });
      return p;
    },
    [abMin, abMax, ms],
  );
}

// ---- Phase 1: rest state (banner tier wired, pools idle) -----------------

const rest = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const gp = r.composer.passes[r.composer.passes.length - 1];
  const u = gp && gp.uniforms;
  return {
    isLast: !!(gp && gp.material && gp.material.name === 'CinematicGradeShader' && u && u.uFlare && u.uFlareY),
    uFlare: u ? u.uFlare.value : -1,
    yOffs: r.popups.map((p) => p.yOff),
    hidden: r.popups.every((p) => !p.mesh.visible && !p.flareMesh.visible),
    impacts: r.impacts.every((im) => !im.disc.visible && !im.ring.visible),
  };
});
check('grade pass installed last with live flare uniforms (0 at rest)',
  rest.isLast && rest.uFlare === 0, `uFlare ${rest.uFlare}`);
check('every popup slot owns a yOff (0 at rest) and the pools are idle',
  rest.yOffs.length === 3 && rest.yOffs.every((v) => v === 0) && rest.hidden && rest.impacts,
  `yOffs ${rest.yOffs.join(',')}`);

// ---- Phase 2: 1-line perfect clear -> the full celebration ---------------
// Row 21 full except a 4-cell gap (cols 4-7); a FLAT I (rotation 0 occupies
// row 1, cols 0-3) at x=4 drops into the gap: one line clears and the
// board is EMPTY -> onPerfect fires (no TETRIS: a single line). A vertical
// I would leave 3 residue blocks and could never perfect a single row.

const s2 = await setup({ type: 'I', rotation: 0, x: 4, y: 10, level: 1, lines: 0, cells: gapRows([21], [4, 5, 6, 7]) });
await page
  .evaluate((n) =>
    new Promise((res) => {
      const r = window.__tetris.renderer;
      const t0 = performance.now();
      const step = () => {
        if (r.stackMeshes.size >= n || performance.now() - t0 > 15000) return res();
        requestAnimationFrame(step);
      };
      step();
    }),
  6)
  .catch(() => {});
const p2 = await dropAndProbe(0.3, 0.85);
const pre2 = p2.pre || {};
check('phase2: the drop completed the single row and emptied the board',
  pre2.clears === 1 && pre2.boardEmpty === true,
  `clears=${pre2.clears} empty=${pre2.boardEmpty}`);
check('phase2: the lock stayed level 1 (no LEVEL banner)',
  pre2.level === 1 && pre2.popTiers.includes('perfect') && !pre2.popTiers.includes('level'),
  `level=${pre2.level} tiers=${(pre2.popTiers || []).join(',')}`);
check('phase2: full-screen flash + dolly punch fired',
  pre2.flash === 1 && pre2.punch === 1,
  `flash=${pre2.flash} punch=${pre2.punch}`);
check('phase2: the PERFECT CLEAR! banner owns the flare at the elevated yOff',
  pre2.banner && pre2.banner.text === 'PERFECT CLEAR!' && pre2.banner.yOff === 3.1 &&
    pre2.banner.flareOn === true && Math.abs(pre2.banner.pos - (pre2.popupY + pre2.banner.yOff)) < 0.2,
  pre2.banner ? `${pre2.banner.text} yOff=${pre2.banner.yOff} pos=${pre2.banner.pos.toFixed(2)}` : 'no banner');
check('phase2: the perfect flare quad is warm gold (HDR, r > g > b — gold, not cool cyan)',
  pre2.banner && pre2.banner.cr > 1.4 && pre2.banner.cr > pre2.banner.cg && pre2.banner.cg > pre2.banner.cb,
  pre2.banner ? `rgb(${pre2.banner.cr.toFixed(2)},${pre2.banner.cg.toFixed(2)},${pre2.banner.cb.toFixed(2)})` : '');
check('phase2: the grade streak is aimed at the elevated banner height',
  pre2.banner && Math.abs(pre2.banner.aim - pre2.uFlareY) < 0.03,
  pre2.banner ? `uFlareY ${pre2.uFlareY.toFixed(3)} vs ${pre2.banner.aim.toFixed(3)}` : '');
check('phase2: a full-board rainbow sweep fired (h=20, hot)',
  pre2.rainbow && pre2.rainbow.visible && pre2.rainbow.h === 20 && pre2.rainbow.gain === 1.75,
  pre2.rainbow ? `h=${pre2.rainbow.h} gain=${pre2.rainbow.gain}` : 'none');
check('phase2: the line-clear white sweep fired alongside (one per run)',
  pre2.whiteSweep === true, `whiteSweep=${pre2.whiteSweep}`);
check('phase2: a double sonic ring is armed (one live, one staggered negative)',
  pre2.rings22.length === 2 &&
    pre2.rings22.some((r) => r.t >= 0 && r.vis) &&
    pre2.rings22.some((r) => r.t < 0 && !r.vis),
  JSON.stringify(pre2.rings22));
check('phase2: the gold fountain erupted (54 gold sparks, R>=1.4 signature)',
  pre2.fountain >= 50, `gold sparks=${pre2.fountain}`);

check('phase2 pixels: rainbow sweep caught mid-flight for the A/B',
  !!p2.ab && !p2.ab.missed, p2.ab && p2.ab.missed ? 'window missed' : p2.ab ? `t=${p2.ab.t.toFixed(2)}` : '');
if (p2.ab && !p2.ab.missed) {
  check('phase2 pixels: the perfect banner band carries the celebration light',
    p2.ab.band.maxD > 40 && p2.ab.band.n > 100,
    `maxD=${p2.ab.band.maxD.toFixed(1)} mean=${p2.ab.band.mean.toFixed(1)} n=${p2.ab.band.n}`);
  check('phase2 pixels: clean control window stays flat',
    p2.ab.ctrl !== null && p2.ab.ctrl < 25, `ctrl max|ΔL| ${p2.ab.ctrl === null ? 'n/a' : p2.ab.ctrl.toFixed(1)}`);
  check('phase2: the staggered second ring is armed live by mid-flight (tick arms it at the t>=0 crossing)',
    p2.ab.ringsOk === true, `ringsOk=${p2.ab.ringsOk}`);
}

await waitIdlePopups();

// ---- Phase 3: TETRIS perfect (4 lines) -> both banners stacked ------------
// Rows 18..21 full except col 5; the same vertical I completes all four
// rows in one run -> TETRIS! (yOff 0) AND PERFECT CLEAR! (yOff 3.1).

await setup({ type: 'I', rotation: 1, x: 3, y: 2, level: 1, lines: 1, cells: gapRows([18, 19, 20, 21], [5]) });
await page
  .evaluate((n) =>
    new Promise((res) => {
      const r = window.__tetris.renderer;
      const t0 = performance.now();
      const step = () => {
        if (r.stackMeshes.size >= n || performance.now() - t0 > 15000) return res();
        requestAnimationFrame(step);
      };
      step();
    }),
  24)
  .catch(() => {});
const p3 = await dropAndProbe(0.3, 0.85);
const pre3 = p3.pre || {};
check('phase3: four lines cleared and the board is empty',
  pre3.clears === 4 && pre3.boardEmpty === true,
  `clears=${pre3.clears} empty=${pre3.boardEmpty}`);
check('phase3: TETRIS! and PERFECT CLEAR! banners stack without overlap (yOff 0 vs 3.1)',
  pre3.tetris && pre3.banner &&
    pre3.tetris.text === 'TETRIS!' && pre3.tetris.yOff === 0 &&
    pre3.banner.text === 'PERFECT CLEAR!' && pre3.banner.yOff === 3.1 &&
    pre3.banner.pos - pre3.tetris.pos > 2.5,
  pre3.tetris && pre3.banner
    ? `tetris pos=${pre3.tetris.pos.toFixed(2)} perfect pos=${pre3.banner.pos.toFixed(2)}`
    : 'missing banner');
check('phase3: flash + punch + rainbow sweep + double ring all fired',
  pre3.flash === 1 && pre3.punch === 1 && pre3.rainbow && pre3.rainbow.visible && pre3.rings22.length === 2,
  `flash=${pre3.flash} rings=${(pre3.rings22 || []).length}`);
check('phase3: the grade streak is aimed at the PERFECT banner (the last showPopup)',
  pre3.banner && Math.abs(pre3.banner.aim - pre3.uFlareY) < 0.03,
  pre3.banner ? `uFlareY ${pre3.uFlareY.toFixed(3)} vs ${pre3.banner.aim.toFixed(3)}` : '');
check('phase3 pixels: both-banner A/B band carries the light',
  !!p3.ab && !p3.ab.missed && p3.ab.band.maxD > 40,
  p3.ab && !p3.ab.missed ? `maxD=${p3.ab.band.maxD.toFixed(1)}` : 'window missed');
check('phase3 pixels: control stays flat',
  !!p3.ab && !p3.ab.missed && p3.ab.ctrl !== null && p3.ab.ctrl < 25,
  p3.ab && !p3.ab.missed ? `ctrl max|ΔL| ${p3.ab.ctrl === null ? 'n/a' : p3.ab.ctrl.toFixed(1)}` : '');

await waitIdlePopups();

// ---- Phase 4: a near-perfect (surviving filler) fires NO celebration -----
const s4 = await setup({
  type: 'I',
  rotation: 0,
  x: 4,
  y: 10,
  level: 1,
  lines: 0,
  cells: [...gapRows([21], [4, 5, 6, 7]), [19, 0, 'Z']],
});
const p4 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const g = window.__tetris.game;
  window.__tetris.doHardDrop();
  const boardEmpty = g.board.every((row) => row.every((c) => c === null));
  return {
    clears: g.clearRows.length,
    boardEmpty,
    flash: r.flash,
    punch: r.camPunch,
    uFlare: r.gradePass.uniforms.uFlare.value,
    tiers: r.popups.filter((p) => p.t < 1).map((p) => p.tier),
    rainbow: r.sweeps.some((s) => s.trail.material.map === r.rainbowTex && s.group.visible),
    rings22: r.impacts.filter((im) => Math.abs(im.k - 2.2) < 1e-9 && im.t < 1).length,
  };
});
check('phase4: the row cleared but the filler survived (no perfect)',
  p4.clears === 1 && p4.boardEmpty === false,
  `clears=${p4.clears} empty=${p4.boardEmpty}`);
check('phase4: no flash, no punch, no flare, no rainbow sweep, no ring',
  p4.flash === 0 && p4.punch === 0 && p4.uFlare === 0 &&
    !p4.tiers.includes('perfect') && !p4.rainbow && p4.rings22 === 0,
  `flash=${p4.flash} punch=${p4.punch} tiers=${p4.tiers.join(',')}`);

// ---- Phase 5: decay + restart re-arm --------------------------------------

const idle = await waitIdlePopups();
check('phase5: the celebration decays back to rest (banners, flare, flash)', idle === true);
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'r' }));
});
await sleep(400);
const armed = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  return {
    uFlare: r.gradePass.uniforms.uFlare.value,
    flash: r.flash,
    punch: r.camPunch,
    popups: r.popups.every((p) => !p.mesh.visible && p.yOff === 0),
    impacts: r.impacts.every((im) => !im.disc.visible && !im.ring.visible),
    sweeps: r.sweeps.every((s) => !s.group.visible),
  };
});
check('phase5: restart re-arms the pools (no flare, no flash, pools idle)',
  armed.uFlare === 0 && armed.flash === 0 && armed.punch === 0 && armed.popups && armed.impacts && armed.sweeps,
  `uFlare=${armed.uFlare} flash=${armed.flash}`);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);