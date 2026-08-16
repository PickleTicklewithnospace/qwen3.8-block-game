// Browser regression: pieces and the ghost must be HIDDEN while any of their
// cells are in the hidden spawn rows (board rows 0..1).
//
// The board frame only covers the visible field (rows 2..21); with the
// corrected anchor (src/coords.js), a cell in a hidden row renders floating
// above the frame / clipped at the top of the screen. The renderer therefore
// hides the piece and ghost groups until every cell is inside the visible
// field. This test pins:
//   - live spawn: piece hidden in the spawn zone, visible once fully inside
//   - exact boundary row for every piece/rotation (one row too early = the
//     old floating-over-frame glitch; one row too late = piece vanishes at
//     the top of the board)
//   - ghost hidden when its LANDING has cells in hidden rows (even though
//     ghostY > piece.y), visible when the landing is fully inside
//   - no position jump when the piece crosses the hidden->visible boundary
//
// Expected visibility is computed INDEPENDENTLY here (topmost occupied cell
// row per piece/rotation), not via the renderer's anyHiddenCell — otherwise
// a wrong boundary would match itself.
//
// Usage: node test/hidden-rows.mjs [url]

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8901/index.html';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url, { waitUntil: 'load' });

const results = [];
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function key(type, k) {
  return page.evaluate(([t, k]) => {
    window.dispatchEvent(new KeyboardEvent(t, { key: k }));
  }, [type, k]);
}

// Topmost occupied cell row (min r) per piece/rotation, from the SRS shapes.
// A piece at board row y has its topmost cell at y + TOP_ROW[type][rot]; it
// is fully inside the visible field (rows 2..21) exactly when that is >= 2.
const TOP_ROW = {
  I: [1, 0, 2, 0],
  O: [0, 0, 0, 0],
  J: [0, 0, 1, 0],
  L: [0, 0, 1, 0],
  S: [0, 0, 1, 0],
  T: [0, 0, 1, 0],
  Z: [0, 0, 1, 0],
};
const SIZE = { O: 2, I: 4, J: 3, L: 3, S: 3, T: 3, Z: 3 };
const isHidden = (s) => s.y + TOP_ROW[s.type][s.rotation] < 2;

// Independent expected anchor: bounding-box center via toWorldX/toWorldY.
function expectedAnchor(type, x, y) {
  const n = SIZE[type];
  const toWorldX = (bx) => bx - (10 - 1) / 2;
  const toWorldY = (by) => 22 - 1 - by + 0.5;
  return { x: toWorldX(x + (n - 1) / 2), y: toWorldY(y + (n - 1) / 2) };
}

async function snap() {
  return page.evaluate(() => {
    const g = window.__tetris.game;
    const ren = window.__tetris.renderer;
    const p = g.current;
    return {
      type: p.type, rotation: p.rotation, x: p.x, y: p.y,
      pieceVisible: ren.pieceGroup.visible,
      ghostVisible: ren.ghostGroup.visible,
      ghostY: window.__tetris.ghostY(g),
      piecePos: { x: ren.piecePos.x, y: ren.piecePos.y },
      pieceTarget: { x: ren.piecePosTarget.x, y: ren.piecePosTarget.y },
      gameOver: g.gameOver, paused: g.paused,
    };
  });
}

// Poll a page-side predicate until true or deadline.
async function waitUntil(pred, arg, timeoutMs = 8000, pollMs = 100) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred, arg)) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(pollMs);
  }
}

// Paused manual placement: clear the board (or fill from `fillFrom` down),
// install a fresh piece at (x, y), let a frame run.
async function place(type, rotation, x, y, fillFrom = null) {
  await page.evaluate(([t, r, px, py, ff]) => {
    const g = window.__tetris.game;
    g.paused = true;
    g.gameOver = false;
    for (let yy = 0; yy < g.board.length; yy++) g.board[yy].fill(null);
    if (ff !== null) for (let yy = ff; yy < g.board.length; yy++) g.board[yy].fill('I');
    g.current = { type: t, rotation: r, x: px, y: py };
    g.lock = { resets: 0, lastReset: false };
  }, [type, rotation, x, y, fillFrom]);
  await sleep(150);
}

// ---- Phase 1: live spawn — hidden in the spawn zone, visible once inside ----
// The first piece may be an I (visible after just 1 row), so if we miss its
// hidden window, hard-drop to force a fresh spawn and try again.
let hiddenSample = null;
let visibleSample = null;
let drops = 0;
const t0 = Date.now();
while (Date.now() - t0 < 20000) {
  const s = await snap();
  if (s.gameOver) break;
  if (!hiddenSample) {
    if (isHidden(s)) {
      hiddenSample = s;
    } else if (drops < 3) {
      // Already past the hidden window: force a new spawn.
      await key('keydown', ' ');
      await key('keyup', ' ');
      drops++;
      await sleep(150);
    }
  } else if (!isHidden(s)) {
    visibleSample = s;
    break;
  }
  await sleep(80);
}
check(
  'spawn: piece hidden while any cell is in a hidden row',
  hiddenSample !== null && hiddenSample.pieceVisible === false,
  hiddenSample ? `${hiddenSample.type}@y=${hiddenSample.y} visible=${hiddenSample.pieceVisible}` : 'no hidden sample',
);
check(
  'spawn: ghost still visible while piece is hidden (empty board)',
  hiddenSample !== null && hiddenSample.ghostVisible === true,
  hiddenSample ? `ghost=${hiddenSample.ghostVisible}` : '',
);
check(
  'piece visible once fully inside the visible field',
  visibleSample !== null && visibleSample.pieceVisible === true,
  visibleSample ? `${visibleSample.type}@y=${visibleSample.y} visible=${visibleSample.pieceVisible}` : 'no visible sample',
);

