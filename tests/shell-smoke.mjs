// Optional. Start the server first (python server/server.py), then:
//   npm i -D playwright && npx playwright install chromium
//   node tests/shell-smoke.mjs http://localhost:8000 ./shots
// The coach works offline (knowledge base in the browser); no AI server is needed.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const base = process.argv[2] || 'http://localhost:8000', out = process.argv[3] || './shots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const logs = [];
page.on('pageerror', e => logs.push('PAGEERROR(shell): ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/fonts|ERR_TUNNEL|404/.test(m.text())) logs.push('console: ' + m.text()); });
const shot = async n => page.screenshot({ timeout: 180000, path: `${out}/sh-${n}.png` });
await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await shot('01-home');
const res = {};
// Train mode
await page.click('nav.modes button[data-mode="train"]');
await page.waitForFunction(() => window.__shell.frames.train && window.__shell.frames.train.ready, null, { timeout: 60000 });
await page.waitForTimeout(3000);
const train = page.frames().find(f => f.url().includes('trainer.html'));
// simulate the controller through the shell
await page.evaluate(() => {
  const h = window.__shell.handleLine;
  h('{"v":1,"type":"hello","fw":"2.0.0","boot":77,"pads":6,"board":"ESP32-S3","imu":"MPU9250","mag":true}');
  h('{"v":1,"type":"action","id":"T2","event":"VERIFY_EQUIPMENT","seq":1,"t":10,"boot":77}');
});
await page.waitForTimeout(800);
res.trainViolations = await train.evaluate(() => window.__mrisafe.session().current.violations().map(v => v.rule));
res.trainLogSources = await train.evaluate(() => window.__mrisafe.session().current.log.map(o => o.src + ':' + o.event));
// orbit via IMU
const cam0 = await train.evaluate(() => { const s = window.__mrisafe; return 1; });
await page.evaluate(async () => { for (let i = 0; i < 10; i++) { window.__shell.handleLine(JSON.stringify({ v: 1, type: 'imu', r: 30, p: 0, gz: 0, mag: 48, dmag: 22, t: i * 40 })); await new Promise(r => setTimeout(r, 40)); } });
// point mode + tap to select
await page.evaluate(() => window.__shell.handleLine('{"v":1,"type":"gesture","g":"flick_left","seq":1,"t":1}'));
await page.waitForTimeout(400);
res.pointMode = await page.evaluate(() => window.__shell.state.imuMode);
// AI explain from the card
await train.click('#fb-toggle');
res.feedbackHidden = await train.$eval('#fb-body', e => e.hidden);
await train.click('#fb-toggle');
await train.click('#fb-log');
res.savedToLog = await train.evaluate(() => JSON.parse(localStorage.getItem('mrisafe-feedback-log') || '[]').length);
await train.click('#ai-explain');
await page.waitForSelector('.msg.bot .badge.built', { timeout: 20000 });
res.aiExplain = await page.$eval('.msg.bot:last-child', e => e.innerText.slice(0, 160));
res.explainCitesRule = /R-[A-Z]+-\d{2}/.test(res.aiExplain); // rule chips drop the brackets
await page.waitForTimeout(500);
await shot('02-train-ai');
// Learn mode
await page.click('nav.modes button[data-mode="learn"]');
await page.waitForFunction(() => window.__shell.frames.learn && window.__shell.frames.learn.ready, null, { timeout: 60000 });
await page.waitForTimeout(3000);
const learn = page.frames().find(f => f.url().includes('internals.html'));
await page.evaluate(() => { const h = window.__shell.handleLine; h('{"v":1,"type":"action","id":"T2","event":"VERIFY_EQUIPMENT","seq":2,"t":20,"boot":77}'); h('{"v":1,"type":"gesture","g":"flick_right","seq":2,"t":2}'); });
await page.waitForTimeout(1200);
res.learnChapter = await learn.evaluate(() => document.getElementById('hud-title').textContent);
res.shellChapter = await page.evaluate(() => window.__shell.state.chapter && window.__shell.state.chapter.title);
await page.fill('#ask-input', 'What is the Larmor frequency?');
await page.press('#ask-input', 'Enter');
await page.waitForFunction(() => [...document.querySelectorAll('.msg.bot')].some(m => m.innerText.includes('63.87')), null, { timeout: 20000 });
res.tutor = await page.$eval('.msg.bot:last-child', e => e.innerText.slice(0, 120));
await page.click('#dev-chip');
await page.evaluate(() => window.__shell.handleLine(JSON.stringify({ v: 1, type: 'imu', r: 12, p: -8, gz: 0, mag: 60, dmag: 25, t: 999 })));
await page.waitForTimeout(600);
await shot('03-learn-ai-device');
await page.click('header [data-theme-toggle]');
res.themeShell = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
await page.waitForTimeout(300); // storage events are asynchronous
res.themeTrainer = await learn.evaluate(() => document.documentElement.getAttribute('data-theme'));
await page.click('header [data-theme-toggle]');
const m = await browser.newPage({ viewport: { width: 400, height: 860 } });
m.on('pageerror', e => logs.push('PAGEERROR(mobile): ' + e.message));
await m.goto(base + '/', { waitUntil: 'networkidle' });
await m.waitForTimeout(1500);
await m.screenshot({ timeout: 120000, path: `${out}/sh-04-mobile.png`, fullPage: true });
res.mobileOverflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
console.log(JSON.stringify(res, null, 1));
console.log(logs.join('\n') || 'no page errors');
await browser.close();
