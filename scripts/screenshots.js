#!/usr/bin/env node
// Captures the README screenshots (phone size, sample data) into assets/screenshots/.
// Run `npm run build` first.

const path = require('path');
const { launch, serve } = require('../tests/browser');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'screenshots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const server = await serve(path.join(ROOT, 'docs'), 8766);
  const browser = await launch();
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    const tap = sel => page.evaluate(s => document.querySelector(s).click(), sel);
    await page.goto('http://localhost:8766/', { waitUntil: 'networkidle0' }); await sleep(600);
    await page.type('#a-name', 'Ayşe'); await page.type('#a-user', 'ayse'); await page.type('#a-pw', 'ornek123'); await page.type('#a-pw2', 'ornek123');
    await tap('#auth-form [type=submit]'); await page.waitForSelector('.code-box'); await sleep(200);
    await tap('.modal [data-m=ok]'); await sleep(300);
    // A believable morning: a few things done, one medicine running low.
    await page.evaluate(() => {
      [0, 1, 2, 5, 3].forEach(k => S.data.tasks.push(normTask(TEMPLATES[k].t)));
      S.data.tasks[0].stock.qty = 5;
      S.data.tasks[1].priority = 1;
      const today = new Date().toISOString().slice(0, 10);
      S.data.tasks.forEach(t => { t.start = addDays(today, -20); });
      for (let k = 1; k <= 20; k++) {
        const s = addDays(today, -k);
        dayItems(s, false).forEach((it, i) => { if ((i + k) % 5) setHv(s, it.key, '09:0' + (k % 10)); });
      }
      const first = dayItems(today, false).slice(0, 2);
      first.forEach(it => setHv(today, it.key, '08:1' + it.i));
      saveApp(); render();
    });
    await sleep(500);
    if (scheme === 'light') {
      await page.screenshot({ path: path.join(OUT, 'today.png') });
      await tap('.fab-wrap'); await sleep(500);
      await page.type('#f-title', 'Tansiyon ilacı');
      await tap('[data-act=ed-time-add][data-v="09:00"]'); await sleep(100);
      await tap('[data-act=ed-time-add][data-v="22:00"]'); await sleep(200);
      await page.screenshot({ path: path.join(OUT, 'add-task.png') });
      await tap('[data-act=close]'); await sleep(400);
      await tap('.tab[data-v=stats]'); await sleep(400);
      await page.screenshot({ path: path.join(OUT, 'progress.png') });
    } else {
      await page.screenshot({ path: path.join(OUT, 'today-dark.png') });
    }
    await ctx.close();
  }
  await browser.close();
  server.close();
  console.log('screenshots written to assets/screenshots/');
})();
