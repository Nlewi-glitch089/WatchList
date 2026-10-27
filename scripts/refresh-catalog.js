// Adds official TMDB posters and synopses to the Discover catalog.
//
//   npm run catalog:refresh            (needs MONGODB_URI and TMDB_API_KEY in .env)
//
// Optional: the catalog works without it, using Wikimedia Commons posters where they exist and
// generated posters everywhere else. Results are stored in the database (tmdb_poster_path,
// tmdb_overview), not in catalog.json, and re-seeding the catalog never overwrites them.
// Movies already on someone's watchlist keep the details they were added with.
const tmdb = require('../lib/tmdb');
const { createLogger } = require('../lib/logger');

const log = createLogger('CatalogRefresh');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function refreshCatalog(db, { delayMs = 120 } = {}) {
  if (!tmdb.isEnabled()) {
    log.warn('TMDB_API_KEY is not set, so there is nothing to refresh. The catalog keeps its Wikipedia details.');
    return { updated: 0, notFound: 0, failed: 0 };
  }

  const catalog = db.collection('catalog_movies');
  const movies = await catalog
    .find({ tmdb_id: { $type: 'number' } }, { projection: { title: 1, tmdb_id: 1 } })
    .sort({ _id: 1 })
    .toArray();
  const counts = { updated: 0, notFound: 0, failed: 0 };
  log.info(`Refreshing ${movies.length} catalog movies from TMDB`);

  for (const movie of movies) {
    try {
      const details = await tmdb.getMovieDetails(movie.tmdb_id);
      if (!details) {
        counts.notFound++;
        log.warn('TMDB has no movie with this id', { title: movie.title, tmdbId: movie.tmdb_id });
      } else {
        await catalog.updateOne(
          { _id: movie._id },
          { $set: { tmdb_poster_path: details.poster_path, tmdb_overview: details.overview, tmdb_refreshed_at: new Date() } }
        );
        counts.updated++;
      }
    } catch (err) {
      counts.failed++;
      log.error('Could not refresh movie from TMDB', { title: movie.title, tmdbId: movie.tmdb_id, kind: err.kind, error: err.message });
      // A bad key or rate limit will fail every request, so stop early instead of hammering TMDB.
      if (err.kind === 'auth' || err.kind === 'rate-limited') break;
    }
    await sleep(delayMs);
  }

  log.info('TMDB refresh finished', counts);
  return counts;
}

module.exports = { refreshCatalog };

if (require.main === module) {
  const { connectToDatabase, databaseSettings, prepareDatabase } = require('../database/database');
  (async () => {
    const { uri, dbName } = databaseSettings();
    const { client, db } = await connectToDatabase(uri, dbName);
    try {
      await prepareDatabase(db);
      await refreshCatalog(db);
    } finally {
      await client.close();
    }
  })().catch((err) => {
    log.error('TMDB refresh failed', { error: err });
    process.exit(1);
  });
}
