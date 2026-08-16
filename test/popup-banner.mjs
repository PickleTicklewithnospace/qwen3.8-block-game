// Browser regression: the 3D popup banners (TETRIS! / LEVEL N / COMBO xN /
// TRIPLE / DOUBLE) + the TETRIS camera dolly punch.
//
// Banners are pooled quads with a per-spawn canvas texture (glowing type,
// additive, depthTest false, top renderOrder). The label logic is pure and
// unit-tested (src/fx-labels.js); this suite proves the VISUAL side:
//   - each major event spawns exactly the right banner (text + tier),
//   - the TETRIS banner actually renders on screen: an A/B capture hides the
//     live popup meshes, renders, restores them, renders again, and diffs —
//     the difference in the banner's projected region is the banner's own
//     pixels (plus bloom halo), while a far sky control stays flat,
//   - the TETRIS banner also fires the cinematic dolly (renderer.camPunch > 0),
//   - banners fade out and hide; singles show nothing; restart resets the
//     combo (a lone clear after a restart spawns no banner).
//
// Combo bookkeeping lives in main.js (window.__tetris.combo); the four clear
// cases below run back-to-back so the combo climbs 1 -> 4 across them.
//
// Usage: node test/popup-banner.mjs [url]

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
async function waitUntil(pred, arg, timeoutMs = 8000, pollMs = 25) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred, arg)) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}

// Fresh game, empty board (plus optional pre-filled cells), piece parked at
// the given position. Returns a tag on the placed piece.
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
    window.__tagSeq = (window.__tagSeq || 0) + 1;
    g.current.__tag = window.__tagSeq;
    return window.__tagSeq;
  }, spec);
}

// Rows `rows` filled in every column except the given gap column(s).
function gapRows(rows, missing = [3, 4]) {
  const cells = [];
  for (const y of rows) for (let x = 0; x < 10; x++) if (!missing.includes(x)) cells.push([y, x, 'T']);
  return cells;
}

// Active banners as { text, tier, t }.
const activePopups = () =>
  page.evaluate(() =>
    window.__tetris.renderer.popups
      .filter((p) => p.t < 1)
      .map((p) => ({ text: p.text, tier: p.tier, t: p.t })),
  );

const allPopupsFaded = () =>
  page.evaluate(() =>
    window.__tetris.renderer.popups.every(
      (p) => p.t >= 1 && !p.mesh.visible && p.mat.opacity === 0,
    ),
  );

// Wait for a banner with the given text to be well into its life (past the
// pop-in, before the fade-out, so opacity is flat during the A/B capture).
async function waitBanner(text, minTierT = 0.17, maxTierT = 0.65) {
  return waitUntil(
    (spec) => {
      const p = window.__tetris.renderer.popups.find(
        (q) => q.text === spec.txt && q.t >= spec.min && q.t <= spec.max,
      );
      return !!p;
    },
    { txt: text, min: minTierT, max: maxTierT },
    10000,
  );
}

// Project the banner quad's center to device pixels.
async function bannerCenter() {
  return page.evaluate(() => {
    const r = window.__tetris.renderer;
    r.composer.render();
    return r.projectToPixel(0, r.popupY, r.popupZ);
  });
}

// A/B pixel capture: hide the live banner meshes, render + grab; restore,
// render + grab; diff luminance in the banner region and in a far sky
// control. Identical everything else (uTime-driven grain/aurora may drift a
// few levels between grabs — the control window bounds that noise).
async function abDiff({ cx, cy, hw, hh, ctrlDy }) {
  return page.evaluate((b) => {
    const r = window.__tetris.renderer;
    const grab = () => {
      r.composer.render();
      const c = r.canvas;
      const off = document.createElement('canvas');
      off.width = c.width; off.height = c.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0);
      const img = ctx.getImageData(0, 0, c.width, c.height).data;
      return { img, w: c.width };
    };
    const live = r.popups.filter((p) => p.t < 1);
    if (live.length === 0) return { noPopup: true };
    const vis = live.map((p) => p.mesh.visible);
    live.forEach((p) => { p.mesh.visible = false; });
    const a = grab();
    live.forEach((p, i) => { p.mesh.visible = vis[i]; });
    const b2 = grab();
    const lum = (d, w, x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= d.length / 4 / w) return null;
      const i = (y * w + x) * 4;
      return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    };
    const region = (cx2, cy2) => {
      let maxD = 0, sum = 0, n = 0;
      // Integer pixel indices: projectToPixel returns floats and
      // Float32Array-style indexing with a fractional offset reads undefined.
      for (let y = Math.round(cy2 - b.hh); y <= Math.round(cy2 + b.hh); y += 2) {
        for (let x = Math.round(cx2 - b.hw); x <= Math.round(cx2 + b.hw); x += 2) {
          const da = lum(a.img, a.w, x, y);
          const db = lum(b2.img, a.w, x, y);
          if (da === null || db === null) continue;
          const d = Math.abs(db - da);
          if (d > maxD) maxD = d;
          sum += d;
          n++;
        }
      }
      return { maxD, mean: n ? sum / n : 0, n };
    };
    return { noPopup: false, text: region(b.cx, b.cy), ctrl: region(b.cx, b.cy - b.ctrlDy) };
  }, { cx, cy, hw, hh, ctrlDy });
}

