const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const SESSION_COOKIE = 'ritim_sid';
const SESSION_DAYS = 90;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_DOC_BYTES = 256 * 1024;
const MAX_DOCS = 3000;
const DOC_NAME = /^(app|h)_[A-Za-z0-9_-]{1,40}$/;

// ---------- small helpers ----------

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code) => { throw new HttpError(status, code); };

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(secret, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifySecret(secret, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(secret), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// XXXX-XXXX-XXXX, shown once at sign-up. Stored hashed, compared without dashes.
function recoveryCode() {
  let out = '';
  for (const b of crypto.randomBytes(12)) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function str(v, max, field) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') fail(400, `invalid_${field}`);
  v = v.trim();
  if (v.length > max) fail(400, `too_long_${field}`);
  return v;
}

function password(v) {
  if (typeof v !== 'string' || v.length < 6) fail(400, 'weak_password');
  if (v.length > 200) fail(400, 'too_long_password');
  return v;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let h = hits.get(key);
    if (!h || h.reset < now) {
      h = { count: 0, reset: now + windowMs };
      hits.set(key, h);
    }
    if (++h.count > max) return res.status(429).json({ error: 'too_many_attempts' });
    if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}

// ---------- app ----------

function createApp(db, { secureCookies = false, authRateLimit = 30, staticDir } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const q = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    insertUser: db.prepare('INSERT INTO users (username, name, color, password_hash, recovery_hash) VALUES (?, ?, ?, ?, ?)'),
    setName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    setRecovery: db.prepare('UPDATE users SET recovery_hash = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    bumpRev: db.prepare('UPDATE users SET rev = rev + 1 WHERE id = ? RETURNING rev'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    sessionUser: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    getDoc: db.prepare('SELECT data FROM docs WHERE user_id = ? AND name = ?'),
    docsSince: db.prepare('SELECT name, data, rev FROM docs WHERE user_id = ? AND rev > ? AND name LIKE ? ESCAPE \'\\\''),
    countDocs: db.prepare('SELECT COUNT(*) AS n FROM docs WHERE user_id = ?'),
    upsertDoc: db.prepare(`INSERT INTO docs (user_id, name, data, rev) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id, name) DO UPDATE SET data = excluded.data, rev = excluded.rev`),
    deleteDoc: db.prepare('DELETE FROM docs WHERE user_id = ? AND name = ?'),
  };

  const accountOut = (u) => ({ id: String(u.id), name: u.name, username: u.username, color: u.color });

  // ---------- sessions ----------

  function startSession(res, userId, remember) {
    const token = crypto.randomBytes(32).toString('base64url');
    const maxAge = SESSION_DAYS * 864e5;
    q.purgeSessions.run(Date.now());
    q.insertSession.run(sha256(token), userId, Date.now() + maxAge);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      path: '/',
      // Without "remember me" the cookie ends with the browser session.
      ...(remember !== false && { maxAge }),
    });
    return token;
  }

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const user = q.sessionUser.get(sha256(token), Date.now());
    if (user) req.tokenHash = sha256(token);
    return user || null;
  }

  const requireUser = (req, res, next) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'not_signed_in' });
    req.user = user;
    next();
  };

  const checkPassword = (user, pw) => {
    if (!verifySecret(String(pw || ''), user.password_hash)) fail(403, 'wrong_password');
  };

  // ---------- routes ----------

  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const authLimit = rateLimiter({ windowMs: 15 * 60e3, max: authRateLimit });

  api.get('/health', (req, res) => res.json({ ok: true, app: 'ritim' }));

  api.post('/register', authLimit, (req, res) => {
    const name = str(req.body.name, 40, 'name');
    const username = str(req.body.username, 20, 'username').toLowerCase();
    if (name.length < 2) fail(400, 'short_name');
    if (!/^[a-z0-9_.]{3,20}$/.test(username)) fail(400, 'invalid_username');
    const pw = password(req.body.password);
    const color = /^#[0-9A-Fa-f]{6}$/.test(req.body.color || '') ? req.body.color : '#3A7BE0';
    if (q.userByName.get(username)) fail(409, 'username_taken');
    const code = recoveryCode();
    const { lastInsertRowid } = q.insertUser.run(username, name, color, hashSecret(pw), hashSecret(normCode(code)));
    startSession(res, lastInsertRowid, req.body.remember);
    res.status(201).json({ account: accountOut(q.userById.get(lastInsertRowid)), recoveryCode: code });
  });

  api.post('/login', authLimit, (req, res) => {
    const user = q.userByName.get(String(req.body.username || '').trim().toLowerCase());
    if (!user || !verifySecret(String(req.body.password || ''), user.password_hash)) fail(401, 'wrong_credentials');
    startSession(res, user.id, req.body.remember);
    res.json({ account: accountOut(user) });
  });

  api.post('/reset', authLimit, (req, res) => {
    const user = q.userByName.get(String(req.body.username || '').trim().toLowerCase());
    if (!user || !verifySecret(normCode(req.body.code), user.recovery_hash)) fail(401, 'wrong_code');
    const pw = password(req.body.password);
    q.setPassword.run(hashSecret(pw), user.id);
    // A reset signs out every other device.
    const token = startSession(res, user.id, true);
    q.deleteOtherSessions.run(user.id, sha256(token));
    res.json({ account: accountOut(user) });
  });

  api.post('/logout', (req, res) => {
    if (currentUser(req)) q.deleteSession.run(req.tokenHash);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  api.get('/me', requireUser, (req, res) => res.json({ account: accountOut(req.user) }));

  api.patch('/account', requireUser, (req, res) => {
    const name = str(req.body.name, 40, 'name');
    if (name.length < 2) fail(400, 'short_name');
    q.setName.run(name, req.user.id);
    res.json({ account: accountOut(q.userById.get(req.user.id)) });
  });

  api.post('/account/password', requireUser, (req, res) => {
    checkPassword(req.user, req.body.current);
    q.setPassword.run(hashSecret(password(req.body.password)), req.user.id);
    q.deleteOtherSessions.run(req.user.id, req.tokenHash);
    res.json({ ok: true });
  });

  api.post('/account/recovery-code', requireUser, (req, res) => {
    checkPassword(req.user, req.body.current);
    const code = recoveryCode();
    q.setRecovery.run(hashSecret(normCode(code)), req.user.id);
    res.json({ recoveryCode: code });
  });

  api.delete('/account', requireUser, (req, res) => {
    checkPassword(req.user, req.body && req.body.current);
    q.deleteUser.run(req.user.id); // sessions and docs go with it (ON DELETE CASCADE)
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // ---------- documents ----------

  const docName = (n) => { if (!DOC_NAME.test(n)) fail(400, 'invalid_name'); return n; };

  // Everything that changed after `since` (optionally only names starting with `prefix`).
  // Devices poll this to pick up edits made on other devices.
  api.get('/docs', requireUser, (req, res) => {
    const since = Math.max(0, parseInt(req.query.since, 10) || 0);
    const prefix = String(req.query.prefix || '').replace(/[\\%_]/g, (c) => '\\' + c);
    const docs = {};
    for (const row of q.docsSince.all(req.user.id, since, prefix + '%')) docs[row.name] = JSON.parse(row.data);
    res.json({ rev: q.userById.get(req.user.id).rev, docs });
  });

  api.get('/docs/:name', requireUser, (req, res) => {
    const row = q.getDoc.get(req.user.id, docName(req.params.name));
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(JSON.parse(row.data));
  });

  const writeDoc = db.transaction((userId, name, data) => {
    if (!q.getDoc.get(userId, name) && q.countDocs.get(userId).n >= MAX_DOCS) fail(413, 'quota_exceeded');
    const { rev } = q.bumpRev.get(userId);
    q.upsertDoc.run(userId, name, data, rev);
    return rev;
  });

  api.put('/docs/:name', requireUser, (req, res) => {
    const name = docName(req.params.name);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) fail(400, 'invalid_body');
    const data = JSON.stringify(req.body);
    if (Buffer.byteLength(data) > MAX_DOC_BYTES) fail(413, 'quota_exceeded');
    res.json({ rev: writeDoc(req.user.id, name, data) });
  });

  api.delete('/docs/:name', requireUser, (req, res) => {
    q.deleteDoc.run(req.user.id, docName(req.params.name));
    res.json({ ok: true });
  });

  api.use((req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'quota_exceeded' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_body' });
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  });

  app.use('/api', api);

  // ---------- the app itself (the same build that GitHub Pages serves) ----------

  const dir = staticDir || path.join(__dirname, '..', 'docs');
  // Mark the page so the app knows to use this server instead of the device's storage.
  const index = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
    .replace('<head>', '<head>\n<meta name="ritim-server" content="1">');
  app.get(['/', '/index.html'], (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(index));
  app.use(express.static(dir, {
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  }));

  return app;
}

module.exports = { createApp, recoveryCode, normCode };
