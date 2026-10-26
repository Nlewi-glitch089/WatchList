// Security behavior: headers, the same-origin check, rate limits, and the health check.
// Runs in its own process, so the rate-limit counters don't affect the other test files.
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'security-test-secret';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

const post = (path, body, headers = {}) =>
  fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('pages and API responses carry security headers', async () => {
  for (const path of ['/login.html', '/api/auth/me']) {
    const res = await fetch(baseUrl + path);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/, 'the inline theme script should be allowed by hash');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('strict-transport-security'), null, 'HSTS is only sent in production');
  }
});

test('the health check reports ok without creating a session', async () => {
  const res = await fetch(`${baseUrl}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
  assert.equal(res.headers.get('set-cookie'), null);
});

test('state-changing API requests from another origin are rejected', async () => {
  const foreign = await post('/api/auth/register', { username: 'csrf_victim', password: 'password123' }, { Origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);

  const host = new URL(baseUrl).host;
  const same = await post('/api/auth/register', { username: 'same_origin', password: 'password123' }, { Origin: `http://${host}` });
  assert.equal(same.status, 201);
});

test('repeated failed logins are blocked with 429, and the block applies even to a correct password', async () => {
  await post('/api/auth/register', { username: 'target', password: 'password123' });

  for (let i = 0; i < 10; i++) {
    const res = await post('/api/auth/login', { username: 'target', password: `wrong-guess-${i}` });
    assert.equal(res.status, 401);
  }
  const blocked = await post('/api/auth/login', { username: 'target', password: 'password123' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.match((await blocked.json()).error, /Too many failed login attempts/);
});

test('account creation is limited per network', async () => {
  // Two accounts were created by the earlier tests in this file.
  for (let i = 0; i < 18; i++) {
    const res = await post('/api/auth/register', { username: `bulk_user_${i}`, password: 'password123' });
    assert.equal(res.status, 201);
  }
  const blocked = await post('/api/auth/register', { username: 'one_too_many', password: 'password123' });
  assert.equal(blocked.status, 429);
});
