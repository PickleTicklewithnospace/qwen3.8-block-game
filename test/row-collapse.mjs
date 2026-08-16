// Regression: the row-collapse settle. On a line clear the rows above it
// shift down; the renderer must slide every shifted block from its SOURCE
// row (sourceRow in src/stack-diff.js inverts the engine's compaction) to
// its resting row with a soft bounce, instead of teleporting/re-tinting in
// place. main.js queues the clear FX (renderer.onLineClear) BEFORE the
// post-collapse setStack diff so the renderer knows which rows cleared.
//
// Proven three ways:
//   state  - collapseCount grows by exactly the shifted-cell count, slides
//            carry fromY/toY matching independent toWorldY math, and settle
//            ends with the meshes exactly on their resting rows;
//   time   - mid-slide the block is strictly between source and target
//            (a teleport would never be observed in transit);
//   pixels - same-frame SPATIAL pairs in the marker column: the block's
//            target cell is much brighter than the empty cell directly
//            below/above it (baseline: empty-vs-block pair in the source
//            row). Spatial pairs cancel the aurora showing through the
//            frosted back panel (absolute "dark cell" levels are
//            aurora-dependent and unusable), and are immune to
//            capture-interval camera drift. Piece/ghost are hidden during
//            the synchronous A/B capture.
//
// Headless SwiftShader frames are slow: everything polls renderer state
// (slides t, collapseCount) instead of wall-time sleeps.
//
// Usage: node test/row-collapse.mjs [url]

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
const toWorldY = (y) => 21.5 - y; // independent copy of src/coords.js (TOTAL_ROWS=22)

// Mean luminance at the projected centers of board cells (x, y). The piece,
// ghost and landing projector are hidden for the synchronous capture so
// only the settled stack (and the static stage) is in the frame. Returns
// -1 for points that project off-canvas.
async function pixelLum(cells) {
  return page.evaluate((cells) => {
    const r = window.__tetris.renderer;
    const saved = [];
    for (const o of [r.pieceGroup, r.ghostGroup, r.ghostBeam, r.ghostEmitter]) {
      saved.push([o, o.visible]);
      o.visible = false;
    }
    r.composer.render();
    const c = document.getElementById('board');
    const off = document.createElement('canvas');
    off.width = c.width;
    off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const out = [];
    for (const [x, y] of cells) {
      const p = r.projectToPixel(x - 4.5, 21.5 - y, 0); // toWorldX/toWorldY inlined
      const px = Math.round(p.x);
      const py = Math.round(p.y);
      let sum = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const i = ((py + dy) * c.width + (px + dx)) * 4;
          if (i < 0 || i + 2 >= d.length) continue;
          sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          n++;
        }
      }
      out.push(n ? sum / n : -1);
    }
    for (const [o, v] of saved) o.visible = v;
    return out;
  }, cells);
}

// Poll a page-side predicate (real function + arg) until true or deadline.
async function waitUntil(pred, arg, timeoutMs = 15000, pollMs = 50) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred, arg)) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(pollMs);
  }
}

// Rig the board for a clear scenario and park a fresh O in the drop lane.
// `fullRows` get Z across cols 2-9 (cols 0-1 stay the O's lane); `markers`
// are single blocks [x, y, type] above the clear zone.
async function rig(fullRows, markers, oX) {
  await page.evaluate(([fullRows, markers, oX]) => {
    const g = window.__tetris.game;
    for (let y = 0; y < g.board.length; y++) for (let x = 0; x < 10; x++) g.board[y][x] = null;
    for (const y of fullRows) for (let x = 2; x < 10; x++) g.board[y][x] = 'Z';
    for (const [x, y, t] of markers) g.board[y][x] = t;
    g.current = { type: 'O', rotation: 0, x: oX, y: 10 };
    g.lock = { resets: 0, lastReset: false };
    g.clearRows = [];
    g.lastClear = 0;
    g.paused = false;
  }, [fullRows, markers, oX]);
  const n = fullRows.length * 8 + markers.length;
  await waitUntil((need) => window.__tetris.renderer.stackMeshes.size >= need, n, 15000);
}

