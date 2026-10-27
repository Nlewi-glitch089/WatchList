// End-to-end API tests using Node's built-in test runner against a real
// server instance and a fresh, throwaway MongoDB database.
process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers/testServer');

let testServer;
let db;
let baseUrl;

before(async () => {
  testServer = await startTestServer();
  ({ db, baseUrl } = testServer);
});

after(() => testServer?.stop());

// A tiny HTTP client that remembers its session cookie, like a browser would.
function createClient() {
  let cookie = '';
  return {
    async request(method, path, body) {
      const headers = {};
      if (cookie) headers.Cookie = cookie;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        redirect: 'manual',
      });
      const setCookie = res.headers.getSetCookie();
      if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers, setCookie };
    },
  };
}

test('frontend pages are served, and the watchlist page requires login', async () => {
  const client = createClient();
  const login = await client.request('GET', '/login.html');
  assert.equal(login.status, 200);
  assert.match(login.data, /Welcome back/);

  const css = await client.request('GET', '/css/style.css');
  assert.equal(css.status, 200);

  const home = await client.request('GET', '/');
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/login.html');
});

test('registration creates a user, hashes the password, and starts a session', async () => {
  const client = createClient();
  const res = await client.request('POST', '/api/auth/register', { username: 'alice', password: 'password123' });
  assert.equal(res.status, 201);
  assert.equal(res.data.user.username, 'alice');
  assert.equal(res.data.user.password, undefined);
  assert.equal(res.data.user.password_hash, undefined);

  const cookie = res.setCookie.find((c) => c.startsWith('watchlist.sid='));
  assert.ok(cookie, 'session cookie should be set');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);

  const row = await db.collection('users').findOne({ username_lower: 'alice' });
  assert.notEqual(row.password_hash, 'password123');
  assert.match(row.password_hash, /^\$2[aby]\$/, 'password should be stored as a bcrypt hash');

  const me = await client.request('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.deepEqual(Object.keys(me.data.user).sort(), ['id', 'username']);

  const home = await client.request('GET', '/');
  assert.equal(home.status, 200);
});

test('duplicate and invalid registrations are rejected', async () => {
  const client = createClient();
  await client.request('POST', '/api/auth/register', { username: 'bob', password: 'password123' });

  const dup = await createClient().request('POST', '/api/auth/register', { username: 'BOB', password: 'different123' });
  assert.equal(dup.status, 409);

  const shortPass = await createClient().request('POST', '/api/auth/register', { username: 'carol', password: 'short' });
  assert.equal(shortPass.status, 400);

  const badName = await createClient().request('POST', '/api/auth/register', { username: 'a b', password: 'password123' });
  assert.equal(badName.status, 400);

  const missing = await createClient().request('POST', '/api/auth/register', {});
  assert.equal(missing.status, 400);
});

