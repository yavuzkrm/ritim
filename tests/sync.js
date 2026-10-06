#!/usr/bin/env node
// Sync test: run the server, sign in to the same account from two separate browser
// profiles ("phone" and "laptop") and check that changes on one show up on the other.
// Run `npm run build` first, then `npm run test:sync`.

const { launch } = require('./browser');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');

const PORT = 8766;
const URL = `http://localhost:${PORT}/`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, cond, extra = '') => results.push({ ok: !!cond, line: `${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}` });

async function device(browser, errors) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const d = {
    page,
    tap: sel => page.evaluate(s => { const el = document.querySelector(s); if (!el) throw new Error('missing ' + s); el.click(); }, sel),
    fill: async (sel, value) => { await page.$eval(sel, e => { e.value = ''; }); await page.type(sel, value); },
    run: (fn, ...args) => page.evaluate(fn, ...args),
    // Wait until this device's saves have reached the server, then pull the other side's changes.
    settle: () => page.evaluate(async () => { await Store.idle(); }),
    pull: () => page.evaluate(async () => { await Sync.poll(); await sleep(50); }),
  };
  return d;
}

(async () => {
  const app = createApp(openDb(':memory:'), { authRateLimit: 1000 });
  const server = await new Promise(r => { const s = app.listen(PORT, '127.0.0.1', () => r(s)); });
  const browser = await launch();
  const errors = [];

  try {
    const phone = await device(browser, errors);
    const laptop = await device(browser, errors);

    // ---- sign up on the phone ----
    await phone.page.goto(URL, { waitUntil: 'networkidle0' });
    check('page knows it is served by the server', await phone.run(() => S.mode === 'server'));
    check('sign-up note mentions syncing', (await phone.page.$eval('.auth .note', e => e.textContent)).includes('senkron'));
    await phone.fill('#a-name', 'Ayşe'); await phone.fill('#a-user', 'ayse'); await phone.fill('#a-pw', 'gizli123'); await phone.fill('#a-pw2', 'gizli123');
    await phone.tap('#auth-form [type=submit]');
    await phone.page.waitForSelector('.code-box', { timeout: 8000 });
    check('recovery code comes from the server', /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(await phone.page.$eval('.code-box', e => e.textContent)));
    await phone.tap('.modal [data-m=ok]'); await sleep(400);
    await phone.tap('[data-act=sample]'); await sleep(400);
    await phone.settle();
    const nTasks = await phone.run(() => S.data.tasks.length);
    check('sample tasks created on the phone', nTasks > 0, `n=${nTasks}`);

    // ---- sign in on the laptop ----
    await laptop.page.goto(URL, { waitUntil: 'networkidle0' });
    await laptop.tap('[data-act=auth-tab][data-v=login]'); await sleep(150);
    await laptop.fill('#a-user', 'ayse'); await laptop.fill('#a-pw', 'yanlis1');
    await laptop.tap('#auth-form [type=submit]'); await sleep(400);
    check('wrong password is rejected', (await laptop.page.$eval('#a-err', e => e.textContent)).includes('hatalı'));
    await laptop.fill('#a-pw', 'gizli123');
    await laptop.tap('#auth-form [type=submit]');
    await laptop.page.waitForSelector('#view', { timeout: 8000 }); await sleep(300);
    check('laptop sees the phone\'s tasks', (await laptop.run(() => S.data.tasks.length)) === nTasks);
    check('settings show cloud sync', await laptop.run(() => { openSettings(); return document.querySelector('.sync').classList.contains('on'); }));
    await laptop.run(() => closeAll()); await sleep(350);

    // ---- laptop -> phone: complete a task ----
    await laptop.tap('#view .item .do-btn'); await sleep(300);
    await laptop.settle();
    await phone.pull();
    check('task done on the laptop shows as done on the phone', (await phone.page.$$('#view .item.is-done')).length === 1);

    // ---- phone -> laptop: edit a task ----
    await phone.run(() => { S.data.tasks[0].title = 'Telefonda değişti'; saveApp(); });
    await sleep(400); await phone.settle();
    await laptop.pull();
    check('edit on the phone reaches the laptop', await laptop.run(() => S.data.tasks[0].title === 'Telefonda değişti'));

    // ---- regular polling also picks up changes ----
    await laptop.run(() => { S.data.settings.theme = 'dark'; saveApp(); });
    await sleep(400); await laptop.settle();
    await phone.page.waitForFunction(() => S.data.settings.theme === 'dark', { timeout: 20000 }).then(() => check('changes arrive by polling', true), () => check('changes arrive by polling', false));

    // ---- sessions ----
    await laptop.page.reload({ waitUntil: 'networkidle0' }); await sleep(300);
    check('laptop stays signed in after reload', await laptop.run(() => !!S.me && S.me.username === 'ayse'));
    await laptop.run(() => logout()); await sleep(500);
    check('sign-out shows the quick account button', !!(await laptop.page.$('[data-act=pick-user][data-v=ayse]')));
    check('server session is closed', await laptop.run(async () => (await fetch('api/me')).status === 401));
    check('phone is still signed in', await phone.run(async () => (await fetch('api/me')).status === 200));

    // ---- offline ----
    await phone.page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
    await phone.page.setOfflineMode(true);
    await phone.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await sleep(1500);
    check('offline start shows a retry screen', !!(await phone.page.$('[data-act=retry-boot]')));
    await phone.page.setOfflineMode(false);
    await phone.tap('[data-act=retry-boot]');
    await phone.page.waitForSelector('#view', { timeout: 8000 }).then(() => check('retry signs back in when online', true), () => check('retry signs back in when online', false));

    // ---- delete account ----
    await phone.run(() => { openSettings(); }); await sleep(400);
    await phone.tap('[data-act=del-acc]'); await sleep(400);
    await phone.fill('#m-pw', 'gizli123');
    await phone.tap('.modal [data-m=ok]'); await sleep(1200);
    check('account deletion returns to sign-in', !!(await phone.page.$('#auth-form')));
    const relogin = await phone.run(async () => (await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ayse', password: 'gizli123' }) })).status);
    check('deleted account can no longer sign in', relogin === 401);

    check('no JavaScript errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    check('test run completed', false, e.stack);
  } finally {
    await browser.close();
    server.close();
  }

  results.forEach(r => console.log(r.line));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
