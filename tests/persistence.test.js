// Restarts, start-up, and database failures, using the real server.js (started the same way
// `npm start` starts it) in a child process against a throwaway MongoDB server.
// Your own database is never touched.
process.env.LOG_LEVEL = 'error'; // this process only; the servers it starts log at info

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { connectToDatabase, prepareDatabase } = require('../database/database');

const ROOT = path.join(__dirname, '..');
// The same command as "start" in package.json.
const START_ARGS = require('../package.json').scripts.start.split(' ').slice(1);
const DB_NAME = 'movie_night_persistence_test';

let mongo;
before(async () => {
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
});
after(() => mongo?.stop());

const childEnv = (extra = {}) => ({
  ...process.env,
  MONGODB_URI: mongo.getUri(),
  MONGODB_DB: DB_NAME,
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  SESSION_SECRET: 'persistence-test-secret',
  TMDB_API_KEY: '',
  CATALOG_PATH: '',
  ...extra,
});

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Runs server.js and resolves with its output once it logs that it's listening
// (or, with expectExit, once it exits).
function runServer(env, { expectExit = false } = {}) {
  const child = spawn(process.execPath, START_ARGS, { cwd: ROOT, env });
  let output = '';
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server timed out:\n${output}`)), 30000);
    const onData = (chunk) => {
      output += chunk;
      if (!expectExit && output.includes('running at')) {
        clearTimeout(timer);
        resolve({ child, output });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (expectExit) resolve({ code, output });
      else reject(new Error(`server exited early (${code}):\n${output}`));
    });
  });
  return done;
}

async function stopServer(child) {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}

test('accounts, sessions, watch status, deleted movies, and themes survive a server restart', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (method, urlPath, body) => {
    const res = await fetch(base + urlPath, {
      method,
      headers: { ...(cookie && { Cookie: cookie }), ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie();
    if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, data: await res.json() };
  };

  let { child, output } = await runServer(childEnv({ PORT: String(port) }));
  assert.match(output, /\[INFO\] \[Catalog\] Movie catalog loaded .*"inserted":185/);
  assert.match(output, new RegExp(`\\[INFO\\] \\[Server\\] Connected to MongoDB .*"database":"${DB_NAME}"`));
  let movieId;
  try {
    assert.equal((await call('POST', '/api/auth/register', { username: 'restart_user', password: 'password123' })).status, 201);
    movieId = (await call('POST', '/api/movies', { title: 'Spirited Away', year: 2001, genre: 'Animation' })).data.movie.id;
    assert.equal((await call('PATCH', `/api/movies/${movieId}`, { watched: true })).status, 200);
    const heat = (await call('POST', '/api/movies', { title: 'Heat', year: 1995 })).data.movie;
    assert.equal((await call('PATCH', `/api/movies/${heat.id}`, { watched: true })).status, 200);
    assert.equal((await call('DELETE', `/api/movies/${movieId}`)).status, 200);
    assert.equal((await call('PATCH', '/api/settings', { theme: 'daydream' })).status, 200);
  } finally {
    await stopServer(child);
  }

  ({ child, output } = await runServer(childEnv({ PORT: String(port) })));
  try {
    // An unchanged catalog file isn't loaded again.
    assert.doesNotMatch(output, /Movie catalog loaded/);
    // Same cookie, new process: still logged in.
    assert.equal((await call('GET', '/api/auth/me')).data.user.username, 'restart_user');
    const active = (await call('GET', '/api/movies')).data.movies;
    assert.deepEqual(active.map((m) => [m.title, m.watched]), [['Heat', true]]);
    const trash = (await call('GET', '/api/movies/deleted')).data.movies;
    assert.equal(trash.length, 1);
    assert.equal(trash[0].title, 'Spirited Away');
    assert.equal(trash[0].genre, 'Animation');
    assert.equal(trash[0].watched, true);
    assert.equal((await call('GET', '/api/settings')).data.settings.theme, 'daydream');

    const restored = await call('POST', `/api/movies/${movieId}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.data.movie.watched, true, 'watch status comes back with the movie');
    assert.equal((await call('GET', '/api/movies')).data.movies.length, 2);
  } finally {
    await stopServer(child);
  }

  // Everything lives in MongoDB: check the documents directly.
  const { client, db } = await connectToDatabase(mongo.getUri(), DB_NAME);
  try {
    const user = await db.collection('users').findOne({ username_lower: 'restart_user' });
    assert.match(user.password_hash, /^\$2[aby]\$/);
    assert.equal(await db.collection('movies').countDocuments({ user_id: user._id }), 2);
    assert.ok(await db.collection('sessions').countDocuments() >= 1);
    // The full 185-film catalog was loaded once, with no duplicates from the second start.
    assert.equal(await db.collection('catalog_movies').countDocuments(), 185);
    assert.ok(await db.collection('catalog_movies').findOne({ title: 'La La Land', year: 2016 }));
  } finally {
    await client.close();
  }
});

