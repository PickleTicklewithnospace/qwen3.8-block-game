// Reliable frame capture + stats for the 3D board.
//
// Playwright's compositor screenshots of the WebGL canvas disagree with the
// actually-presented frame under headless SwiftShader, so this reads the real
// presented frame: it forces a synchronous composer.render() in-page, copies
// the canvas to a 2D canvas, and reads pixels (or exports a PNG).
//
// Usage:
//   node test/frame-stats.mjs [url] [drops] [out.png]
//
//   url     page to load (default http://localhost:8901/index.html)
//   drops   number of hard drops to build a stack (default 0)
//   out.png if given, save the captured frame to this path
//
// Prints JSON: avg [r,g,b], and % of pixels that are bright (sum>400),
// white (all>200), cyan, magenta.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'http://localhost:8901/index.html';
const drops = Number(process.argv[3] || 0);
const out = process.argv[4];

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// Shader compile failures surface as console errors, not pageerrors.
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200));
});
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(1500);
for (let i = 0; i < drops; i++) {
  await page.keyboard.press(' ');
  await page.waitForTimeout(120);
  if (i % 2 === 0) await page.keyboard.press(i % 4 === 0 ? 'ArrowLeft' : 'ArrowRight');
}
await page.waitForTimeout(400);

const res = await page.evaluate(() => {
  const c = document.getElementById('board');
  const r = window.__tetris.renderer;
  r.composer.render(); // force a fresh frame so the backbuffer is valid
  const off = document.createElement('canvas');
  off.width = c.width; off.height = c.height;
  const ctx = off.getContext('2d');
  ctx.drawImage(c, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let bright = 0, white = 0, cyan = 0, magenta = 0;
  let sr = 0, sg = 0, sb = 0;
  const total = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const rr = d[i], g = d[i + 1], b = d[i + 2];
    sr += rr; sg += g; sb += b;
    if (rr + g + b > 400) bright++;
    if (rr > 200 && g > 200 && b > 200) white++;
    if (b > 140 && g > 140 && rr < 110) cyan++;
    if (rr > 140 && b > 140 && g < 110) magenta++;
  }
  const pct = (n) => (100 * n / total).toFixed(2) + '%';
  return {
    size: [c.width, c.height],
    avg: [Math.round(sr / total), Math.round(sg / total), Math.round(sb / total)],
    bright: pct(bright),
    white: pct(white),
    cyan: pct(cyan),
    magenta: pct(magenta),
    png: off.toDataURL('image/png'),
  };
});

if (out) writeFileSync(out, Buffer.from(res.png.split(',')[1], 'base64'));
const { png, ...stats } = res;
console.log(JSON.stringify({ ...stats, saved: out || null }, null, 1));
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
await browser.close();
