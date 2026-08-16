// End-to-end line-clear FX capture.
//
// Rigs the live game so a hard drop clears 4 lines (TETRIS): the bottom 4
// rows are filled except column 2, and the current piece is set to a
// vertical I aligned on column 2. Then it hard-drops via the real input
// path (Space) and captures the presented frame at two FX phases.
//
// NOTE: board is 22 rows (2 hidden + 20 visible); bottom 4 rows are y=18..21.
//
// Headless SwiftShader renders slowly, so renderer FX time advances much
// slower than wall time. Instead of fixed wall-time waits, this polls the
// renderer's ring animation phase and captures mid-expansion and late:
//   phase A: ring t in [0.10, 0.32] - flash pop + rings + shards mid-flight
//   phase B: ring t in [0.60, 0.85] - late (rings wide, shards high, flash gone)
//
// Usage:
//   node test/lineclear-capture.mjs [url] [outA.png] [outB.png]

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'http://localhost:8901/index.html';
const outA = process.argv[3];
const outB = process.argv[4];

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// Shader/material errors surface as console errors, not pageerrors.
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200));
});
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(1200);

// Rig: bottom 4 rows full except column 2; vertical I (rot 1, col offset 2)
// at x=0 lands exactly in the gap -> 4-line clear.
await page.evaluate(() => {
  const g = window.__tetris.game;
  for (let y = 18; y < 22; y++) {
    for (let x = 0; x < 10; x++) g.board[y][x] = x === 2 ? null : 'I';
  }
  g.current = { type: 'I', rotation: 1, x: 0, y: 0 };
});
await page.waitForTimeout(120);
await page.keyboard.press(' '); // hard drop -> TETRIS

// Wait until a shockwave ring is in the given phase window, then capture.
const captureAtPhase = async (tMin, tMax, label) => {
  await page.waitForFunction(
    ([a, b]) => {
      const r = window.__tetris.renderer;
      return r.rings.some((x) => x.mesh.visible && x.t >= a && x.t <= b);
    },
    [tMin, tMax],
    { timeout: 15000, polling: 50 },
  );
  const res = await page.evaluate(() => {
    const c = document.getElementById('board');
    const r = window.__tetris.renderer;
    r.composer.render(); // force a fresh frame so the backbuffer is valid
    const off = document.createElement('canvas');
    off.width = c.width;
    off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let bright = 0, white = 0, cyan = 0;
    let sr = 0, sg = 0, sb = 0;
    const total = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const rr = d[i], g = d[i + 1], b = d[i + 2];
      sr += rr; sg += g; sb += b;
      if (rr + g + b > 400) bright++;
      if (rr > 200 && g > 200 && b > 200) white++;
      if (b > 140 && g > 140 && rr < 110) cyan++;
    }
    return {
      ringT: +r.rings.find((x) => x.mesh.visible).t.toFixed(2),
      flash: +r.flash.toFixed(2),
      avg: [Math.round(sr / total), Math.round(sg / total), Math.round(sb / total)],
      bright: (100 * bright / total).toFixed(2) + '%',
      white: (100 * white / total).toFixed(2) + '%',
      cyan: (100 * cyan / total).toFixed(2) + '%',
      png: off.toDataURL('image/png'),
    };
  });
  const out = label === 'A' ? outA : outB;
  if (out) writeFileSync(out, Buffer.from(res.png.split(',')[1], 'base64'));
  const { png, ...stats } = res;
  console.log(label, JSON.stringify(stats));
};

await captureAtPhase(0.1, 0.32, 'A');
await captureAtPhase(0.6, 0.85, 'B');
console.log('ERRORS', errors.length ? errors.join(' | ') : 'none');
await browser.close();