// ---- 1. TETRIS: 4-line clear -> TETRIS! banner + dolly punch + pixels ----
// Rows 18..21 filled except col 5; a VERTICAL I (rotation 1 occupies its
// x+2 column) at x=3 lands at y=18 with cells in rows 18..21 col 5 and
// completes all four rows. (An O can only fill two of the rows, which is
// why the gap here is one column, not two.) The filler at row 10 keeps
// the well from emptying: a TETRIS that also perfects the board would
// stack a PERFECT CLEAR! banner on top and own part of the lens event,
// which this suite tests in isolation (see perfect-clear.mjs).
const tag1 = await setup({ type: 'I', rotation: 1, x: 3, y: 2, level: 1, cells: [...gapRows([18, 19, 20, 21], [5]), [10, 0, 'Z']] });
await page.keyboard.press(' ');
const locked1 = await waitUntil((tg) => window.__tetris.game.current.__tag !== tg, tag1, 10000);
check('TETRIS lock happened', locked1 !== null, `${locked1}ms`);
const pre1 = await page.evaluate(() => ({
  clears: window.__tetris.game.clearRows.length,
  punch: window.__tetris.renderer.camPunch,
}));
check('four lines cleared (test precondition)', pre1.clears === 4, `clearRows ${pre1.clears}`);
check('TETRIS fires the camera dolly punch', pre1.punch > 0.3, `camPunch ${pre1.punch.toFixed(3)}`);

const caught1 = await waitBanner('TETRIS!');
check('TETRIS! banner is on screen mid-life', caught1 !== null, `${caught1}ms`);
if (caught1 !== null) {
  const p1 = await activePopups();
  const tet = p1.find((p) => p.text === 'TETRIS!');
  check('TETRIS! banner has the tetris tier', !!tet && tet.tier === 'tetris', `${p1.map((p) => p.text).join(',')}`);
  const c1 = await bannerCenter();
  const ab1 = await abDiff({ cx: c1.x, cy: c1.y, hw: 200, hh: 60, ctrlDy: 350 });
  check('TETRIS! banner pixels: banner region differs from its own hidden-scene A/B',
    !ab1.noPopup && ab1.text.maxD > 40,
    ab1.noPopup ? 'no live popup at capture' : `maxD ${ab1.text.maxD.toFixed(0)}, mean ${ab1.text.mean.toFixed(1)}`);
  check('TETRIS! banner: far sky control stays flat', !ab1.noPopup && ab1.ctrl.maxD < 25,
    `ctrl maxD ${ab1.ctrl.maxD.toFixed(1)}`);
  check('TETRIS! banner is the only banner (no stale pool entries)', p1.length === 1, `${p1.length} active`);
}
const faded1 = await waitUntil(() => window.__tetris.renderer.popups.every((p) => p.t >= 1), null, 30000);
check('TETRIS! banner fades out', faded1 !== null, `${faded1}ms`);
check('faded TETRIS! banner is hidden with zero opacity', await allPopupsFaded());
const comboAfter1 = await page.evaluate(() => window.__tetris.combo);
check('combo climbed to 1 after the TETRIS clear', comboAfter1 === 1, `combo ${comboAfter1}`);

