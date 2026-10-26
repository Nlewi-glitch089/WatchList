// The shared Discover catalog. Read-only: users add catalog movies to their own watchlist
// through POST /api/movies with a catalog_id (see routes/movies.js).
const express = require('express');
const db = require('../database/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const CATALOG_COLUMNS = `id, wikidata_id, tmdb_id, imdb_id, title, year, genre, genres, directors, runtime,
  overview, overview_source, poster_url, poster_page, poster_credit, popularity, tags,
  tmdb_poster_path, tmdb_overview`;

const listCatalog = db.prepare(`SELECT ${CATALOG_COLUMNS} FROM catalog_movies ORDER BY title COLLATE NOCASE`);
const getCatalogInfo = db.prepare("SELECT value FROM app_meta WHERE key = 'catalog_info'");

const parseList = (text) => {
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

// One shape for the browser. TMDB details (after `npm run catalog:refresh`) win over the
// Wikipedia/Commons ones, and each description says where it came from.
function toCatalogJson(row) {
  const fromTmdb = Boolean(row.tmdb_overview);
  return {
    id: row.id,
    title: row.title,
    year: row.year,
    genre: row.genre,
    genres: parseList(row.genres),
    directors: parseList(row.directors),
    runtime: row.runtime,
    overview: row.tmdb_overview || row.overview,
    overview_source: fromTmdb
      ? { name: 'TMDB', url: `https://www.themoviedb.org/movie/${row.tmdb_id}` }
      : row.overview_source && { name: 'Wikipedia', url: row.overview_source },
    poster_path: row.tmdb_poster_path,
    poster_url: row.tmdb_poster_path ? null : row.poster_url,
    poster_credit: row.tmdb_poster_path ? 'TMDB' : row.poster_credit,
    poster_page: row.tmdb_poster_path ? null : row.poster_page,
    popularity: row.popularity,
    tags: parseList(row.tags),
    tmdb_id: row.tmdb_id,
    imdb_id: row.imdb_id,
  };
}

router.get('/', (req, res) => {
  res.locals.operation = 'load catalog';
  const info = getCatalogInfo.get();
  res.json({
    movies: listCatalog.all().map(toCatalogJson),
    info: info ? JSON.parse(info.value) : null,
  });
});

module.exports = router;
module.exports.toCatalogJson = toCatalogJson;