test('the production start command serves the app with Secure cookies behind an HTTPS proxy', async () => {
  const port = await freePort();
  const { child } = await runServer(childEnv({ PORT: String(port), NODE_ENV: 'production', MONGODB_DB: `${DB_NAME}_prod` }));
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.ok(health.headers.get('strict-transport-security'));

    // Render terminates HTTPS and forwards the request with X-Forwarded-Proto.
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ username: 'prod_user', password: 'password123' }),
    });
    assert.equal(res.status, 201);
    assert.match(res.headers.getSetCookie().join(';'), /Secure/i);
  } finally {
    await stopServer(child);
  }
});

test('the server refuses to start in production without SESSION_SECRET', async () => {
  const { code, output } = await runServer(childEnv({ NODE_ENV: 'production', SESSION_SECRET: '', PORT: String(await freePort()) }), { expectExit: true });
  assert.equal(code, 1);
  assert.match(output, /SESSION_SECRET must be set when NODE_ENV=production/);
});

test('the server exits with a clear error when MONGODB_URI is missing or unusable', async () => {
  const missing = await runServer(childEnv({ MONGODB_URI: '' }), { expectExit: true });
  assert.equal(missing.code, 1);
  assert.match(missing.output, /\[ERROR\] \[Server\] MONGODB_URI is not set/);
  assert.doesNotMatch(missing.output, /running at/);

  const invalid = await runServer(childEnv({ MONGODB_URI: 'postgres://moviebuff:hunter2secret@db.example.com/movies' }), { expectExit: true });
  assert.equal(invalid.code, 1);
  assert.match(invalid.output, /\[ERROR\] \[Server\] Couldn't connect to MongoDB at postgres:\/\/db\.example\.com/);
  assert.ok(!invalid.output.includes('hunter2secret'), 'the password is never logged');
});

test('an unreachable MongoDB server is reported with its address and the reason, without the password', async () => {
  const port = await freePort(); // nothing is listening here
  await assert.rejects(
    connectToDatabase(`mongodb://moviebuff:hunter2secret@127.0.0.1:${port}/`, 'movie_night', { serverSelectionTimeoutMS: 500 }),
    (err) => {
      assert.match(err.message, new RegExp(`^Couldn't connect to MongoDB at mongodb://127\\.0\\.0\\.1:${port} \\(database "movie_night"\\): .+`));
      assert.ok(!err.message.includes('hunter2secret'));
      return true;
    }
  );
});

test('losing the database while running gives 503 health checks and 500 errors, not silent failures', async () => {
  process.env.SESSION_SECRET = 'outage-test-secret';
  const { createApp } = require('../app');
  const outage = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
  const { client, db } = await connectToDatabase(outage.getUri(), 'movie_night_outage', { serverSelectionTimeoutMS: 1000 });
  await prepareDatabase(db);
  const server = createApp(db).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const register = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'outage_user', password: 'password123' }),
    });
    assert.equal(register.status, 201);
    const cookie = register.headers.getSetCookie()[0].split(';')[0];

    await outage.stop();

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 503);
    assert.deepEqual(await health.json(), { status: 'unavailable' });

    const list = await fetch(`${base}/api/movies`, { headers: { Cookie: cookie } });
    assert.equal(list.status, 500);
    assert.deepEqual(await list.json(), { error: 'Something went wrong on the server. Please try again.' });

    const output = logs.join('\n');
    assert.match(output, /\[ERROR\] \[App\] Health check failed: database unavailable/);
    assert.match(output, /\[ERROR\] \[Session\] Could not read session from the database/);
  } finally {
    console.error = originalError;
    server.closeAllConnections();
    server.close();
    await client.close();
  }
});