// ---- 2. DOUBLE: 2-line clear -> DOUBLE banner ----
const tag2 = await setup({ type: 'O', rotation: 0, x: 3, y: 2, level: 1, cells: [...gapRows([20, 21]), [10, 0, 'Z']] });
await page.keyboard.press(' ');
await waitUntil((tg) => window.__tetris.game.current.__tag !== tg, tag2, 10000);
const caught2 = await waitBanner('DOUBLE', 0.1, 0.85);
check('DOUBLE banner appears on a 2-line clear', caught2 !== null, `${caught2}ms`);
if (caught2 !== null) {
  const p2 = await activePopups();
  const dbl = p2.find((p) => p.text === 'DOUBLE');
  check('DOUBLE has the double tier', !!dbl && dbl.tier === 'double', `${p2.map((p) => p.text).join(',')}`);
}
check('case-2 banner faded', (await waitUntil(() => window.__tetris.renderer.popups.every((p) => p.t >= 1), null, 30000)) !== null);

// ---- 3. LEVEL-UP: 9 lines + this clear crosses into level 2 ----
// Priority check: the combo is at 3 by now (>= banner threshold) and a
// 1-line clear is below triple, so ONLY the level-up branch can explain a
// banner here — and it must be the LEVEL one, not the COMBO one.
const tag3 = await setup({ type: 'O', rotation: 0, x: 3, y: 2, level: 1, lines: 9, cells: [...gapRows([21]), [10, 0, 'Z']] });
await page.keyboard.press(' ');
await waitUntil((tg) => window.__tetris.game.current.__tag !== tg, tag3, 10000);
const lvl3 = await page.evaluate(() => ({ lines: window.__tetris.game.lines, level: window.__tetris.game.level }));
check('line total crossed the level threshold', lvl3.lines === 10 && lvl3.level === 2, `lines ${lvl3.lines}, level ${lvl3.level}`);
const caught3 = await waitBanner('LEVEL 2', 0.1, 0.9);
check('LEVEL 2 banner appears on the crossing lock', caught3 !== null, `${caught3}ms`);
if (caught3 !== null) {
  const p3 = await activePopups();
  const lv = p3.find((p) => p.text === 'LEVEL 2');
  check('LEVEL 2 outranks the concurrent COMBO banner (priority)', !!lv && lv.tier === 'level' && !p3.some((p) => p.tier === 'combo'),
    `${p3.map((p) => p.text).join(',')}`);
}
check('case-3 banner faded', (await waitUntil(() => window.__tetris.renderer.popups.every((p) => p.t >= 1), null, 30000)) !== null);

// ---- 4. COMBO: 4th consecutive clear (no level change) -> COMBO banner ----
const tag4 = await setup({ type: 'O', rotation: 0, x: 3, y: 2, level: 2, cells: [...gapRows([21]), [10, 0, 'Z']] });
await page.keyboard.press(' ');
await waitUntil((tg) => window.__tetris.game.current.__tag !== tg, tag4, 10000);
const st4 = await page.evaluate(() => ({
  level: window.__tetris.game.level,
  combo: window.__tetris.combo,
}));
check('level held at 2 (no level-up branch), combo at 4', st4.level === 2 && st4.combo === 4, `level ${st4.level}, combo ${st4.combo}`);
const caught4 = await waitBanner(`COMBO \u00d74`, 0.1, 0.9);
check('COMBO banner appears on a long streak of plain clears', caught4 !== null, `${caught4}ms`);
if (caught4 !== null) {
  const p4 = await activePopups();
  const cb = p4.find((p) => p.text === `COMBO \u00d74`);
  check('COMBO banner has the combo tier', !!cb && cb.tier === 'combo', `${p4.map((p) => p.text).join(',')}`);
}
check('case-4 banner faded', (await waitUntil(() => window.__tetris.renderer.popups.every((p) => p.t >= 1), null, 30000)) !== null);

// ---- 5. Single clear after a restart: no banner ----
await page.keyboard.press('r');
await page.waitForTimeout(300);
const comboReset = await page.evaluate(() => window.__tetris.combo);
check('restart resets the combo counter', comboReset === 0, `combo ${comboReset}`);
const tag5 = await setup({ type: 'O', rotation: 0, x: 3, y: 2, level: 1, cells: [...gapRows([21]), [10, 0, 'Z']] });
await page.keyboard.press(' ');
await waitUntil((tg) => window.__tetris.game.current.__tag !== tg, tag5, 10000);
const st5 = await page.evaluate(() => ({
  clears: window.__tetris.game.clearRows.length,
  combo: window.__tetris.combo,
}));
check('single clear happened (test precondition)', st5.clears === 1 && st5.combo === 1, `clearRows ${st5.clears}, combo ${st5.combo}`);
await sleep(300); // give a (wrong) banner time to spawn
const p5 = await activePopups();
check('a lone single clear spawns no banner', p5.length === 0, `${p5.length} active`);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);