// Tests for the shared movie catalog: seeding, browsing, adding catalog movies to a watchlist,
// the starter pack, and the optional TMDB refresh. Uses a throwaway MongoDB database and a small
// fixture catalog; the real database/catalog.json is checked separately at the bottom.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const fixtureFile = path.join(__dirname, 'fixtures', 'catalog.sample.json');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'movie-night-catalog-'));
const catalogFile = path.join(tempDir, 'catalog.json');
fs.copyFileSync(fixtureFile, catalogFile);

process.env.SESSION_SECRET = 'catalog-test-secret';
process.env.NODE_ENV = 'test';
process.env.CATALOG_PATH = catalogFile;
delete process.env.TMDB_API_KEY;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers/testServer');
const { seedCatalog } = require('../database/seedCatalog');
const tmdb = require('../lib/tmdb');

let testServer;
let db;
let baseUrl;
before(async () => {
  testServer = await startTestServer();
  ({ db, baseUrl } = testServer);
});
after(async () => {
  await testServer?.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

let counter = 0;
async function newUser() {
  let cookie = '';
  const request = async (method, urlPath, body) => {
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: { ...(cookie && { Cookie: cookie }), ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie();
    if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, data: await res.json() };
  };
  const res = await request('POST', '/api/auth/register', { username: `catalog_user_${++counter}`, password: 'password123' });
  assert.equal(res.status, 201);
  return { request };
}

const catalog = () => db.collection('catalog_movies');
const catalogCount = () => catalog().countDocuments();
const catalogRow = (title) => catalog().findOne({ title });
const allCatalogRows = () => catalog().find().sort({ _id: 1 }).toArray();

test('the catalog is seeded on startup, skipping invalid entries', async () => {
  assert.equal(await catalogCount(), 4, 'the entry with an empty title is skipped');
  const arrival = await catalogRow('Arrival');
  assert.equal(arrival._id, 'Q20022969', 'the Wikidata id is the catalog id');
  assert.equal(arrival.year, 2016);
  assert.equal(arrival.tmdb_id, 329865);
  assert.deepEqual(arrival.genres, ['Sci-Fi', 'Drama']);
});

test('seeding again never creates duplicates, and updates documents in place', async () => {
  const before = (await allCatalogRows()).map((d) => d._id);

  // Unchanged file: nothing to do.
  assert.equal((await seedCatalog(db)).changed, false);
  // Forced: every document is updated, none inserted.
  const forced = await seedCatalog(db, { force: true });
  assert.equal(forced.inserted, 0);
  assert.equal(forced.updated, 4);
  assert.equal(await catalogCount(), 4);

  // A TMDB refresh result must survive re-seeding.
  await catalog().updateOne({ title: 'Casablanca' }, { $set: { tmdb_overview: 'From TMDB', tmdb_poster_path: '/abc.jpg' } });

  // An edited file: one title fixed, one movie added.
  const data = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  const arrivalId = data.movies[0].wikidata_id;
  data.movies[0].title = 'Arrival (edited)';
  data.movies.push({ wikidata_id: 'Q25188', tmdb_id: 27205, title: 'Inception', year: 2010, genre: 'Sci-Fi', genres: ['Sci-Fi'], tags: [] });
  fs.writeFileSync(catalogFile, JSON.stringify(data));
  const changed = await seedCatalog(db);
  assert.equal(changed.inserted, 1);
  assert.equal(changed.updated, 4);
  assert.equal(await catalogCount(), 5);
  assert.equal((await seedCatalog(db, { force: true })).inserted, 0);
  assert.equal(await catalogCount(), 5);

  const after = (await allCatalogRows()).map((d) => d._id);
  for (const id of before) assert.ok(after.includes(id), 'existing documents keep their ids');
  assert.equal((await catalogRow('Arrival (edited)'))._id, arrivalId);
  assert.equal((await catalogRow('Casablanca')).tmdb_overview, 'From TMDB');

  // Put the fixture back for the remaining tests.
  data.movies[0].title = 'Arrival';
  fs.writeFileSync(catalogFile, JSON.stringify(data));
  await seedCatalog(db);
});

test('a catalog entry that reuses another movie\'s TMDB id is skipped, not loaded twice', async () => {
  const data = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  data.movies.push({ wikidata_id: 'Q999999001', tmdb_id: 329865, title: 'Arrival Copy', year: 2016, genre: 'Sci-Fi', genres: ['Sci-Fi'], tags: [] });
  fs.writeFileSync(catalogFile, JSON.stringify(data));
  try {
    const result = await seedCatalog(db);
    // The fixture's untitled entry is skipped too.
    assert.deepEqual(result.skipped, ['(untitled)', 'Arrival Copy']);
    assert.equal(await catalogCount(), 5);
    assert.equal(await catalogRow('Arrival Copy'), null);
  } finally {
    data.movies.pop();
    fs.writeFileSync(catalogFile, JSON.stringify(data));
    await seedCatalog(db);
  }
});

test('GET /api/catalog lists the catalog for logged-in users', async () => {
  const anonymous = await fetch(`${baseUrl}/api/catalog`);
  assert.equal(anonymous.status, 401);

  const { request } = await newUser();
  const res = await request('GET', '/api/catalog');
  assert.equal(res.status, 200);
  assert.equal(res.data.movies.length, 5);
  const nosferatu = res.data.movies.find((m) => m.title === 'Nosferatu');
  assert.equal(nosferatu.id, 'Q190525');
  assert.deepEqual(nosferatu.genres, ['Horror']);
  assert.deepEqual(nosferatu.directors, ['F. W. Murnau']);
  assert.match(nosferatu.poster_url, /^https:\/\/upload\.wikimedia\.org\//);
  assert.deepEqual(nosferatu.overview_source, { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Nosferatu' });
  assert.equal(res.data.info.popularity_period.end, '2026-10-25');

  // TMDB details win when a refresh has stored them.
  const casablanca = res.data.movies.find((m) => m.title === 'Casablanca');
  assert.equal(casablanca.overview, 'From TMDB');
  assert.equal(casablanca.poster_path, '/abc.jpg');
  assert.equal(casablanca.overview_source.name, 'TMDB');

  // Sorted by title, ignoring case.
  const titles = res.data.movies.map((m) => m.title);
  assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
});

test('adding a catalog movie copies its real details into the watchlist, once', async () => {
  const { request } = await newUser();
  const nosferatu = await catalogRow('Nosferatu');

  // Details always come from the catalog, never from the request body.
  const added = await request('POST', '/api/movies', { catalog_id: nosferatu._id, title: 'Tampered', year: 1999 });
  assert.equal(added.status, 201);
  const movie = added.data.movie;
  assert.equal(movie.catalog_id, nosferatu._id);
  assert.equal(movie.title, 'Nosferatu');
  assert.equal(movie.year, 1922);
  assert.equal(movie.genre, 'Horror');
  assert.equal(movie.tmdb_id, 653);
  assert.equal(movie.overview, 'Test overview for Nosferatu.');
  assert.equal(movie.poster_url, nosferatu.poster_url);
  assert.equal(movie.watched, false);

  const dup = await request('POST', '/api/movies', { catalog_id: nosferatu._id });
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /already on your watchlist/);
  // Typing the same title and year by hand is also caught.
  assert.equal((await request('POST', '/api/movies', { title: 'nosferatu', year: 1922 })).status, 409);

  assert.equal((await request('POST', '/api/movies', { catalog_id: 'Q999999999' })).status, 404);
  assert.equal((await request('POST', '/api/movies', { catalog_id: 'abc' })).status, 400);
  assert.equal((await request('POST', '/api/movies', { catalog_id: 3 })).status, 400);
  assert.equal((await request('POST', '/api/movies', { catalog_id: { $ne: null } })).status, 400, 'query operators are rejected');
});

test('catalog movies work with watched, delete, and restore, and the catalog itself never changes', async () => {
  const { request } = await newUser();
  const snapshot = await allCatalogRows();
  const spirited = await catalogRow('Spirited Away');

  const { data } = await request('POST', '/api/movies', { catalog_id: spirited._id });
  const id = data.movie.id;
  assert.equal((await request('PATCH', `/api/movies/${id}`, { watched: true })).data.movie.watched, true);
  assert.equal((await request('DELETE', `/api/movies/${id}`)).status, 200);

  const trash = (await request('GET', '/api/movies/deleted')).data.movies;
  assert.equal(trash[0].catalog_id, spirited._id);
  // While it's in the trash, the catalog movie can be added again...
  const again = await request('POST', '/api/movies', { catalog_id: spirited._id });
  assert.equal(again.status, 201);
  // ...but then the trashed copy can't be restored on top of it.
  assert.equal((await request('POST', `/api/movies/${id}/restore`)).status, 409);
  // Clear the new copy out completely; now the original can come back.
  await request('DELETE', `/api/movies/${again.data.movie.id}`);
  await request('DELETE', `/api/movies/${again.data.movie.id}/permanent`);
  const restored = await request('POST', `/api/movies/${id}/restore`);
  assert.equal(restored.status, 200);
  assert.equal(restored.data.movie.watched, true);
  assert.equal(restored.data.movie.catalog_id, spirited._id);
  assert.equal(restored.data.movie.title, 'Spirited Away');
  assert.equal(restored.data.movie.overview, spirited.overview);

  // Nothing users did touched the shared catalog.
  assert.deepEqual(await allCatalogRows(), snapshot);
  assert.equal((await request('GET', '/api/catalog')).data.movies.length, 5);
});

test('the starter pack adds several movies at once and skips ones already on the list', async () => {
  const { request } = await newUser();
  const starterIds = (await catalog().find({ tags: 'starter' }).sort({ _id: 1 }).toArray()).map((d) => d._id);
  assert.equal(starterIds.length, 3);

  await request('POST', '/api/movies', { catalog_id: starterIds[0] });
  const bulk = await request('POST', '/api/movies/bulk', { catalog_ids: [...starterIds, starterIds[1], 'Q999999999'] });
  assert.equal(bulk.status, 201);
  assert.equal(bulk.data.added.length, 2);
  assert.deepEqual(bulk.data.skipped.map((s) => s.reason).sort(), ['already on your watchlist', 'not in the catalog']);
  assert.equal((await request('GET', '/api/movies')).data.movies.length, 3);

  const repeat = await request('POST', '/api/movies/bulk', { catalog_ids: starterIds });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.data.added.length, 0);
  assert.equal((await request('GET', '/api/movies')).data.movies.length, 3, 'no duplicates');

  for (const body of [{}, { catalog_ids: [] }, { catalog_ids: 'all' }, { catalog_ids: [1] }, { catalog_ids: Array.from({ length: 51 }, (_, i) => `Q${i + 1}`) }]) {
    assert.equal((await request('POST', '/api/movies/bulk', body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await fetch(`${baseUrl}/api/movies/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"catalog_ids":["Q1"]}' })).status, 401);
});

test("one user's catalog additions never appear in another user's watchlist", async () => {
  const alice = await newUser();
  const bob = await newUser();
  const ids = (await allCatalogRows()).map((d) => d._id);
  await alice.request('POST', '/api/movies/bulk', { catalog_ids: ids });
  assert.equal((await bob.request('GET', '/api/movies')).data.movies.length, 0);
  const aliceMovie = (await alice.request('GET', '/api/movies')).data.movies[0];
  assert.equal((await bob.request('PATCH', `/api/movies/${aliceMovie.id}`, { watched: true })).status, 404);
  assert.equal((await bob.request('DELETE', `/api/movies/${aliceMovie.id}`)).status, 404);
  // Bob can add the same catalog movie to his own list.
  assert.equal((await bob.request('POST', '/api/movies', { catalog_id: aliceMovie.catalog_id })).status, 201);
});

test('a TMDB search result that is in the catalog gets linked to it', async () => {
  const { request } = await newUser();
  const arrival = await catalogRow('Arrival');
  const added = await request('POST', '/api/movies', { title: 'Arrival', year: 2016, tmdb_id: 329865 });
  assert.equal(added.data.movie.catalog_id, arrival._id);
  assert.equal((await request('POST', '/api/movies', { catalog_id: arrival._id })).status, 409);
});

test('catalog:refresh adds TMDB posters and synopses when a key is set, and does nothing without one', async () => {
  const { refreshCatalog } = require('../scripts/refresh-catalog');
  assert.deepEqual(await refreshCatalog(db, { delayMs: 0 }), { updated: 0, notFound: 0, failed: 0 });

  const stub = http.createServer((req, res) => {
    const id = Number(req.url.match(/^\/movie\/(\d+)/)?.[1]);
    res.setHeader('Content-Type', 'application/json');
    if (id === 653) {
      res.statusCode = 404;
      return res.end('{"status_message":"not found"}');
    }
    res.end(JSON.stringify({ id, poster_path: `/poster${id}.jpg`, overview: `TMDB synopsis ${id}` }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  process.env.TMDB_API_KEY = 'refresh-test-key';
  process.env.TMDB_API_BASE = `http://127.0.0.1:${stub.address().port}`;
  try {
    const counts = await refreshCatalog(db, { delayMs: 0 });
    assert.equal(counts.updated, 4);
    assert.equal(counts.notFound, 1); // Nosferatu (653) isn't in the stub
    assert.equal((await catalogRow('Spirited Away')).tmdb_poster_path, '/poster129.jpg');
    assert.equal((await catalogRow('Spirited Away')).tmdb_overview, 'TMDB synopsis 129');
    assert.equal((await catalogRow('Nosferatu')).tmdb_poster_path, undefined);
  } finally {
    delete process.env.TMDB_API_KEY;
    delete process.env.TMDB_API_BASE;
    tmdb.clearCache();
    stub.close();
  }
});

test('the real database/catalog.json holds exactly 185 real, well-formed films', () => {
  const file = path.join(__dirname, '..', 'database', 'catalog.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const movies = data.movies;
  assert.equal(movies.length, 185);

  const ids = movies.map((m) => m.wikidata_id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate Wikidata ids');
  const tmdbIds = movies.map((m) => m.tmdb_id).filter(Boolean);
  assert.equal(new Set(tmdbIds).size, tmdbIds.length, 'no duplicate TMDB ids');

  for (const m of movies) {
    assert.match(m.wikidata_id, /^Q\d+$/, m.title);
    assert.ok(Number.isInteger(m.tmdb_id) && m.tmdb_id > 0, `${m.title} TMDB id`);
    assert.match(m.imdb_id, /^tt\d+$/, `${m.title} IMDb id`);
    assert.ok(m.title && m.title.trim(), m.wikidata_id);
    assert.ok(Number.isInteger(m.year) && m.year >= 1888 && m.year <= new Date().getFullYear() + 1, `${m.title} year`);
    assert.ok(m.genre && m.genres.includes(m.genre), `${m.title} genre`);
    assert.ok(m.overview && m.overview.length > 40, `${m.title} overview`);
    assert.match(m.overview_source, /^https:\/\/en\.wikipedia\.org\/wiki\//, `${m.title} source`);
    if (m.poster_url) assert.match(m.poster_url, /^https:\/\/(upload|thumb)\.wikimedia\.org\//, `${m.title} poster`);
  }

  // Each film is the one hand-picked in scripts/catalog-picks.js (same order), under its full
  // title. This catches truncated titles like "La" for "La La Land".
  const picks = require('../scripts/catalog-picks');
  assert.equal(picks.length, movies.length);
  // Wikidata's official label differs from the Wikipedia article name for these.
  const officialTitles = { 'Star Wars': 'Star Wars: Episode IV – A New Hope', 'When Harry Met Sally...': 'When Harry Met Sally', 'Se7en': 'Seven' };
  movies.forEach((m, i) => {
    const [articleTitle, expectedYear] = picks[i];
    const pickTitle = articleTitle.replace(/ \([^)]*\)$/, '');
    assert.equal(m.title, officialTitles[pickTitle] || pickTitle, `catalog entry ${i + 1}`);
    assert.ok(Math.abs(m.year - expectedYear) <= 1, `${m.title} year ${m.year}, expected about ${expectedYear}`);
  });

  // Variety: genres, decades, and a starter pack.
  const genres = new Set(movies.flatMap((m) => m.genres));
  for (const genre of ['Horror', 'Sci-Fi', 'Animation', 'Romance', 'Drama', 'Comedy', 'Action', 'Crime', 'Mystery', 'Thriller', 'Fantasy']) {
    assert.ok(movies.filter((m) => m.genres.includes(genre)).length >= 5, `at least 5 ${genre} movies`);
  }
  assert.ok(genres.size >= 12);
  const decades = new Set(movies.map((m) => Math.floor(m.year / 10) * 10));
  assert.ok(decades.size >= 10, `spans ${decades.size} decades`);
  assert.ok(movies.filter((m) => m.tags.includes('starter')).length >= 8);
  assert.ok(movies.filter((m) => m.popularity > 0).length >= movies.length * 0.9, 'most movies have page-view data');
});
