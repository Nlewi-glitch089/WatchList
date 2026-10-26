// Loads database/catalog.json into the catalog_movies table.
//
// Safe to run any number of times: each movie is matched on its Wikidata id and updated in
// place, so re-seeding never creates duplicates. Columns filled in by the TMDB refresh
// (tmdb_poster_path, tmdb_overview) are never overwritten here. When the file hasn't changed
// since the last run, nothing is written at all.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLogger } = require('../lib/logger');

const log = createLogger('Catalog');
const DEFAULT_FILE = path.join(__dirname, 'catalog.json');

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const asJsonList = (value) => JSON.stringify(Array.isArray(value) ? value.filter(isNonEmptyString) : []);
const asInt = (value) => (Number.isInteger(value) ? value : null);
const asText = (value) => (isNonEmptyString(value) ? value.trim() : null);
const asHttpsUrl = (value) => (isNonEmptyString(value) && value.startsWith('https://') ? value : null);

function seedCatalog(db, { file = process.env.CATALOG_PATH || DEFAULT_FILE, force = false } = {}) {
  if (!fs.existsSync(file)) {
    log.warn('No catalog file found; Discover will be empty', { file });
    return { changed: false, total: 0 };
  }

  const raw = fs.readFileSync(file, 'utf8');
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  const total = () => db.prepare('SELECT COUNT(*) AS n FROM catalog_movies').get().n;
  const stored = db.prepare("SELECT value FROM app_meta WHERE key = 'catalog_hash'").get();
  if (!force && stored && stored.value === hash && total() > 0) {
    log.debug('Catalog already up to date', { movies: total() });
    return { changed: false, total: total() };
  }

  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.movies)) throw new Error('catalog.json has no "movies" array');

  const exists = db.prepare('SELECT 1 FROM catalog_movies WHERE wikidata_id = ?');
  const upsert = db.prepare(`
    INSERT INTO catalog_movies
      (wikidata_id, tmdb_id, imdb_id, title, year, genre, genres, directors, runtime,
       overview, overview_source, poster_url, poster_page, poster_credit, popularity, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wikidata_id) DO UPDATE SET
      tmdb_id = excluded.tmdb_id, imdb_id = excluded.imdb_id, title = excluded.title,
      year = excluded.year, genre = excluded.genre, genres = excluded.genres,
      directors = excluded.directors, runtime = excluded.runtime, overview = excluded.overview,
      overview_source = excluded.overview_source, poster_url = excluded.poster_url,
      poster_page = excluded.poster_page, poster_credit = excluded.poster_credit,
      popularity = excluded.popularity, tags = excluded.tags, updated_at = datetime('now')
  `);
  const saveMeta = db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  let inserted = 0;
  let updated = 0;
  const skipped = [];

  db.exec('BEGIN');
  try {
    for (const movie of data.movies) {
      if (!movie || !/^Q\d+$/.test(movie.wikidata_id || '') || !isNonEmptyString(movie.title)) {
        skipped.push((movie && movie.title) || '(untitled)');
        continue;
      }
      const isNew = !exists.get(movie.wikidata_id);
      try {
        upsert.run(
          movie.wikidata_id, asInt(movie.tmdb_id), asText(movie.imdb_id), movie.title.trim(), asInt(movie.year),
          asText(movie.genre), asJsonList(movie.genres), asJsonList(movie.directors), asInt(movie.runtime),
          asText(movie.overview), asHttpsUrl(movie.overview_source), asHttpsUrl(movie.poster_url),
          asHttpsUrl(movie.poster_page), asText(movie.poster_credit), asInt(movie.popularity), asJsonList(movie.tags)
        );
        if (isNew) inserted++;
        else updated++;
      } catch (err) {
        // e.g. two entries claiming the same TMDB id: keep the first, report the second.
        if (!/UNIQUE/.test(err.message)) throw err;
        skipped.push(movie.title);
      }
    }
    saveMeta.run('catalog_hash', hash);
    saveMeta.run('catalog_info', JSON.stringify({
      generated_at: data.generated_at || null,
      popularity_period: data.popularity_period || null,
      sources: data.sources || null,
    }));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  if (skipped.length) log.warn('Some catalog entries were skipped', { skipped });
  log.info('Movie catalog loaded', { inserted, updated, total: total() });
  return { changed: true, inserted, updated, skipped, total: total() };
}

module.exports = { seedCatalog };

// `npm run catalog:seed` re-applies the file even if it hasn't changed.
if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const db = require('./database');
  const result = seedCatalog(db, { force: true });
  console.log(`Catalog: ${result.total} movies (${result.inserted || 0} new, ${result.updated || 0} updated).`);
  db.close();
}
