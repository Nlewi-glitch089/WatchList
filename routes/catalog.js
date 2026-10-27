// The shared Discover catalog. Read-only: users add catalog movies to their own watchlist
// through POST /api/movies with a catalog_id (see routes/movies.js).
const express = require('express');
const { requireAuth } = require('../middleware/auth');

// One shape for the browser. TMDB details (after `npm run catalog:refresh`) win over the
// Wikipedia/Commons ones, and each description says where it came from.
// The catalog id is the film's Wikidata id, e.g. "Q151895".
function toCatalogJson(doc) {
  const fromTmdb = Boolean(doc.tmdb_overview);
  return {
    id: doc._id,
    title: doc.title,
    year: doc.year,
    genre: doc.genre,
    genres: doc.genres || [],
    directors: doc.directors || [],
    runtime: doc.runtime,
    overview: doc.tmdb_overview || doc.overview,
    overview_source: fromTmdb
      ? { name: 'TMDB', url: `https://www.themoviedb.org/movie/${doc.tmdb_id}` }
      : doc.overview_source && { name: 'Wikipedia', url: doc.overview_source },
    poster_path: doc.tmdb_poster_path || null,
    poster_url: doc.tmdb_poster_path ? null : doc.poster_url,
    poster_credit: doc.tmdb_poster_path ? 'TMDB' : doc.poster_credit,
    poster_page: doc.tmdb_poster_path ? null : doc.poster_page,
    popularity: doc.popularity,
    tags: doc.tags || [],
    tmdb_id: doc.tmdb_id,
    imdb_id: doc.imdb_id,
  };
}

function createCatalogRoutes(db) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    res.locals.operation = 'load catalog';
    const [movies, info] = await Promise.all([
      // Sorted by title ignoring case.
      db.collection('catalog_movies').find().sort({ title: 1 }).collation({ locale: 'en', strength: 2 }).toArray(),
      db.collection('app_meta').findOne({ _id: 'catalog_info' }),
    ]);
    res.json({ movies: movies.map(toCatalogJson), info: info ? info.value : null });
  });

  return router;
}

module.exports = createCatalogRoutes;
module.exports.toCatalogJson = toCatalogJson;
