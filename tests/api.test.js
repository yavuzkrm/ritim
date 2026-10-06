// API tests for the sync server. Run with `npm run test:api`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');

let server, base;

before(async () => {
  const app = createApp(openDb(':memory:'), { authRateLimit: 1000 });
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// A tiny cookie-keeping client, one per simulated device.
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
}

const signUp = (c, username, password = 'secret1') =>
  c('POST', '/api/register', { name: 'Ayşe', username, password, color: '#2E9E77' });

test('health check identifies the app', async () => {
  const r = await client()('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.app, 'ritim');
});

test('register returns the account and a recovery code, and signs in', async () => {
  const c = client();
  const r = await signUp(c, 'ayse');
  assert.equal(r.status, 201);
  assert.equal(r.data.account.username, 'ayse');
  assert.equal(r.data.account.color, '#2E9E77');
  assert.match(r.data.recoveryCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal((await c('GET', '/api/me')).data.account.username, 'ayse');
});

test('register validates input and rejects taken usernames', async () => {
  const c = client();
  assert.equal((await signUp(c, 'ab')).data.error, 'invalid_username');
  assert.equal((await signUp(c, 'Has Space')).data.error, 'invalid_username');
  assert.equal((await signUp(c, 'kisa', '123')).data.error, 'weak_password');
  assert.equal((await signUp(c, 'taken')).status, 201);
  const again = await signUp(client(), 'TAKEN');
  assert.equal(again.status, 409);
  assert.equal(again.data.error, 'username_taken');
});

test('login checks the password', async () => {
  await signUp(client(), 'mehmet');
  const c = client();
  assert.equal((await c('POST', '/api/login', { username: 'mehmet', password: 'wrong!' })).status, 401);
  assert.equal((await c('GET', '/api/me')).status, 401);
  const ok = await c('POST', '/api/login', { username: ' Mehmet ', password: 'secret1' });
  assert.equal(ok.status, 200);
  assert.equal((await c('GET', '/api/me')).status, 200);
});

test('documents sync between two devices of the same person', async () => {
  const phone = client(), laptop = client();
  const { data } = await signUp(phone, 'zeynep');
  const id = data.account.id;
  await laptop('POST', '/api/login', { username: 'zeynep', password: 'secret1' });

  const start = (await laptop('GET', '/api/docs?since=0')).data.rev;
  await phone('PUT', `/api/docs/app_${id}`, { kind: 'app', tasks: [{ id: 't1', title: 'İlaç' }] });
  await phone('PUT', `/api/docs/h_${id}_2026-10`, { kind: 'hist', month: '2026-10', d: { '2026-10-06': { t1: 1 } } });

  const changes = await laptop('GET', `/api/docs?since=${start}`);
  assert.deepEqual(Object.keys(changes.data.docs).sort(), [`app_${id}`, `h_${id}_2026-10`]);
  assert.equal(changes.data.docs[`app_${id}`].tasks[0].title, 'İlaç');

  // Nothing new since the latest revision.
  const none = await laptop('GET', `/api/docs?since=${changes.data.rev}`);
  assert.deepEqual(none.data.docs, {});

  const hist = await laptop('GET', `/api/docs?prefix=h_${id}_`);
  assert.deepEqual(Object.keys(hist.data.docs), [`h_${id}_2026-10`]);
  assert.equal((await laptop('GET', `/api/docs/app_${id}`)).data.tasks.length, 1);
});

test('people cannot see each other\'s documents', async () => {
  const a = client(), b = client();
  const ida = (await signUp(a, 'elif')).data.account.id;
  await signUp(b, 'can');
  await a('PUT', `/api/docs/app_${ida}`, { kind: 'app', tasks: [{ id: 'x' }] });
  assert.equal((await b('GET', `/api/docs/app_${ida}`)).status, 404);
  assert.deepEqual((await b('GET', '/api/docs?since=0')).data.docs, {});
  assert.equal((await client()('GET', `/api/docs/app_${ida}`)).status, 401);
});

test('document names and bodies are validated', async () => {
  const c = client();
  await signUp(c, 'deniz');
  assert.equal((await c('PUT', '/api/docs/..%2Fetc', { a: 1 })).status, 400);
  assert.equal((await c('PUT', '/api/docs/app_1', [1, 2])).status, 400);
  const big = { s: 'x'.repeat(300 * 1024) };
  assert.equal((await c('PUT', '/api/docs/app_1', big)).data.error, 'quota_exceeded');
});

test('password reset with the recovery code signs out other devices', async () => {
  const old = client();
  const code = (await signUp(old, 'burak')).data.recoveryCode;
  const c = client();
  assert.equal((await c('POST', '/api/reset', { username: 'burak', code: 'AAAA-BBBB-CCCC', password: 'newpass' })).status, 401);
  const r = await c('POST', '/api/reset', { username: 'burak', code: code.toLowerCase().replace(/-/g, ' '), password: 'newpass' });
  assert.equal(r.status, 200);
  assert.equal((await c('GET', '/api/me')).status, 200);
  assert.equal((await old('GET', '/api/me')).status, 401);
  assert.equal((await client()('POST', '/api/login', { username: 'burak', password: 'newpass' })).status, 200);
});

test('account changes need the current password', async () => {
  const c = client();
  await signUp(c, 'selin');
  assert.equal((await c('PATCH', '/api/account', { name: 'Selin K.' })).data.account.name, 'Selin K.');
  assert.equal((await c('POST', '/api/account/password', { current: 'nope', password: 'another' })).data.error, 'wrong_password');
  assert.equal((await c('POST', '/api/account/password', { current: 'secret1', password: 'another' })).status, 200);
  const code = await c('POST', '/api/account/recovery-code', { current: 'another' });
  assert.match(code.data.recoveryCode, /^[A-Z0-9]{4}-/);
});

test('deleting the account removes its data', async () => {
  const c = client();
  const id = (await signUp(c, 'ozan')).data.account.id;
  await c('PUT', `/api/docs/app_${id}`, { kind: 'app' });
  assert.equal((await c('DELETE', '/api/account', { current: 'wrong1' })).status, 403);
  assert.equal((await c('DELETE', '/api/account', { current: 'secret1' })).status, 200);
  assert.equal((await c('GET', '/api/me')).status, 401);
  assert.equal((await client()('POST', '/api/login', { username: 'ozan', password: 'secret1' })).status, 401);
  // The username is free again.
  assert.equal((await signUp(client(), 'ozan')).status, 201);
});

test('logout ends the session', async () => {
  const c = client();
  await signUp(c, 'ece');
  await c('POST', '/api/logout');
  assert.equal((await c('GET', '/api/me')).status, 401);
});

test('the app itself is served next to the API', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Ritim/);
  assert.match(html, /<meta name="ritim-server"/);
  assert.equal((await client()('GET', '/api/nope')).status, 404);
});
