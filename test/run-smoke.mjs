import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let results = [];
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('SMOKE_RESULTS')) results = t.split('\n').slice(1);
});
await page.goto('http://localhost:8901/test/browser-smoke.html', { waitUntil: 'load' });
await page.waitForTimeout(15000);
console.log(results.join('\n') || 'NO RESULTS');
await browser.close();
