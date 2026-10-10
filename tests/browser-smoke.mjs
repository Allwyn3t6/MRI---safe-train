// Optional: npm i -D playwright && npx playwright install chromium
// Run:  python -m http.server 8000 -d simulator   then   node tests/browser-smoke.mjs http://localhost:8000/trainer.html ./shots
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const url = process.argv[2] || 'http://localhost:8000/trainer.html', out = process.argv[3] || './shots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text()); });
page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);
await page.screenshot({ timeout: 120000, path: out + '/01-home.png' });
// Wrong move: touch room access early, and equipment with o2 in zone IV
await page.keyboard.press('3');
await page.waitForTimeout(400);
await page.screenshot({ timeout: 120000, path: out + '/02-violation.png' });
// Select oxygen cylinder through the API path used by the inspector
const r = await page.evaluate(() => {
  const M = window.__mrisafe;
  const s = M.session();
  const d = e => M.dispatch({ src: 'scene', ...e });
  d({ event: 'INSPECT', target: 'record' }); d({ event: 'CONFIRM_ID' });
  M.padPress('T1', 'kbd');
  for (const id of Object.keys(s.current.items)) d({ event: 'CLASSIFY', target: id, value: window.MRIEngine.ITEMS[id].truth });
  d({ event: 'MOVE', target: 'o2', value: 'ZONE_II' });
  // serial path: simulate device lines
  M.handleLine('{"v":1,"type":"hello","fw":"1.0.0","boot":4242,"pads":6}');
  M.handleLine('{"v":1,"type":"action","id":"T2","event":"VERIFY_EQUIPMENT","seq":1,"t":100}');
  M.handleLine('{"v":1,"type":"action","id":"T2","event":"VERIFY_EQUIPMENT","seq":1,"t":100}'); // duplicate
  M.handleLine('garbage');
  return { score: s.current.score(), cps: Object.fromEntries(Object.entries(s.current.checkpoints).map(([k, v]) => [k, v.status])), log: s.current.log.length };
});
console.log(JSON.stringify(r));
await page.waitForTimeout(2500);
await page.screenshot({ timeout: 120000, path: out + '/03-moved.png' });
// click on the patient in the canvas center-ish: use select via API isn't exposed; click canvas at patient approx
await page.evaluate(() => { const M = window.__mrisafe; M.dispatch({ src: 'scene', event: 'INSPECT', target: 'patient' }); M.dispatch({ src: 'scene', event: 'REMOVE_PERSONAL_ITEM', target: 'hairclip' }); M.padPress('T3', 'kbd'); M.padPress('T4', 'kbd'); M.padPress('T5', 'kbd'); });
await page.waitForTimeout(5200);
await page.screenshot({ timeout: 120000, path: out + '/04-complete.png' });
await page.keyboard.press('Escape');
await page.keyboard.press('t');
await page.waitForTimeout(800);
await page.screenshot({ timeout: 120000, path: out + '/05-trainer.png', fullPage: false });
await page.keyboard.press('t');
// click test on the canvas: find gantry screen position
await page.mouse.click(760, 330);
await page.waitForTimeout(1200);
await page.screenshot({ timeout: 120000, path: out + '/06-click.png' });
const m = await browser.newPage({ viewport: { width: 400, height: 860 } });
m.on('pageerror', e => logs.push('MOBILE PAGEERROR: ' + e.message));
await m.goto(url, { waitUntil: 'networkidle' });
await m.waitForTimeout(3000);
await m.screenshot({ timeout: 120000, path: out + '/07-mobile.png', fullPage: true });
const ov = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
console.log('mobile overflow px', ov);
console.log(logs.join('\n') || 'no console errors');
await browser.close();