test('login accepts valid credentials and rejects invalid ones', async () => {
  await createClient().request('POST', '/api/auth/register', { username: 'dave', password: 'password123' });

  const wrongPass = await createClient().request('POST', '/api/auth/login', { username: 'dave', password: 'wrongpass1' });
  assert.equal(wrongPass.status, 401);
  assert.equal(wrongPass.data.error, 'Invalid username or password.');

  const noUser = await createClient().request('POST', '/api/auth/login', { username: 'nobody', password: 'password123' });
  assert.equal(noUser.status, 401);
  assert.equal(noUser.data.error, 'Invalid username or password.');

  const empty = await createClient().request('POST', '/api/auth/login', { username: '', password: '' });
  assert.equal(empty.status, 400);

  const client = createClient();
  const ok = await client.request('POST', '/api/auth/login', { username: 'dave', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.username, 'dave');
  assert.equal(ok.data.user.password_hash, undefined);

  const me = await client.request('GET', '/api/auth/me');
  assert.equal(me.status, 200);
});

test('logout ends the session', async () => {
  const client = createClient();
  await client.request('POST', '/api/auth/register', { username: 'erin', password: 'password123' });
  assert.equal((await client.request('GET', '/api/movies')).status, 200);

  const out = await client.request('POST', '/api/auth/logout');
  assert.equal(out.status, 200);

  assert.equal((await client.request('GET', '/api/auth/me')).status, 401);
  assert.equal((await client.request('GET', '/api/movies')).status, 401);
});

test('sessions are stored in MongoDB, and an expired session is no longer accepted', async () => {
  const sessionIndex = (await db.collection('sessions').indexes()).find((i) => i.key.expires === 1);
  assert.equal(sessionIndex.expireAfterSeconds, 0, 'MongoDB deletes sessions once they expire');

  const client = createClient();
  const reg = await client.request('POST', '/api/auth/register', { username: 'expiry_user', password: 'password123' });
  const sid = decodeURIComponent(reg.setCookie[0].split(';')[0].split('=')[1]).slice(2).split('.')[0];
  const stored = await db.collection('sessions').findOne({ _id: sid });
  assert.ok(stored.expires > new Date(), 'a new session expires in the future');
  assert.equal(JSON.parse(stored.session).userId, reg.data.user.id);
  assert.equal((await client.request('GET', '/api/auth/me')).status, 200);

  // The TTL monitor only runs about once a minute, so the store must ignore expired documents itself.
  await db.collection('sessions').updateOne({ _id: sid }, { $set: { expires: new Date(Date.now() - 1000) } });
  assert.equal((await client.request('GET', '/api/auth/me')).status, 401);
  assert.equal((await client.request('GET', '/api/movies')).status, 401);
});

test('protected routes reject unauthenticated requests', async () => {
  const client = createClient();
  assert.equal((await client.request('GET', '/api/auth/me')).status, 401);
  assert.equal((await client.request('GET', '/api/movies')).status, 401);
  assert.equal((await client.request('POST', '/api/movies', { title: 'Heat' })).status, 401);
  assert.equal((await client.request('PATCH', '/api/movies/1', { watched: true })).status, 401);
  assert.equal((await client.request('DELETE', '/api/movies/1')).status, 401);
});

test('a user can add, list, update, and remove movies', async () => {
  const client = createClient();
  await client.request('POST', '/api/auth/register', { username: 'frank', password: 'password123' });

  const empty = await client.request('GET', '/api/movies');
  assert.deepEqual(empty.data.movies, []);

  const added = await client.request('POST', '/api/movies', { title: '  Arrival ', year: 2016, genre: 'Sci-Fi' });
  assert.equal(added.status, 201);
  assert.equal(added.data.movie.title, 'Arrival');
  assert.equal(added.data.movie.year, 2016);
  assert.equal(added.data.movie.genre, 'Sci-Fi');
  assert.equal(added.data.movie.watched, false);

  const titleOnly = await client.request('POST', '/api/movies', { title: 'Paddington 2' });
  assert.equal(titleOnly.status, 201);
  assert.equal(titleOnly.data.movie.year, null);
  assert.equal(titleOnly.data.movie.genre, null);

  const list = await client.request('GET', '/api/movies');
  assert.equal(list.data.movies.length, 2);

  const id = added.data.movie.id;
  const watched = await client.request('PATCH', `/api/movies/${id}`, { watched: true });
  assert.equal(watched.status, 200);
  assert.equal(watched.data.movie.watched, true);
  assert.equal(watched.data.movie.title, 'Arrival');

  const unwatched = await client.request('PATCH', `/api/movies/${id}`, { watched: false });
  assert.equal(unwatched.data.movie.watched, false);

  const removed = await client.request('DELETE', `/api/movies/${id}`);
  assert.equal(removed.status, 200);

  const after = await client.request('GET', '/api/movies');
  assert.equal(after.data.movies.length, 1);
  assert.equal(after.data.movies[0].title, 'Paddington 2');

  const again = await client.request('DELETE', `/api/movies/${id}`);
  assert.equal(again.status, 404);
});

test('invalid movie data is rejected', async () => {
  const client = createClient();
  await client.request('POST', '/api/auth/register', { username: 'grace', password: 'password123' });

  const cases = [
    {},
    { title: '' },
    { title: '   ' },
    { title: 123 },
    { title: 'x'.repeat(201) },
    { title: 'Old', year: 1800 },
    { title: 'Future', year: 3000 },
    { title: 'Decimal', year: 2000.5 },
    { title: 'Text year', year: 'soon' },
    { title: 'Genre', genre: 'g'.repeat(51) },
  ];
  for (const body of cases) {
    const res = await client.request('POST', '/api/movies', body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.ok(res.data.error);
  }

  const { data } = await client.request('POST', '/api/movies', { title: 'Valid' });
  const id = data.movie.id;
  assert.equal((await client.request('PATCH', `/api/movies/${id}`, { watched: 'yes' })).status, 400);
  assert.equal((await client.request('PATCH', `/api/movies/${id}`, {})).status, 400);
  assert.equal((await client.request('PATCH', '/api/movies/abc', { watched: true })).status, 400);

  const badJson = await client.request('POST', '/api/movies', '{not json');
  assert.equal(badJson.status, 400);

  assert.equal((await client.request('GET', '/api/movies')).data.movies.length, 1);
});

test("one user cannot see, modify, or delete another user's movies", async () => {
  const owner = createClient();
  const intruder = createClient();
  await owner.request('POST', '/api/auth/register', { username: 'heidi', password: 'password123' });
  await intruder.request('POST', '/api/auth/register', { username: 'ivan', password: 'password123' });

  const { data } = await owner.request('POST', '/api/movies', { title: 'Private Movie' });
  const id = data.movie.id;

  const intruderList = await intruder.request('GET', '/api/movies');
  assert.ok(!intruderList.data.movies.some((m) => m.id === id));

  const patch = await intruder.request('PATCH', `/api/movies/${id}`, { watched: true, title: 'Hacked' });
  assert.equal(patch.status, 404);

  const del = await intruder.request('DELETE', `/api/movies/${id}`);
  assert.equal(del.status, 404);

  const ownerList = await owner.request('GET', '/api/movies');
  const movie = ownerList.data.movies.find((m) => m.id === id);
  assert.equal(movie.title, 'Private Movie');
  assert.equal(movie.watched, false);
});

test('unknown API routes return JSON 404', async () => {
  const res = await createClient().request('GET', '/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.data.error, 'Not found.');
});
