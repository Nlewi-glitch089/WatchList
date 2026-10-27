// Tests for logging, recoverable deletion, theme settings, and TMDB movie search.
// Uses a throwaway MongoDB database and a tiny local stand-in for the TMDB API, so no
// real API key is needed.
process.env.SESSION_SECRET = 'test-secret-do-not-log';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'debug';
delete process.env.TMDB_API_KEY;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ObjectId } = require('mongodb');

// Capture everything the logger prints, so tests can inspect it (and the test output stays clean).
const logs = [];
for (const method of ['log', 'warn', 'error']) {
  console[method] = (...args) => logs.push(args.join(' '));
}
const logsSince = (mark) => logs.slice(mark).join('\n');

const { startTestServer } = require('./helpers/testServer');
const tmdb = require('../lib/tmdb');
const { createLogger, scrub } = require('../lib/logger');

const TMDB_KEY = 'tmdb-test-key-5f2a9c';
let testServer;
let db;
let baseUrl;
let stub;
let stubMode = 'ok';
const stubRequests = [];

before(async () => {
  testServer = await startTestServer();
  ({ db, baseUrl } = testServer);

  // Stand-in for api.themoviedb.org. stubMode picks how it misbehaves.
  stub = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    stubRequests.push({ path: url.pathname, apiKey: url.searchParams.get('api_key'), auth: req.headers.authorization });
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/genre/movie/list') return json(200, { genres: [{ id: 878, name: 'Science Fiction' }, { id: 18, name: 'Drama' }] });
    if (url.pathname !== '/search/movie') return json(404, {});
    if (stubMode === 'rate-limited') return json(429, { status_message: 'Too many requests' });
    if (stubMode === 'server-error') return json(500, { status_message: 'Internal error' });
    if (stubMode === 'bad-key') return json(401, { status_message: 'Invalid API key' });
    if (stubMode === 'not-json') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>Service unavailable</html>');
    }
    if (stubMode === 'no-results-array') return json(200, { page: 1 });
    if (stubMode === 'empty') return json(200, { page: 1, results: [] });
    return json(200, {
      page: 1,
      results: [
        { id: 329865, title: 'Arrival', release_date: '2016-11-10', genre_ids: [878, 18], overview: 'Linguist meets aliens.', poster_path: '/x2FJsf1ElAgr63Y3PNPtJrcmpoe.jpg' },
        { id: 12, title: 'No Date Movie', release_date: '', genre_ids: [], overview: '', poster_path: '../../etc/passwd' },
        { title: 'Missing id, should be dropped' },
        null,
      ],
    });
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  process.env.TMDB_API_BASE = `http://127.0.0.1:${stub.address().port}`;
});

after(async () => {
  stub?.close();
  await testServer?.stop();
});

beforeEach(() => {
  delete process.env.TMDB_API_KEY;
  stubMode = 'ok';
  tmdb.clearCache();
});

let userCounter = 0;
function createClient() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
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
      return { status: res.status, data, headers: res.headers };
    },
  };
}

async function newUser(password = 'password123') {
  const client = createClient();
  const username = `user_${++userCounter}`;
  const res = await client.request('POST', '/api/auth/register', { username, password });
  assert.equal(res.status, 201);
  return { client, username, password };
}

// ---------- Logging ----------

