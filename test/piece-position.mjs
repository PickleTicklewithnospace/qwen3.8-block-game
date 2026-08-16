// Browser regression: the 3D piece and ghost must render at their TRUE board
// positions.
//
// Guards the anchor sign bug (src/coords.js): the piece group anchor's y term
// must SUBTRACT the half-box (world +y is up, board +y is down). If it adds,
// every piece floats (n-1) cells above the stack, jumps down on lock, and the
// ghost misses its landing position.
//
// The expected anchor is computed INDEPENDENTLY here (bounding-box center via
// toWorldX/toWorldY), NOT via the renderer's own pieceAnchor — otherwise a
// wrong anchor would match itself and the test would pass. coords.test.js
// pins pieceAnchor to the true cells; this test proves the live renderer uses
// that correct value.
//
// Usage: node test/piece-position.mjs [url]

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

const SIZE = { O: 2, I: 4, J: 3, L: 3, S: 3, T: 3, Z: 3 };

// Independent expected anchor: the bounding-box center of a piece at board
// (x, y). The box spans board rows y..y+n-1 and cols x..x+n-1; its center is
// at board (x+(n-1)/2, y+(n-1)/2), mapped to world by toWorldX/toWorldY.
function expectedAnchor(type, x, y) {
  const n = SIZE[type];
  const COLS = 10, TOTAL = 22;
  const toWorldX = (bx) => bx - (COLS - 1) / 2;
  const toWorldY = (by) => TOTAL - 1 - by + 0.5;
  return { x: toWorldX(x + (n - 1) / 2), y: toWorldY(y + (n - 1) / 2) };
}

// Place a piece in the air on an empty board (so the ghost is visible), let a
// frame run so the renderer picks it up, then compare the rendered positions
// to the independently computed true anchors.
async function verifyPiece(type, x, y, rotation = 0) {
  await page.evaluate(([t, px, py, rot]) => {
    const g = window.__tetris.game;
    g.paused = true;
    g.gameOver = false;
    for (let yy = 0; yy < g.board.length; yy++) g.board[yy].fill(null);
    g.current = { type: t, rotation: rot, x: px, y: py };
    g.lock = { resets: 0, lastReset: false };
  }, [type, x, y, rotation]);
  await sleep(120); // let a frame run the renderer's setPiece/setGhost
  const r = await page.evaluate(() => {
    const g = window.__tetris.game;
    const ren = window.__tetris.renderer;
    const p = g.current;
    const gy = window.__tetris.ghostY(g);
    return {
      piece: { x: ren.piecePosTarget.x, y: ren.piecePosTarget.y },
      ghostVisible: gy > p.y,
      ghost: { x: ren.ghostGroup.position.x, y: ren.ghostGroup.position.y },
      ghostY: gy,
      px: p.x, py: p.y, type: p.type,
    };
  });
  const eps = 1e-6;
  const close = (a, b) => Math.abs(a - b) < eps;
  const pe = expectedAnchor(r.type, r.px, r.py);
  check(
    `${type}@(${x},${y}) piece renders at its true anchor`,
    close(r.piece.x, pe.x) && close(r.piece.y, pe.y),
    `got (${r.piece.x.toFixed(3)},${r.piece.y.toFixed(3)}) want (${pe.x.toFixed(3)},${pe.y.toFixed(3)})`,
  );
  if (r.ghostVisible) {
    const ge = expectedAnchor(r.type, r.px, r.ghostY);
    check(
      `${type}@(${x},${y}) ghost renders at its true landing anchor`,
      close(r.ghost.x, ge.x) && close(r.ghost.y, ge.y),
      `got (${r.ghost.x.toFixed(3)},${r.ghost.y.toFixed(3)}) want (${ge.x.toFixed(3)},${ge.y.toFixed(3)})`,
    );
  }
}

// Every piece, a few placements, several rotations (rotation is a group spin
// around the anchor, so the anchor must be right for all of them).
for (const type of ['I', 'O', 'T', 'J', 'L', 'S', 'Z']) {
  await verifyPiece(type, 4, 6);
  await verifyPiece(type, 0, 12, 1);
  await verifyPiece(type, 6, 3, 2);
}

// The piece must sit ON the stack, not float above it: with a floor cell
// under it, the rendered bottom edge of the piece aligns with the top edge of
// the stack cell (no gap, no overlap).
await page.evaluate(() => {
  const g = window.__tetris.game;
  g.paused = true;
  g.gameOver = false;
  for (let yy = 0; yy < g.board.length; yy++) g.board[yy].fill(null);
  const FLOOR = g.board.length - 1;
  g.board[FLOOR][4] = 'I'; // a stack cell under the O piece
  g.current = { type: 'O', rotation: 0, x: 4, y: FLOOR - 2 }; // resting on it
  g.lock = { resets: 0, lastReset: false };
});
await sleep(120);
// Compare the RENDERER's piece position to the RENDERER's stack mesh position
// (both read from the live scene, not from formulas) so a wrong anchor or a
// wrong stack position would show a gap/overlap. The O piece's bottom block is
// half a cell below its anchor; the stack cell's top edge is half a cell above
// its center. Flush means those two edges coincide.
const onStack = await page.evaluate(() => {
  const g = window.__tetris.game;
  const ren = window.__tetris.renderer;
  const FLOOR = g.board.length - 1;
  const stackMesh = ren.stackMeshes.get(`4,${FLOOR}`);
  const pieceBottomEdge = ren.piecePosTarget.y - 0.5 - 0.5; // anchor - half - block half
  const stackTopEdge = stackMesh ? stackMesh.position.y + 0.5 : null;
  return { pieceBottomEdge, stackTopEdge };
});
check(
  'piece rests flush on the stack (no floating gap, no overlap)',
  onStack.stackTopEdge !== null &&
    Math.abs(onStack.pieceBottomEdge - onStack.stackTopEdge) < 1e-6,
  `piece bottom ${onStack.pieceBottomEdge} vs stack top ${onStack.stackTopEdge}`,
);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
