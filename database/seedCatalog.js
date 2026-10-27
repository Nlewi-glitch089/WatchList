// Loads database/catalog.json into the catalog_movies collection.
//
// Safe to run any number of times: each movie's _id is its Wikidata id and is upserted, so
// re-seeding updates in place and never creates duplicates. Fields filled in by the TMDB refresh
// (tmdb_poster_path, tmdb_overview) are never overwritten here. When the file hasn't changed
// since the last run, nothing is written at all.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MongoBulkWriteError } = require('mongodb');
const { createLogger } = require('../lib/logger');

const log = createLogger('Catalog');
const DEFAULT_FILE = path.join(__dirname, 'catalog.json');
const DUPLICATE_KEY = 11000;

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const asList = (value) => (Array.isArray(value) ? value.filter(isNonEmptyString) : []);
const asInt = (value) => (Number.isInteger(value) ? value : null);
const asText = (value) => (isNonEmptyString(value) ? value.trim() : null);
const asHttpsUrl = (value) => (isNonEmptyString(value) && value.startsWith('https://') ? value : null);

async function seedCatalog(db, { file = process.env.CATALOG_PATH || DEFAULT_FILE, force = false } = {}) {
  const catalog = db.collection('catalog_movies');
  const meta = db.collection('app_meta');

  if (!fs.existsSync(file)) {
    log.warn('No catalog file found; Discover will be empty', { file });
    return { changed: false, total: 0 };
  }

  const raw = fs.readFileSync(file, 'utf8');
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  const total = () => catalog.countDocuments();
  const stored = await meta.findOne({ _id: 'catalog_hash' });
  if (!force && stored && stored.value === hash && (await total()) > 0) {
    log.debug('Catalog already up to date', { movies: await total() });
    return { changed: false, total: await total() };
  }

  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.movies)) throw new Error('catalog.json has no "movies" array');

  const skipped = [];
  const valid = [];
  for (const movie of data.movies) {
    if (!movie || !/^Q\d+$/.test(movie.wikidata_id || '') || !isNonEmptyString(movie.title)) {
      skipped.push((movie && movie.title) || '(untitled)');
    } else {
      valid.push(movie);
    }
  }

  const now = new Date();
  const operations = valid.map((movie) => ({
    updateOne: {
      filter: { _id: movie.wikidata_id },
      update: {
        $set: {
          tmdb_id: asInt(movie.tmdb_id), imdb_id: asText(movie.imdb_id), title: movie.title.trim(), year: asInt(movie.year),
          genre: asText(movie.genre), genres: asList(movie.genres), directors: asList(movie.directors), runtime: asInt(movie.runtime),
          overview: asText(movie.overview), overview_source: asHttpsUrl(movie.overview_source), poster_url: asHttpsUrl(movie.poster_url),
          poster_page: asHttpsUrl(movie.poster_page), poster_credit: asText(movie.poster_credit), popularity: asInt(movie.popularity),
          tags: asList(movie.tags), updated_at: now,
        },
      },
      upsert: true,
    },
  }));

  let result = { upsertedCount: 0, matchedCount: 0 };
  if (operations.length) {
    try {
      // Unordered, so one bad entry doesn't stop the rest from loading.
      result = await catalog.bulkWrite(operations, { ordered: false });
    } catch (err) {
      // e.g. two entries claiming the same TMDB id: the first one wins, the other is reported.
      if (!(err instanceof MongoBulkWriteError) || err.writeErrors.some((e) => e.code !== DUPLICATE_KEY)) throw err;
      for (const writeError of err.writeErrors) skipped.push(valid[writeError.index].title);
      result = err.result;
    }
  }

  await meta.bulkWrite([
    { updateOne: { filter: { _id: 'catalog_hash' }, update: { $set: { value: hash } }, upsert: true } },
    {
      updateOne: {
        filter: { _id: 'catalog_info' },
        update: {
          $set: {
            value: {
              generated_at: data.generated_at || null,
              popularity_period: data.popularity_period || null,
              sources: data.sources || null,
            },
          },
        },
        upsert: true,
      },
    },
  ]);

  const counts = { inserted: result.upsertedCount, updated: result.matchedCount };
  if (skipped.length) log.warn('Some catalog entries were skipped', { skipped });
  log.info('Movie catalog loaded', { ...counts, total: await total() });
  return { changed: true, ...counts, skipped, total: await total() };
}

module.exports = { seedCatalog };

// `npm run catalog:seed` re-applies the file even if it hasn't changed.
if (require.main === module) {
  const { connectToDatabase, databaseSettings, ensureIndexes } = require('./database');
  (async () => {
    const { uri, dbName } = databaseSettings();
    const { client, db } = await connectToDatabase(uri, dbName);
    try {
      await ensureIndexes(db);
      const result = await seedCatalog(db, { force: true });
      console.log(`Catalog: ${result.total} movies (${result.inserted || 0} new, ${result.updated || 0} updated).`);
    } finally {
      await client.close();
    }
  })().catch((err) => {
    log.error('Catalog seed failed', { error: err });
    process.exit(1);
  });
}
