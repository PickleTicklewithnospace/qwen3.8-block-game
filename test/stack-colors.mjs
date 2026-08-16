// Regression: after a line clear, every stack mesh must show the material of
// the piece type now at its cell.
//
// Historically setStack() only created missing meshes and removed stale ones;
// when a clear shifted a row down onto a cell of a DIFFERENT type, the mesh
// kept its old material — a visible wrong-color block after every clear.
// The renderer now diffs via src/stack-diff.js (adds/removes/typeChanges).
//
// Also verifies the mesh set exactly matches the visible board (no missing
// or phantom blocks) and that the game keeps running after the clear.
//
// Usage: node test/stack-colors.mjs [url]

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
function check(name, cond) { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}`); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function key(type, k) {
  return page.evaluate(([t, k]) => {
    window.dispatchEvent(new KeyboardEvent(t, { key: k }));
  }, [type, k]);
}
async function waitUntil(pred, arg, timeoutMs = 8000, pollMs = 100) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(pred, arg)) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(pollMs);
  }
}

// Snapshot of the renderer/board reconciliation state.
async function reconcile() {
  return page.evaluate(() => {
    const { game, renderer } = window.__tetris;
    let wrongMaterial = 0;
    let phantom = 0;
    const details = [];
    for (const [key, mesh] of renderer.stackMeshes) {
      const [x, y] = key.split(',').map(Number);
      const t = game.board[y] && game.board[y][x];
      if (!t) {
        phantom++;
        details.push(`phantom ${key}`);
        continue;
      }
      if (mesh.material !== renderer.stackMats[t]) {
        wrongMaterial++;
        if (details.length < 5) details.push(`${key}: board=${t} mat!=stackMats[${t}]`);
      }
    }
    let missing = 0;
    for (let y = 2; y < game.board.length; y++) {
      for (let x = 0; x < 10; x++) {
        if (game.board[y][x] && !renderer.stackMeshes.has(`${x},${y}`)) {
          missing++;
          if (details.length < 8) details.push(`missing ${x},${y}`);
        }
      }
    }
    return { wrongMaterial, phantom, missing, total: renderer.stackMeshes.size, details };
  });
}

// ---- Scenario: O completes the bottom row; a marker L above it shifts down
// onto a Z cell. Before the fix, the (5,21) mesh kept the Z material. ----
await page.evaluate(() => {
  const g = window.__tetris.game;
  const y = g.board.length - 1;
  for (let x = 0; x < 10; x++) g.board[y][x] = x < 2 ? null : 'Z';
  g.board[y - 1][5] = 'L';
  g.current = { type: 'O', rotation: 0, x: 0, y: 10 };
});
await sleep(100);

await key('keydown', ' ');
await key('keyup', ' ');
const cleared = await waitUntil(() => window.__tetris.game.lines === 1);
check('line cleared', cleared);

// Let the clear freeze (220ms) expire and a few frames reconcile the stack.
await sleep(400);
const r1 = await reconcile();
check('no wrong-material blocks after clear shift', r1.wrongMaterial === 0);
check('no phantom blocks', r1.phantom === 0);
check('no missing blocks', r1.missing === 0);
if (r1.details.length) console.log('details:', r1.details.join(' | '));

// The shifted marker must specifically be an L-material mesh at (5, bottom).
const markerOk = await page.evaluate(() => {
  const { game, renderer } = window.__tetris;
  const y = game.board.length - 1;
  const mesh = renderer.stackMeshes.get(`5,${y}`);
  return !!mesh && game.board[y][5] === 'L' && mesh.material === renderer.stackMats['L'];
});
check('shifted marker renders with L material', markerOk);

// ---- Scenario 2: double clear; everything above shifts down two rows. ----
await page.evaluate(() => {
  const g = window.__tetris.game;
  const yA = g.board.length - 1;
  const yB = g.board.length - 2;
  for (const y of [yA, yB]) {
    for (let x = 0; x < 10; x++) g.board[y][x] = x < 2 ? null : 'T';
  }
  // Markers above the clear zone, in cols the O (cols 0-1) does not fall
  // through — a marker in col 0 would block the drop.
  g.board[yB - 1][5] = 'S';
  g.board[yB - 1][9] = 'J';
  g.current = { type: 'O', rotation: 0, x: 0, y: 10 };
});
await sleep(100);
await key('keydown', ' ');
await key('keyup', ' ');
const cleared2 = await waitUntil((n) => window.__tetris.game.lines >= n, 3);
check('double line cleared', cleared2);
await sleep(400);
const r2 = await reconcile();
check('no wrong-material blocks after double clear', r2.wrongMaterial === 0);
check('no phantom/missing blocks after double clear', r2.phantom === 0 && r2.missing === 0);
if (r2.details.length) console.log('details:', r2.details.join(' | '));

// ---- Game must still be fully playable after all this. ----
const g0 = await page.evaluate(() => window.__tetris.game.current.y);
const fell = await waitUntil((y0) => window.__tetris.game.current.y > y0, g0);
check('gravity still runs after clears', fell);

console.log(results.join('\n'));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed === 0 && errors.length === 0 ? 'ALL PASS' : 'FAILURES PRESENT');
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