test('logger uses a consistent format, scrubs secrets, and includes stacks for errors', () => {
  const mark = logs.length;
  const log = createLogger('Example');
  log.warn('Something odd happened', { movieId: 4, password: 'hunter22', apiKey: 'abc', nested: { sessionId: 'xyz', token: 't' } });
  log.error('It broke', { error: new Error('boom') });

  const output = logsSince(mark);
  assert.match(output, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[WARN\] \[Example\] Something odd happened \{"movieId":4/m);
  assert.match(output, /\[ERROR\] \[Example\] It broke \{"error":\{"message":"boom"\}\}\nError: boom\n\s+at /);
  for (const secret of ['hunter22', '"abc"', 'xyz', '"t"']) assert.ok(!output.includes(secret), `leaked ${secret}`);
  assert.deepEqual(scrub({ password_hash: '$2b$10$x', title: 'Heat' }), { password_hash: '[redacted]', title: 'Heat' });
});

test('auth logs explain failures without leaking passwords, hashes, cookies, or the session secret', async () => {
  const mark = logs.length;
  const { client, username, password } = await newUser('Sup3r-Secret-Pass!');
  const sid = decodeURIComponent(client.cookie.split('=')[1]);
  assert.ok(sid.length > 10);
  const bad = await createClient().request('POST', '/api/auth/login', { username, password: 'Wrong-Pass-987' });
  assert.equal(bad.status, 401);
  await createClient().request('POST', '/api/auth/register', { username, password: 'another-pass-1' });
  await client.request('POST', '/api/auth/logout');

  const output = logsSince(mark);
  const hash = (await db.collection('users').findOne({ username_lower: username.toLowerCase() })).password_hash;
  // The cookie value is "s:<session id>.<signature>"; neither part may appear in the logs.
  const sessionId = sid.slice(2).split('.')[0];
  for (const secret of [password, 'Wrong-Pass-987', 'another-pass-1', hash, 'test-secret-do-not-log', sid, sessionId]) {
    assert.ok(!output.includes(secret), `log output contains a secret: ${secret.slice(0, 6)}…`);
  }

  // The rejected login is a WARN with enough context to find the request.
  const requestId = bad.headers.get('x-request-id');
  assert.match(requestId, /^[0-9a-f]{8}$/);
  const line = output.split('\n').find((l) => l.includes('[WARN] [Auth] Login rejected: invalid credentials'));
  assert.ok(line, 'expected a login-rejected warning');
  assert.ok(line.includes(requestId) && line.includes('wrong password'));
  assert.match(output, /\[WARN\] \[Auth\] Registration rejected: username taken/);
  assert.match(output, /\[INFO\] \[Auth\] User logged out; session ended/);
});

test('validation failures are warnings, not errors, and unexpected errors log a stack but return a generic message', async () => {
  const { client } = await newUser();
  let mark = logs.length;
  const invalid = await client.request('POST', '/api/movies', { title: '' });
  assert.equal(invalid.status, 400);
  assert.match(logsSince(mark), /\[WARN\] \[Movies\] Validation failed: add movie \{"reason":"Title is required\."/);
  assert.ok(!logsSince(mark).includes('[ERROR]'));

  // Simulate a bug deep inside a route.
  process.env.TMDB_API_KEY = TMDB_KEY;
  const original = tmdb.searchMovies;
  tmdb.searchMovies = async () => { throw new TypeError('Cannot read properties of undefined (simulated)'); };
  mark = logs.length;
  try {
    const res = await client.request('GET', '/api/discover/search?q=heat');
    assert.equal(res.status, 500);
    assert.deepEqual(res.data, { error: 'Something went wrong on the server. Please try again.' });
    const output = logsSince(mark);
    assert.match(output, /\[ERROR\] \[App\] Unexpected error while handling request .*"route":"GET \/api\/discover\/search\?q=heat".*"operation":"search movies"/);
    assert.match(output, /TypeError: Cannot read properties of undefined \(simulated\)\n\s+at /);
  } finally {
    tmdb.searchMovies = original;
  }
});

// ---------- Recoverable deletion ----------

test('deleting moves a movie to Recently Deleted with its details, and restoring brings it back', async () => {
  const { client } = await newUser();
  const { data } = await client.request('POST', '/api/movies', {
    title: 'Arrival', year: 2016, genre: 'Sci-Fi', tmdb_id: 329865, poster_path: '/x2FJsf1ElAgr63Y3PNPtJrcmpoe.jpg', overview: 'Aliens.',
  });
  const original = data.movie;
  await client.request('PATCH', `/api/movies/${original.id}`, { watched: true });

  const del = await client.request('DELETE', `/api/movies/${original.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.message, 'Moved to Recently Deleted.');
  assert.equal((await client.request('GET', '/api/movies')).data.movies.length, 0);

  const trash = (await client.request('GET', '/api/movies/deleted')).data.movies;
  assert.equal(trash.length, 1);
  const deleted = trash[0];
  for (const field of ['title', 'year', 'genre', 'tmdb_id', 'poster_path', 'overview', 'created_at']) {
    assert.equal(deleted[field], original[field], `${field} should be preserved`);
  }
  assert.equal(deleted.watched, true);
  assert.ok(deleted.deleted_at);

  // Already in the trash: a second normal delete and edits don't apply.
  assert.equal((await client.request('DELETE', `/api/movies/${original.id}`)).status, 404);
  assert.equal((await client.request('PATCH', `/api/movies/${original.id}`, { watched: false })).status, 404);

  const restored = await client.request('POST', `/api/movies/${original.id}/restore`);
  assert.equal(restored.status, 200);
  assert.equal(restored.data.movie.deleted_at, null);
  assert.equal(restored.data.movie.watched, true);
  assert.equal(restored.data.movie.created_at, original.created_at);
  assert.equal((await client.request('GET', '/api/movies')).data.movies.length, 1);
  assert.equal((await client.request('GET', '/api/movies/deleted')).data.movies.length, 0);

  // Restoring something that isn't in the trash is a 404, not a duplicate.
  assert.equal((await client.request('POST', `/api/movies/${original.id}/restore`)).status, 404);
});

test('permanent delete only works from Recently Deleted and removes the movie for good', async () => {
  const { client } = await newUser();
  const { data } = await client.request('POST', '/api/movies', { title: 'Heat', year: 1995 });
  const id = data.movie.id;

  // Can't skip the trash.
  assert.equal((await client.request('DELETE', `/api/movies/${id}/permanent`)).status, 404);
  assert.equal((await client.request('GET', '/api/movies')).data.movies.length, 1);

  await client.request('DELETE', `/api/movies/${id}`);
  const purge = await client.request('DELETE', `/api/movies/${id}/permanent`);
  assert.equal(purge.status, 200);
  assert.equal((await client.request('GET', '/api/movies/deleted')).data.movies.length, 0);
  assert.equal((await client.request('POST', `/api/movies/${id}/restore`)).status, 404);
  assert.equal(await db.collection('movies').countDocuments({ _id: new ObjectId(id) }), 0);

  assert.equal((await client.request('DELETE', '/api/movies/abc/permanent')).status, 400);
  assert.equal((await client.request('POST', '/api/movies/0/restore')).status, 400);
});

test('restoring never creates a duplicate active movie', async () => {
  const { client } = await newUser();
  const first = (await client.request('POST', '/api/movies', { title: 'Moonlight', year: 2016 })).data.movie;
  await client.request('DELETE', `/api/movies/${first.id}`);
  // Added again while the old copy sits in the trash.
  const second = (await client.request('POST', '/api/movies', { title: 'moonlight', year: 2016 })).data.movie;
  assert.ok(second);

  const conflict = await client.request('POST', `/api/movies/${first.id}/restore`);
  assert.equal(conflict.status, 409);
  assert.match(conflict.data.error, /already on your watchlist/);
  assert.equal((await client.request('GET', '/api/movies')).data.movies.length, 1);
  assert.equal((await client.request('GET', '/api/movies/deleted')).data.movies.length, 1, 'the trashed copy stays put');

  // Restore all: two trashed copies of the same movie, plus one that conflicts with an active movie.
  const { client: other } = await newUser();
  const a1 = (await other.request('POST', '/api/movies', { title: 'Heat', year: 1995 })).data.movie;
  await other.request('DELETE', `/api/movies/${a1.id}`);
  const a2 = (await other.request('POST', '/api/movies', { title: 'Heat', year: 1995 })).data.movie;
  await other.request('DELETE', `/api/movies/${a2.id}`);
  const b = (await other.request('POST', '/api/movies', { title: 'Get Out', year: 2017 })).data.movie;
  await other.request('DELETE', `/api/movies/${b.id}`);
  await other.request('POST', '/api/movies', { title: 'Get Out', year: 2017 });

  const all = await other.request('POST', '/api/movies/deleted/restore-all');
  assert.equal(all.status, 200);
  assert.equal(all.data.restored.length, 1);
  assert.equal(all.data.restored[0].title, 'Heat');
  assert.equal(all.data.skipped.length, 2);
  const active = (await other.request('GET', '/api/movies')).data.movies;
  assert.equal(active.filter((m) => m.title === 'Heat').length, 1);
  assert.equal(active.filter((m) => m.title === 'Get Out').length, 1);
});

test('adding the same movie twice is rejected, by title and year or by TMDB id', async () => {
  const { client } = await newUser();
  assert.equal((await client.request('POST', '/api/movies', { title: 'Past Lives', year: 2023 })).status, 201);
  const dup = await client.request('POST', '/api/movies', { title: '  PAST LIVES ', year: 2023 });
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /already on your watchlist/);
  // A different year is a different movie (remakes exist).
  assert.equal((await client.request('POST', '/api/movies', { title: 'Past Lives', year: 1999 })).status, 201);

  assert.equal((await client.request('POST', '/api/movies', { title: 'Dune', year: 2021, tmdb_id: 438631 })).status, 201);
  assert.equal((await client.request('POST', '/api/movies', { title: 'Dune: Part One', year: 2021, tmdb_id: 438631 })).status, 409);

  for (const body of [
    { title: 'X', tmdb_id: -1 },
    { title: 'X', tmdb_id: '12' },
    { title: 'X', poster_path: 'https://evil.example/x.jpg' },
    { title: 'X', poster_path: '/../../secret.jpg' },
    { title: 'X', overview: 'o'.repeat(1001) },
  ]) {
    assert.equal((await client.request('POST', '/api/movies', body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
});

test("one user cannot see, restore, or permanently delete another user's deleted movies", async () => {
  const { client: owner } = await newUser();
  const { client: intruder } = await newUser();
  const { data } = await owner.request('POST', '/api/movies', { title: 'Private Movie' });
  const id = data.movie.id;
  await owner.request('DELETE', `/api/movies/${id}`);

  assert.equal((await intruder.request('GET', '/api/movies/deleted')).data.movies.length, 0);
  assert.equal((await intruder.request('POST', `/api/movies/${id}/restore`)).status, 404);
  assert.equal((await intruder.request('DELETE', `/api/movies/${id}/permanent`)).status, 404);
  const restoreAll = await intruder.request('POST', '/api/movies/deleted/restore-all');
  assert.equal(restoreAll.data.restored.length, 0);

  const ownerTrash = (await owner.request('GET', '/api/movies/deleted')).data.movies;
  assert.equal(ownerTrash.length, 1);
  assert.equal(ownerTrash[0].title, 'Private Movie');

  const anonymous = createClient();
  assert.equal((await anonymous.request('GET', '/api/movies/deleted')).status, 401);
  assert.equal((await anonymous.request('POST', `/api/movies/${id}/restore`)).status, 401);
  assert.equal((await anonymous.request('DELETE', `/api/movies/${id}/permanent`)).status, 401);
  assert.equal((await anonymous.request('POST', '/api/movies/deleted/restore-all')).status, 401);
});

// ---------- Theme settings ----------

test('theme defaults to After Hours, accepts each theme, and persists across logins', async () => {
  const { client, username, password } = await newUser();
  assert.deepEqual((await client.request('GET', '/api/settings')).data, { settings: { theme: 'after-hours' } });

  for (const theme of ['midnight', 'daydream', 'after-hours', 'midnight']) {
    const res = await client.request('PATCH', '/api/settings', { theme });
    assert.equal(res.status, 200);
    assert.equal(res.data.settings.theme, theme);
    assert.equal((await client.request('GET', '/api/settings')).data.settings.theme, theme);
  }

  await client.request('POST', '/api/auth/logout');
  assert.equal((await client.request('GET', '/api/settings')).status, 401);
  const again = createClient();
  await again.request('POST', '/api/auth/login', { username, password });
  assert.equal((await again.request('GET', '/api/settings')).data.settings.theme, 'midnight');
});

test('theme preferences are per user, and invalid values are rejected', async () => {
  const { client: alice } = await newUser();
  const { client: bob } = await newUser();
  await alice.request('PATCH', '/api/settings', { theme: 'daydream' });
  assert.equal((await bob.request('GET', '/api/settings')).data.settings.theme, 'after-hours');
  await bob.request('PATCH', '/api/settings', { theme: 'midnight' });
  assert.equal((await alice.request('GET', '/api/settings')).data.settings.theme, 'daydream');

  for (const body of [{ theme: 'neon' }, { theme: 'MIDNIGHT' }, { theme: 3 }, { theme: null }, {}, { theme: ['daydream'] }]) {
    assert.equal((await alice.request('PATCH', '/api/settings', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await alice.request('GET', '/api/settings')).data.settings.theme, 'daydream');
  // Settings never expose account internals.
  assert.deepEqual(Object.keys((await alice.request('GET', '/api/settings')).data.settings), ['theme']);
  assert.equal((await createClient().request('PATCH', '/api/settings', { theme: 'midnight' })).status, 401);
});

// ---------- Movie search ----------

test('without a TMDB key, search reports itself disabled and manual entry still works', async () => {
  const { client } = await newUser();
  assert.deepEqual((await client.request('GET', '/api/discover/status')).data, { enabled: false });
  const search = await client.request('GET', '/api/discover/search?q=arrival');
  assert.equal(search.status, 503);
  assert.equal(search.data.code, 'SEARCH_DISABLED');
  assert.equal((await client.request('POST', '/api/movies', { title: 'Typed By Hand', year: 2001 })).status, 201);
  assert.equal(stubRequests.filter((r) => r.path === '/search/movie').length, 0);
});

test('search returns cleaned-up results and keeps the API key on the server', async () => {
  process.env.TMDB_API_KEY = TMDB_KEY;
  const { client } = await newUser();
  const mark = logs.length;
  assert.deepEqual((await client.request('GET', '/api/discover/status')).data, { enabled: true });

  const res = await client.request('GET', '/api/discover/search?q=arrival');
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.results, [
    { tmdb_id: 329865, title: 'Arrival', year: 2016, genre: 'Science Fiction', overview: 'Linguist meets aliens.', poster_path: '/x2FJsf1ElAgr63Y3PNPtJrcmpoe.jpg' },
    { tmdb_id: 12, title: 'No Date Movie', year: null, genre: null, overview: null, poster_path: null },
  ]);

  const searchCall = stubRequests.findLast((r) => r.path === '/search/movie');
  assert.equal(searchCall.apiKey, TMDB_KEY, 'key is sent to TMDB');
  assert.ok(!JSON.stringify(res.data).includes(TMDB_KEY), 'key is not sent to the browser');
  assert.ok(!logsSince(mark).includes(TMDB_KEY), 'key is not logged');

  // A result can be added straight to the watchlist.
  const r = res.data.results[0];
  const added = await client.request('POST', '/api/movies', r);
  assert.equal(added.status, 201);
  assert.equal(added.data.movie.tmdb_id, 329865);
  assert.equal(added.data.movie.poster_path, r.poster_path);

  // Repeat searches come from the cache instead of hitting TMDB again.
  const before = stubRequests.length;
  await client.request('GET', '/api/discover/search?q=Arrival');
  assert.equal(stubRequests.length, before);
});

test('a read access token is sent as a Bearer header instead of a query parameter', async () => {
  process.env.TMDB_API_KEY = 'eyJhbGciOiJIUzI1NiJ9.test-token';
  const { client } = await newUser();
  assert.equal((await client.request('GET', '/api/discover/search?q=bearer')).status, 200);
  const call = stubRequests.findLast((r) => r.path === '/search/movie');
  assert.equal(call.apiKey, null);
  assert.equal(call.auth, 'Bearer eyJhbGciOiJIUzI1NiJ9.test-token');
});

test('search handles empty results, TMDB failures, and bad queries gracefully', async () => {
  process.env.TMDB_API_KEY = TMDB_KEY;
  const { client } = await newUser();

  stubMode = 'empty';
  const empty = await client.request('GET', '/api/discover/search?q=zzzzqqq');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.results, []);

  const cases = [
    ['rate-limited', 503, /busy/, 'WARN'],
    ['server-error', 502, /isn't working/, 'ERROR'],
    ['bad-key', 502, /isn't working/, 'ERROR'],
    ['not-json', 502, /unexpected/, 'ERROR'],
    ['no-results-array', 502, /unexpected/, 'ERROR'],
  ];
  for (const [mode, status, message, level] of cases) {
    stubMode = mode;
    tmdb.clearCache();
    const mark = logs.length;
    const res = await client.request('GET', `/api/discover/search?q=${mode}`);
    assert.equal(res.status, status, mode);
    assert.match(res.data.error, message, mode);
    assert.equal(res.data.code, 'SEARCH_FAILED');
    assert.match(logsSince(mark), new RegExp(`\\[${level}\\] \\[Discover\\] Search failed`), mode);
    assert.ok(!JSON.stringify(res.data).includes(TMDB_KEY));
  }

  // TMDB being down never affects the watchlist itself.
  assert.equal((await client.request('POST', '/api/movies', { title: 'Still Works' })).status, 201);

  assert.equal((await client.request('GET', '/api/discover/search?q=')).status, 400);
  assert.equal((await client.request('GET', '/api/discover/search')).status, 400);
  assert.equal((await client.request('GET', `/api/discover/search?q=${'a'.repeat(101)}`)).status, 400);
  assert.equal((await createClient().request('GET', '/api/discover/search?q=heat')).status, 401);
  assert.equal((await createClient().request('GET', '/api/discover/status')).status, 401);
});
