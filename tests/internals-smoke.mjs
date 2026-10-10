// Optional: npm i -D playwright && npx playwright install chromium
// Run:  python -m http.server 8000 -d simulator   then   node tests/internals-smoke.mjs http://localhost:8000/internals.html ./shots
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const url = process.argv[2] || 'http://localhost:8000/internals.html', out = process.argv[3] || './shots', only = process.argv[4];
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text()); });
page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
const n = await page.evaluate(() => window.__internals.CH.length);
const list = only ? only.split(',').map(Number) : [...Array(n).keys()];
for (const i of list) {
  await page.evaluate(i => window.__internals.go(i), i);
  await page.waitForTimeout(1800);
  if (i === 1) { await page.click('#as-auto'); await page.waitForTimeout(9000); }
  if (i === 8) { await page.click('#pulse'); await page.waitForTimeout(2600); }
  if (i === 11) { await page.click('#ks-play'); await page.waitForTimeout(3500); }
  if (i === 12) { await page.click('#q-go'); await page.waitForTimeout(3500); }
  await page.screenshot({ timeout: 120000, path: `${out}/in-${String(i + 1).padStart(2, '0')}.png` });
}
const m = await browser.newPage({ viewport: { width: 400, height: 860 } });
m.on('pageerror', e => logs.push('MOBILE PAGEERROR: ' + e.message));
await m.goto(url + '#ch3', { waitUntil: 'networkidle' });
await m.waitForTimeout(3000);
await m.screenshot({ timeout: 120000, path: `${out}/in-mobile.png` });
console.log('mobile overflow', await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth));
console.log(logs.join('\n') || 'no console errors');
await browser.close();