// ---- Phase 2: exact boundary row for every piece/rotation (paused) ----
for (const type of ['I', 'O', 'J', 'L', 'S', 'T', 'Z']) {
  const rots = type === 'I' ? [0, 1, 2, 3] : [0, 1];
  for (const rotation of rots) {
    const top = TOP_ROW[type][rotation];
    const yVisible = 2 - top; // first fully-visible row
    for (const [y, want] of [[yVisible - 1, false], [yVisible, true]]) {
      await place(type, rotation, 4, y);
      const s = await snap();
      check(
        `${type} rot${rotation} @y=${y} piece ${want ? 'visible' : 'hidden'}`,
        s.pieceVisible === want,
        `visible=${s.pieceVisible}`,
      );
    }
  }
}

// ---- Phase 3: ghost hidden-row logic (paused) ----
// G1: empty board, piece mid-air -> ghost at the floor, fully visible.
await place('T', 0, 4, 5);
let s = await snap();
check('ghost visible when landing is fully inside (empty board)', s.ghostVisible === true, `ghostY=${s.ghostY}`);

// G2: stack filled from row 3 down, O at y=0. The O lands at y=1 (cells on
// rows 1,2) — ghostY > piece.y, but row 1 is hidden, so the ghost must be
// hidden (it would render above the frame). Precondition asserted explicitly
// so the check is not vacuous.
await place('O', 0, 4, 0, 3);
s = await snap();
check(
  'ghost hidden when its landing has cells in hidden rows',
  s.ghostY > s.y && s.ghostVisible === false,
  `ghostY=${s.ghostY} pieceY=${s.y} ghost=${s.ghostVisible}`,
);
check('piece hidden while in hidden rows (stacked board)', s.pieceVisible === false);

// G3: same stack, O at y=1: ghostY == piece.y (cannot fall) — ghost hidden
// by the no-landing rule, piece still hidden (row 1 occupied).
await place('O', 0, 4, 1, 3);
s = await snap();
check(
  'ghost hidden when it coincides with the hidden piece',
  s.ghostY === s.y && s.ghostVisible === false && s.pieceVisible === false,
  `ghostY=${s.ghostY} pieceY=${s.y}`,
);

// G4: stack filled from row 4 down, O at y=0: landing y=2 (rows 2,3) is fully
// visible -> ghost visible even though the piece itself is hidden.
await place('O', 0, 4, 0, 4);
s = await snap();
check(
  'ghost visible when landing is fully inside, even with piece hidden',
  s.ghostY === 2 && s.ghostVisible === true && s.pieceVisible === false,
  `ghostY=${s.ghostY} ghost=${s.ghostVisible} piece=${s.pieceVisible}`,
);

// ---- Phase 4: no position jump across the hidden->visible boundary ----
// O at y=1 (hidden): the renderer must keep tracking the true anchor while
// hidden, then show the piece exactly on its cell at y=2 (no pop/jump).
await place('O', 0, 4, 1);
const a1 = expectedAnchor('O', 4, 1);
s = await snap();
check(
  'hidden piece tracks its true anchor (no stale position)',
  Math.abs(s.pieceTarget.y - a1.y) < 1e-6 && Math.abs(s.piecePos.y - a1.y) < 0.05,
  `pos=${s.piecePos.y.toFixed(3)} want=${a1.y}`,
);
// Move the SAME piece object down one row (the gravity path: no snap).
await page.evaluate(() => { window.__tetris.game.current.y = 2; });
const a2 = expectedAnchor('O', 4, 2);
const converged = await waitUntil(
  (a) => {
    const ren = window.__tetris.renderer;
    return (
      ren.pieceGroup.visible &&
      Math.abs(ren.piecePos.x - a[0]) < 0.02 &&
      Math.abs(ren.piecePos.y - a[1]) < 0.02
    );
  },
  [a2.x, a2.y],
  4000,
);
s = await snap();
check(
  'piece appears exactly on its cell when it crosses into the visible field',
  converged && s.pieceVisible === true &&
    Math.abs(s.piecePos.y - a2.y) < 0.02 && Math.abs(s.pieceTarget.y - a2.y) < 1e-6,
  `pos=(${s.piecePos.x.toFixed(3)},${s.piecePos.y.toFixed(3)}) want=(${a2.x},${a2.y})`,
);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