async function tagged() {
  return page.evaluate(() => {
    const g = window.__tetris.game;
    const p = g.current;
    if (!p.__tag) p.__tag = Math.random();
    return {
      y: p.y,
      lines: g.lines,
      score: g.score,
      cells: g.board.flat().filter(Boolean).length,
      tag: p.__tag,
      collapse: window.__tetris.renderer.collapseCount,
    };
  });
}

const hardDrop = async () => {
  await key('keydown', ' ');
  await key('keyup', ' ');
};

// In-page rAF loop that samples the slide's state every frame and resolves
// on the FIRST frame whose t lands in (tMin, tMax) — the position is read
// in the same frame the predicate fires (a waitForFunction + second
// evaluate would resolve a frame late and read the already-settled
// position). Kick it off right after the drop keypress.
async function catchSlide(wantKey, tMin, tMax, timeoutMs = 15000) {
  return page.evaluate(
    ([k, a, b, ms]) =>
      new Promise((resolve) => {
        const r = window.__tetris.renderer;
        const t0 = performance.now();
        const step = () => {
          const s = r.slides.find((q) => q.key === k);
          if (s && s.t > a && s.t < b) {
            resolve({ y: s.mesh.position.y, fromY: s.fromY, toY: s.toY, t: s.t });
            return;
          }
          if (performance.now() - t0 > ms) {
            resolve(null);
            return;
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    [wantKey, tMin, tMax, timeoutMs],
  );
}

const settle = async () => {
  return waitUntil(
    () =>
      window.__tetris.renderer.slides.length === 0 &&
      window.__tetris.renderer.flashes.length === 0 &&
      window.__tetris.renderer.popups.every((p) => !p.mesh.visible),
    null,
    15000,
  );
};

// Same-frame spatial pair: the block cell must read much brighter than the
// empty neighbor cell in the same column (the aurora through the back panel
// cancels between the two adjacent rows).
function pairCheck(name, lum, iBlock, iEmpty, delta) {
  check(
    name,
    lum[iBlock] > 70 && lum[iBlock] - lum[iEmpty] > delta,
    `block=${lum[iBlock].toFixed(0)} empty=${lum[iEmpty].toFixed(0)}`,
  );
}

// ---- Phase 1: single clear, one-row shift ----
// Bottom row full except the lane (cols 0-1); O completes it. Markers:
// I at (3,20), T at (5,19), I at (7,20). After the clear, rows above
// shift down one: (3,20)->(3,21), (5,19)->(5,20), (7,20)->(7,21), and the
// O's surviving top cells (0,20),(1,20) -> (0,21),(1,21): 5 slides.
await rig([21], [[3, 20, 'I'], [5, 19, 'T'], [7, 20, 'I']], 0);
const B1 = [
  [3, 19], // empty, above the I at (3,20)
  [3, 20], // I marker
  [5, 19], // T marker
  [5, 20], // empty, below the T
  [7, 19], // empty, above the I at (7,20)
  [7, 20], // I marker
  [3, 21], // Z (bright, re-filled as I after the clear)
  [7, 21], // Z
];
const base1 = await pixelLum(B1);
check('phase1 baseline: all points on-canvas', base1.every((v) => v >= 0));
check('phase1 baseline pairs: markers brighter than their empty neighbors',
  base1[1] - base1[0] > 20 && base1[2] - base1[3] > 20 && base1[5] - base1[4] > 20,
  `3: ${base1[0].toFixed(0)}/${base1[1].toFixed(0)} 5: ${base1[3].toFixed(0)}/${base1[2].toFixed(0)} 7: ${base1[4].toFixed(0)}/${base1[5].toFixed(0)}`);

let s1 = await tagged();
const cc1 = s1.collapse;
await hardDrop();
const midWatch1 = catchSlide('5,20', 0.05, 0.90);
s1 = await tagged();
check('phase1: O drop cleared exactly 1 line', s1.lines === 1, `lines=${s1.lines}`);
check(
  'phase1: exactly 5 settle slides registered (3 markers + 2 O cells)',
  s1.collapse - cc1 === 5,
  `delta=${s1.collapse - cc1}`,
);
const mid1 = await midWatch1;
check(
  'phase1: T slide observed in transit between rows 19 and 20',
  !!mid1 && mid1.fromY === toWorldY(19) && mid1.toY === toWorldY(20) &&
    mid1.y < mid1.fromY - 0.03 * (mid1.fromY - mid1.toY) && mid1.y > mid1.toY - 0.08,
  mid1
    ? `y=${mid1.y.toFixed(2)} from=${mid1.fromY} to=${mid1.toY} t=${mid1.t.toFixed(2)}`
    : 'mid-slide window missed',
);
const settled1 = await settle();
check('phase1: collapse settles (slides, flashes, banners all done)', settled1);
const rest1 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const b = window.__tetris.game.board;
  return {
    m: r.stackMeshes.get('5,20')?.position.y ?? null,
    b19: !!b[19][5],
    b20: !!b[20][5],
    b21: !!b[21][5],
  };
});
check('phase1: T mesh rests exactly on its target row', rest1.m === toWorldY(20), `y=${rest1.m}`);
// Post board: row 21 = old row 20 (x=3,7 I + O x=0,1); row 20 = old row 19 (x=5 T).
check('phase1: engine board matches the shift', rest1.b20 && !rest1.b19 && !rest1.b21);

// Post capture: the block pairs have moved down one row in each column.
const P1 = [
  [3, 20], // now empty (I moved to 21)
  [3, 21], // I (was Z)
  [5, 19], // now empty (T moved to 20)
  [5, 20], // T
  [7, 20], // now empty (I moved to 21)
  [7, 21], // I (was Z)
];
const post1 = await pixelLum(P1);
pairCheck('phase1 pixels: column 3 block now at 21 (pair 21 vs 20)', post1, 1, 0, 20);
pairCheck('phase1 pixels: column 5 T now at 20 (pair 20 vs 19)', post1, 3, 2, 20);
pairCheck('phase1 pixels: column 7 block now at 21 (pair 21 vs 20)', post1, 5, 4, 20);

// Gameplay must continue after the collapse (new piece falls).
const g1 = await tagged();
const fell = await waitUntil((y0) => window.__tetris.game.current.y > y0, g1.y, 8000);
check('phase1: gravity still runs after the collapse', fell);

// ---- Phase 2: a no-clear lock settles nothing ----
// O into cols 7-8 (col 7 holds the settled I at row 21): lands on (7,19)..(8,20),
// completes no row.
await page.evaluate(() => {
  const g = window.__tetris.game;
  g.current = { type: 'O', rotation: 0, x: 7, y: 10 };
  g.lock = { resets: 0, lastReset: false };
});
await sleep(100);
const s2a = await tagged();
await hardDrop();
const s2b = await tagged();
check('phase2: no-clear lock', s2b.lines === s2a.lines, `lines ${s2a.lines} -> ${s2b.lines}`);
check('phase2: no settle slides on a no-clear lock', s2b.collapse === s2a.collapse,
  `${s2a.collapse} -> ${s2b.collapse}`);
const slidesIdle = await page.evaluate(() => window.__tetris.renderer.slides.length === 0);
check('phase2: slide pool idle', slidesIdle);

// ---- Phase 3: double clear, two-row shift ----
// Rows 20 and 21 full except the lane; O completes BOTH (the whole O is
// destroyed with the rows). Markers: I (4,19) -> (4,21), I (6,18) -> (6,20),
// T (8,19) -> (8,21): 3 slides, each two rows down.
await rig([20, 21], [[4, 19, 'I'], [6, 18, 'I'], [8, 19, 'T']], 0);
const B3 = [
  [4, 18], // empty, above the I at (4,19)
  [4, 19], // I marker
  [6, 17], // empty, above the I at (6,18)
  [6, 18], // I marker
  [8, 18], // empty, above the T at (8,19)
  [8, 19], // T marker
];
const base3 = await pixelLum(B3);
check('phase3 baseline pairs: markers brighter than their empty neighbors',
  base3[1] - base3[0] > 15 && base3[3] - base3[2] > 15 && base3[5] - base3[4] > 15,
  `4: ${base3[0].toFixed(0)}/${base3[1].toFixed(0)} 6: ${base3[2].toFixed(0)}/${base3[3].toFixed(0)} 8: ${base3[4].toFixed(0)}/${base3[5].toFixed(0)}`);

const s3a = await tagged();
await hardDrop();
const midWatch3 = catchSlide('4,21', 0.05, 0.90);
const s3b = await tagged();
check('phase3: O drop cleared exactly 2 lines', s3b.lines === s3a.lines + 2,
  `lines ${s3a.lines} -> ${s3b.lines}`);
check('phase3: exactly 3 settle slides (the O cells are destroyed with the rows)',
  s3b.collapse - s3a.collapse === 3,
  `delta=${s3b.collapse - s3a.collapse}`);
const mid3 = await midWatch3;
check(
  'phase3: I slide observed in transit two rows down',
  !!mid3 && mid3.fromY === toWorldY(19) && mid3.toY === toWorldY(21) &&
    mid3.y < mid3.fromY - 0.03 * (mid3.fromY - mid3.toY) && mid3.y > mid3.toY - 0.12,
  mid3
    ? `y=${mid3.y.toFixed(2)} from=${mid3.fromY} to=${mid3.toY} t=${mid3.t.toFixed(2)}`
    : 'mid-slide window missed',
);
const settled3 = await settle();
check('phase3: collapse settles (incl. the DOUBLE banner expiring)', settled3);
const rest3 = await page.evaluate(() => {
  const r = window.__tetris.renderer;
  const b = window.__tetris.game.board;
  return {
    m: r.stackMeshes.get('4,21')?.position.y ?? null,
    b421: !!b[21][4],
    b620: !!b[20][6],
    b821: !!b[21][8],
    b419: !!b[19][4],
  };
});
check('phase3: markers rest two rows down', rest3.m === toWorldY(21), `y=${rest3.m}`);
check('phase3: engine board matches the double shift',
  rest3.b421 && rest3.b620 && rest3.b821 && !rest3.b419);

// Post capture: pairs moved two rows down.
const P3 = [
  [4, 20], // now empty (I moved to 21)
  [4, 21], // I
  [6, 19], // now empty (I moved to 20)
  [6, 20], // I
  [8, 20], // now empty (T moved to 21)
  [8, 21], // T
];
const post3 = await pixelLum(P3);
pairCheck('phase3 pixels: column 4 I now at 21 (pair 21 vs 20)', post3, 1, 0, 20);
pairCheck('phase3 pixels: column 6 I now at 20 (pair 20 vs 19)', post3, 3, 2, 20);
pairCheck('phase3 pixels: column 8 T now at 21 (pair 21 vs 20)', post3, 5, 4, 15);

// ---- Phase 4: restart resets the collapse state ----
await key('keydown', 'r');
await key('keyup', 'r');
const clean = await waitUntil(
  () => {
    const r = window.__tetris.renderer;
    const g = window.__tetris.game;
    return (
      r.stackMeshes.size === 0 &&
      r.slides.length === 0 &&
      r.settleDip === 0 &&
      !r.pendingClearRows &&
      g.level === 1 &&
      !g.board.flat().some(Boolean)
    );
  },
  null,
  10000,
);
check('phase4: restart clears slides/dip and rebuilds the neutral stage', clean);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);