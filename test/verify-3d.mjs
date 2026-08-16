// Headless verification: WebGL boots, scene renders non-trivial pixels,
// gameplay (hard drop, line clear, game over, restart) works without errors.
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8901/index.html';
const shot = process.argv[3] || '/tmp/tetris3d-verify.png';

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(1500);

const info = await page.evaluate(() => {
  const c = document.getElementById('board');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  // Read pixels from the WebGL canvas via a 2d copy.
  const off = document.createElement('canvas');
  off.width = c.width; off.height = c.height;
  const ctx = off.getContext('2d');
  ctx.drawImage(c, 0, 0);
  const d = ctx.getImageData(0, 0, off.width, off.height).data;
  let nonBlack = 0, cyan = 0, total = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r + g + b > 30) nonBlack++;
    if (b > 120 && g > 120 && r < 100) cyan++;
  }
  return {
    webgl: !!gl,
    size: [c.width, c.height],
    nonBlackPct: (100 * nonBlack / total).toFixed(1),
    cyanPct: (100 * cyan / total).toFixed(2),
    score: window.__tetris.game.score,
  };
});
console.log('SCENE', JSON.stringify(info));

// Hard drop a few pieces, verify score grows and no errors.
const key = (k) => page.keyboard.press(k);
await key(' ');
await page.waitForTimeout(120);
const s1 = await page.evaluate(() => window.__tetris.game.score);

// Play until game over (hard drops), then restart.
await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
    await sleep(30);
    if (!document.getElementById('overlay').classList.contains('hidden')) break;
  }
});
const over = await page.evaluate(() => document.getElementById('overlay-title').textContent);
await page.screenshot({ path: shot });
await page.keyboard.press('r');
await page.waitForTimeout(300);
const restarted = await page.evaluate(() => ({
  hidden: document.getElementById('overlay').classList.contains('hidden'),
  score: window.__tetris.game.score,
}));

console.log('HARD_DROP_SCORE', s1);
console.log('GAME_OVER', over);
console.log('RESTART', JSON.stringify(restarted));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
await browser.close();
