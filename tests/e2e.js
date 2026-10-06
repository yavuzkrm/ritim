#!/usr/bin/env node
// End-to-end tests: drive the built app (docs/) in headless Chrome at phone size.
// Run `npm run build` first, then `npm test`.

const path = require('path');
const { launch, serve } = require('./browser');

const DOCS = path.resolve(__dirname, '..', 'docs');
const PORT = 8765;
const URL = `http://localhost:${PORT}/`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, cond, extra = '') => results.push({ ok: !!cond, line: `${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}` });

(async () => {
  const server = await serve(DOCS, PORT);
  const browser = await launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

  const tap = sel => page.evaluate(s => { const el = document.querySelector(s); if (!el) throw new Error('missing ' + s); el.click(); }, sel);
  const fill = async (sel, value) => { await page.$eval(sel, e => { e.value = ''; }); await page.type(sel, value); };
  const run = fn => page.evaluate(fn);

  try {
    // ---- install / offline plumbing ----
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await sleep(1000);
    check('service worker registers', await run(async () => !!(await navigator.serviceWorker.getRegistration())));
    check('manifest is served', (await run(async () => (await (await fetch('manifest.webmanifest')).json()).short_name)) === 'Ritim');
    await page.reload({ waitUntil: 'networkidle0' }); await sleep(500);
    check('service worker controls the page', await run(() => !!navigator.serviceWorker.controller));

    // ---- sign up ----
    check('register form shows when there are no accounts', await page.$('#a-name'));
    await fill('#a-name', 'Yavuz'); await fill('#a-user', 'yavuz'); await fill('#a-pw', '123'); await fill('#a-pw2', '123');
    await tap('#auth-form [type=submit]'); await sleep(300);
    check('short password is rejected', (await page.$eval('#a-err', e => e.textContent)).includes('6'));
    await fill('#a-pw', 'gizli123'); await fill('#a-pw2', 'gizli123');
    await tap('#auth-form [type=submit]');
    await page.waitForSelector('.code-box', { timeout: 8000 });
    const code = await page.$eval('.code-box', e => e.textContent);
    check('recovery code is shown', /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code));
    await tap('.modal [data-m=ok]'); await sleep(400);

    // ---- today view ----
    check('empty state offers templates', (await page.$$('.tpl')).length >= 6);
    await tap('[data-act=sample]'); await sleep(400);
    check('sample tasks appear on today', (await page.$$('#view .item')).length > 0);
    check('templates do not mark tasks important', await run(() => S.data.tasks.every(t => !t.priority)));
    check('page fits the screen (list scrolls inside)', await run(() => document.documentElement.scrollHeight <= innerHeight + 1));
    await tap('#view .item .do-btn'); await sleep(300);
    check('"Yaptım" marks a task done', (await page.$$('#view .item.is-done')).length === 1);
    check('progress ring updates', (await page.$eval('.ring .val', e => e.textContent)) !== '0%');
    await run(() => { S.data.tasks[1].times = ['00:01', '21:00']; render(); });
    check('missed time is flagged', await run(() => [...document.querySelectorAll('.m-late')].some(e => e.textContent.includes('Saati geçti'))));

    // ---- add a task ----
    await tap('.fab-wrap'); await sleep(450);
    await fill('#f-title', 'Antibiyotik');
    await tap('[data-act=ed-type][data-v=weekly]'); await sleep(120);
    await tap('[data-act=ed-days][data-v="1,2,3,4,5"]'); await sleep(120);
    await tap('[data-act=ed-time-add][data-v="09:00"]'); await sleep(120);
    await tap('[data-act=ed-time-add][data-v="22:00"]'); await sleep(120);
    check('new tasks default to not important', await run(() => D.priority === 0));
    await tap('[data-act=ed-prio][data-v="1"]'); await sleep(120);
    await tap('[data-act=ed-more]'); await sleep(120);
    await tap('[data-act=ed-dur][data-v="7"]'); await sleep(120);
    await tap('#f-stock'); await sleep(150);
    const summary = await page.$eval('#ed-sum span', e => e.textContent);
    check('editor summary describes the schedule', summary.includes('Hafta içi') && summary.includes('09:00'), summary);
    await tap('[data-act=ed-save]'); await sleep(500);
    check('task is saved as important', await run(() => S.data.tasks.some(t => t.title === 'Antibiyotik' && t.priority === 1 && t.stock.on && t.end)));

    // ---- recurrence rules ----
    const logic = await run(() => {
      const mk = (rec, extra = {}) => normTask({ title: 'x', rec, start: '2026-01-01', ...extra });
      return {
        'monthly on the last day': occursOn(mk({ type: 'monthly', every: 1, mday: -1 }), '2026-02-28') && !occursOn(mk({ type: 'monthly', every: 1, mday: -1 }), '2026-02-27'),
        'day 31 falls back to day 30': occursOn(mk({ type: 'monthly', every: 1, mday: 31 }), '2026-04-30'),
        'every 3 days': occursOn(mk({ type: 'daily', every: 3 }), '2026-01-04') && !occursOn(mk({ type: 'daily', every: 3 }), '2026-01-05'),
        'every 2 weeks': (() => { const t = mk({ type: 'weekly', every: 2, days: [1] }, { start: '2026-01-05' }); return occursOn(t, '2026-01-05') && !occursOn(t, '2026-01-12') && occursOn(t, '2026-01-19'); })(),
        'Feb 29 yearly in a non-leap year': occursOn(mk({ type: 'yearly', month: 1, day: 29 }), '2027-02-28'),
        'end date respected': !occursOn(mk({ type: 'daily', every: 1 }, { end: '2026-01-10' }), '2026-01-11'),
        'nothing before start': !occursOn(mk({ type: 'daily', every: 1 }), '2025-12-31'),
        'stable across DST change': occursOn(mk({ type: 'daily', every: 7 }), '2026-04-02'),
      };
    });
    for (const [k, v] of Object.entries(logic)) check('recurrence: ' + k, v);

    // ---- other views ----
    for (const v of ['calendar', 'tasks', 'stats']) {
      await tap(`.tab[data-v=${v}]`); await sleep(300);
      const overflow = await run(() => [...document.querySelectorAll('#view *')].some(e => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('.chips') && !e.closest('.heat')));
      check(`no sideways overflow on ${v}`, !overflow);
    }
    // Smallest common phone width with the largest text size: nothing may stick out,
    // including the tab bar.
    await page.setViewport({ width: 320, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await run(() => { S.data.settings.fontSize = 'cokbuyuk'; applyTheme(); render(); });
    for (const v of ['today', 'calendar', 'tasks', 'stats']) {
      await tap(`.tab[data-v=${v}]`); await sleep(300);
      const out = await run(() => [...document.querySelectorAll('#view *, .tabbar *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1) && !e.closest('.chips') && !e.closest('.heat'); }).length);
      check(`fits 320px with the largest text on ${v}`, out === 0, out ? `${out} elements` : '');
    }
    // Android Chrome draws date/time inputs much wider than desktop Chrome. Imitate that
    // and check that the task editor still fits and never scrolls sideways.
    await run(() => { const st = document.createElement('style'); st.id = 'wide-inputs'; st.textContent = 'input[type=date]::-webkit-datetime-edit,input[type=time]::-webkit-datetime-edit{padding-right:9rem}'; document.head.appendChild(st); });
    await tap('.tab[data-v=today]'); await sleep(200);
    await tap('.fab-wrap'); await sleep(450);
    await tap('[data-act=ed-time-add][data-v="09:00"]'); await sleep(120);
    await tap('[data-act=ed-more]'); await sleep(150);
    await tap('#f-stock'); await sleep(150);
    const ed = await run(() => {
      const b = document.querySelector('#ed-body') || document.querySelector('.sheet-b');
      const out = [...document.querySelectorAll('.sheet *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1) && !e.closest('.chips'); }).length;
      return { sideways: b.scrollWidth > b.clientWidth + 1, out };
    });
    check('task editor fits with wide Android date inputs', !ed.sideways && ed.out === 0, JSON.stringify(ed));
    await run(() => { document.getElementById('wide-inputs').remove(); closeAll(); }); await sleep(400);
    await run(() => { S.data.settings.fontSize = 'normal'; applyTheme(); render(); });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await tap('.tab[data-v=tasks]'); await sleep(200);
    await page.type('#t-search', 'anti'); await sleep(200);
    check('search filters the list', (await page.$$('#t-list .item')).length === 1);
    check('search keeps keyboard focus', await run(() => document.activeElement.id === 't-search'));
    await tap('#t-list .item'); await sleep(450);
    check('task detail opens', await page.$('#dt-body .d-head'));
    await tap('[data-act=star]'); await sleep(200);
    check('star can be removed from the detail screen', await run(() => S.data.tasks.find(t => t.title === 'Antibiyotik').priority === 0));
    await tap('[data-act=close]'); await sleep(350);

    // ---- settings ----
    await tap('.tab[data-v=today]'); await sleep(200);
    await tap('#h-av'); await sleep(450);
    await tap('[data-act=fontsize][data-v=cokbuyuk]'); await sleep(200);
    check('text size setting applies', await run(() => document.documentElement.style.fontSize === '21px'));
    await tap('[data-act=close]'); await sleep(350);
    check('largest text still fits the width', !(await run(() => [...document.querySelectorAll('#view *')].some(e => e.getBoundingClientRect().right > innerWidth + 1))));
    await tap('#h-av'); await sleep(450);
    await tap('[data-act=fontsize][data-v=normal]'); await sleep(150);
    await tap('[data-act=theme][data-v=dark]'); await sleep(150);

    // ---- sign out / in, persistence, offline ----
    await tap('[data-act=logout]'); await sleep(400);
    check('logout returns to sign-in', await page.$('#auth-form'));
    await fill('#a-user', 'yavuz'); await fill('#a-pw', 'yanlis11');
    await tap('#auth-form [type=submit]'); await sleep(900);
    check('wrong password is rejected', (await page.$eval('#a-err', e => e.textContent)).includes('hatalı'));
    await fill('#a-pw', 'gizli123');
    await tap('#auth-form [type=submit]');
    await page.waitForSelector('#view', { timeout: 8000 }); await sleep(400);
    const kept = await run(() => ({ n: S.data.tasks.length, theme: S.data.settings.theme, months: Object.keys(S.hist).length }));
    check('data survives sign-out', kept.n === 6 && kept.theme === 'dark' && kept.months === 1, JSON.stringify(kept));
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(1200);
    check('opens offline with session and data', await run(() => !!document.querySelector('#view') && S.data.tasks.length === 6));
    await page.setOfflineMode(false);

    // ---- password reset with the recovery code ----
    await run(() => logout()); await sleep(400);
    await tap('[data-act=auth-tab][data-v=reset]'); await sleep(200);
    await fill('#a-user', 'yavuz'); await fill('#a-code', code.toLowerCase());
    await fill('#a-pw', 'yeniSifre1'); await fill('#a-pw2', 'yeniSifre1');
    await tap('#auth-form [type=submit]');
    await page.waitForSelector('#view', { timeout: 8000 });
    check('password reset with recovery code', true);

    check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('test run finished', false, e.message);
  }

  await browser.close();
  server.close();
  for (const r of results) console.log(r.line);
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
