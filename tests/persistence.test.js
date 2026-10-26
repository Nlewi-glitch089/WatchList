// Database upgrades and restarts, using real database files in a temp folder and the real
// server.js in a child process. Your data/movies.db is never touched.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'movie-night-test-'));
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const childEnv = (dbPath, extra = {}) => ({
  ...process.env,
  DB_PATH: dbPath,
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  SESSION_SECRET: 'persistence-test-secret',
  TMDB_API_KEY: '',
  ...extra,
});

// Opens the database module in a separate process (like a server start) and returns its log output.
function openDatabaseInChild(dbPath) {
  const result = spawnSync(process.execPath, ['-e', "require('./database/database').close()"], {
    cwd: ROOT,
    env: childEnv(dbPath),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout + result.stderr;
}

test('an old database is upgraded in place without losing users or movies', () => {
  const dbPath = path.join(tempDir, 'legacy.db');
  // The schema as it was before soft delete, themes, and TMDB fields existed.
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE movies (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, year INTEGER, genre TEXT, watched INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL);
    INSERT INTO users (username, password_hash) VALUES ('olduser', '$2b$10$abcdefghijklmnopqrstuv');
    INSERT INTO movies (user_id, title, year, genre, watched, created_at) VALUES
      (1, 'Heat', 1995, 'Thriller', 1, '2024-01-02 03:04:05'),
      (1, 'Paddington 2', 2017, NULL, 0, '2024-02-03 04:05:06');
  `);
  legacy.close();

  const firstRun = openDatabaseInChild(dbPath);
  assert.match(firstRun, /\[INFO\] \[Database\] Migration applied: added movies\.deleted_at/);
  assert.match(firstRun, /\[INFO\] \[Database\] Migration applied: added users\.theme/);

  const upgraded = new DatabaseSync(dbPath);
  const columns = upgraded.prepare('PRAGMA table_info(movies)').all().map((c) => c.name);
  for (const column of ['deleted_at', 'tmdb_id', 'poster_path', 'overview']) assert.ok(columns.includes(column), column);
  assert.deepEqual(
    upgraded.prepare('SELECT title, year, genre, watched, created_at, deleted_at FROM movies ORDER BY id').all().map((r) => ({ ...r })),
    [
      { title: 'Heat', year: 1995, genre: 'Thriller', watched: 1, created_at: '2024-01-02 03:04:05', deleted_at: null },
      { title: 'Paddington 2', year: 2017, genre: null, watched: 0, created_at: '2024-02-03 04:05:06', deleted_at: null },
    ]
  );
  const user = upgraded.prepare('SELECT username, password_hash, theme FROM users').get();
  assert.equal(user.username, 'olduser');
  assert.equal(user.password_hash, '$2b$10$abcdefghijklmnopqrstuv');
  assert.equal(user.theme, 'after-hours');
  upgraded.close();

  // Running again is a no-op.
  const secondRun = openDatabaseInChild(dbPath);
  assert.doesNotMatch(secondRun, /Migration applied/);
});

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Starts server.js and resolves once it logs that it's listening.
async function startServer(dbPath, port) {
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: childEnv(dbPath, { PORT: String(port) }) });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10000);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes('running at')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`server exited early (${code}):\n${output}`)));
  });
  return child;
}

async function stopServer(child) {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}

test('sessions, deleted movies, and themes survive a server restart', async () => {
  const dbPath = path.join(tempDir, 'restart.db');
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

  let server = await startServer(dbPath, port);
  let movieId;
  try {
    assert.equal((await call('POST', '/api/auth/register', { username: 'restart_user', password: 'password123' })).status, 201);
    movieId = (await call('POST', '/api/movies', { title: 'Spirited Away', year: 2001, genre: 'Animation' })).data.movie.id;
    await call('POST', '/api/movies', { title: 'Heat', year: 1995 });
    assert.equal((await call('DELETE', `/api/movies/${movieId}`)).status, 200);
    assert.equal((await call('PATCH', '/api/settings', { theme: 'daydream' })).status, 200);
  } finally {
    await stopServer(server);
  }

  server = await startServer(dbPath, port);
  try {
    // Same cookie, new process: still logged in.
    assert.equal((await call('GET', '/api/auth/me')).data.user.username, 'restart_user');
    assert.deepEqual((await call('GET', '/api/movies')).data.movies.map((m) => m.title), ['Heat']);
    const trash = (await call('GET', '/api/movies/deleted')).data.movies;
    assert.equal(trash.length, 1);
    assert.equal(trash[0].title, 'Spirited Away');
    assert.equal(trash[0].genre, 'Animation');
    assert.equal((await call('GET', '/api/settings')).data.settings.theme, 'daydream');

    assert.equal((await call('POST', `/api/movies/${movieId}/restore`)).status, 200);
    assert.equal((await call('GET', '/api/movies')).data.movies.length, 2);
  } finally {
    await stopServer(server);
  }
});
