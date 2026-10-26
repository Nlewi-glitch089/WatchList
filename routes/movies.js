// Watchlist routes. Every query is scoped to the logged-in user's id,
// so one user can never read or change another user's movies.
//
// Deleting is a soft delete: the row stays in the database with deleted_at set, which puts
// the movie in "Recently Deleted". From there it can be restored or permanently deleted.
const express = require('express');
const db = require('../database/database');
const { requireAuth } = require('../middleware/auth');
const { createLogger } = require('../lib/logger');
const { POSTER_PATH_PATTERN } = require('../lib/tmdb');

const router = express.Router();
router.use(requireAuth);
const log = createLogger('Movies');

const MAX_TITLE = 200;
const MAX_GENRE = 50;
const MAX_OVERVIEW = 1000;
const MIN_YEAR = 1888; // the earliest surviving film
const maxYear = () => new Date().getFullYear() + 10;

const MAX_BULK = 50;

const COLUMNS = 'id, title, year, genre, watched, created_at, deleted_at, tmdb_id, poster_path, overview, catalog_id, poster_url';

const listActive = db.prepare(
  `SELECT ${COLUMNS} FROM movies WHERE user_id = ? AND deleted_at IS NULL ORDER BY watched ASC, created_at DESC, id DESC`
);
const listDeleted = db.prepare(
  `SELECT ${COLUMNS} FROM movies WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC`
);
const getActive = db.prepare(`SELECT ${COLUMNS} FROM movies WHERE id = ? AND user_id = ? AND deleted_at IS NULL`);
const getDeleted = db.prepare(`SELECT ${COLUMNS} FROM movies WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`);
const getAny = db.prepare(`SELECT ${COLUMNS} FROM movies WHERE id = ? AND user_id = ?`);
const insertMovie = db.prepare(
  `INSERT INTO movies (user_id, title, year, genre, tmdb_id, poster_path, overview, catalog_id, poster_url)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const getCatalogMovie = db.prepare('SELECT * FROM catalog_movies WHERE id = ?');
const getCatalogByTmdb = db.prepare('SELECT id FROM catalog_movies WHERE tmdb_id = ?');
const updateMovie = db.prepare(
  'UPDATE movies SET title = ?, year = ?, genre = ?, watched = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
);
const softDelete = db.prepare(
  "UPDATE movies SET deleted_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
);
const restore = db.prepare('UPDATE movies SET deleted_at = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL');
const purge = db.prepare('DELETE FROM movies WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL');

// An active movie counts as a duplicate if it comes from the same catalog entry, has the same
// TMDB id, or has the same title (ignoring case) and year. "year IS ?" treats two NULL years as equal.
const findActiveDuplicate = db.prepare(`
  SELECT id, title, year FROM movies
  WHERE user_id = ? AND deleted_at IS NULL AND id != ?
    AND ((? IS NOT NULL AND catalog_id = ?)
      OR (? IS NOT NULL AND tmdb_id = ?)
      OR (title = ? COLLATE NOCASE AND year IS ?))
  LIMIT 1
`);

function findDuplicate(userId, movie, excludeId = 0) {
  const catalogId = movie.catalog_id ?? null;
  const tmdbId = movie.tmdb_id ?? null;
  return findActiveDuplicate.get(userId, excludeId, catalogId, catalogId, tmdbId, tmdbId, movie.title, movie.year ?? null);
}

// The watchlist entry for a catalog movie: a copy of its details, linked by catalog_id.
// The details come from the database, never from the request, so they can't be tampered with.
function valuesFromCatalog(row) {
  return {
    catalog_id: row.id,
    title: row.title,
    year: row.year,
    genre: row.genre,
    tmdb_id: row.tmdb_id,
    poster_path: row.tmdb_poster_path,
    poster_url: row.tmdb_poster_path ? null : row.poster_url,
    overview: (row.tmdb_overview || row.overview || '').slice(0, MAX_OVERVIEW) || null,
  };
}

function insertValues(userId, values) {
  const info = insertMovie.run(
    userId,
    values.title,
    values.year ?? null,
    values.genre ?? null,
    values.tmdb_id ?? null,
    values.poster_path ?? null,
    values.overview ?? null,
    values.catalog_id ?? null,
    values.poster_url ?? null
  );
  return getActive.get(Number(info.lastInsertRowid), userId);
}

const label = (movie) => `“${movie.title}”${movie.year ? ` (${movie.year})` : ''}`;

// SQLite stores booleans as 0/1; send real booleans to the client.
const toJson = (row) => ({ ...row, watched: Boolean(row.watched) });

function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Validates the fields present in `body`. With `partial`, missing fields are left out
// of the result; otherwise title is required. Returns { error } or { values }.
function validateMovie(body, { partial = false } = {}) {
  const values = {};

  if (body.title !== undefined || !partial) {
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return { error: 'Title is required.' };
    }
    if (body.title.trim().length > MAX_TITLE) {
      return { error: `Title must be ${MAX_TITLE} characters or fewer.` };
    }
    values.title = body.title.trim();
  }

  if (body.year !== undefined) {
    if (body.year === null || body.year === '') {
      values.year = null;
    } else {
      const year = Number(body.year);
      if (!Number.isInteger(year) || year < MIN_YEAR || year > maxYear()) {
        return { error: `Year must be a whole number between ${MIN_YEAR} and ${maxYear()}.` };
      }
      values.year = year;
    }
  }

  if (body.genre !== undefined) {
    if (body.genre === null || (typeof body.genre === 'string' && !body.genre.trim())) {
      values.genre = null;
    } else if (typeof body.genre !== 'string' || body.genre.trim().length > MAX_GENRE) {
      return { error: `Genre must be text of ${MAX_GENRE} characters or fewer.` };
    } else {
      values.genre = body.genre.trim();
    }
  }

  if (body.watched !== undefined) {
    if (typeof body.watched !== 'boolean') {
      return { error: 'Watched must be true or false.' };
    }
    values.watched = body.watched;
  }

  // Details that come from movie search. They're only set when a movie is created.
  if (!partial) {
    if (body.tmdb_id !== undefined && body.tmdb_id !== null) {
      if (!Number.isInteger(body.tmdb_id) || body.tmdb_id <= 0) return { error: 'Invalid TMDB id.' };
      values.tmdb_id = body.tmdb_id;
    }
    if (body.poster_path !== undefined && body.poster_path !== null) {
      if (typeof body.poster_path !== 'string' || !POSTER_PATH_PATTERN.test(body.poster_path)) {
        return { error: 'Invalid poster path.' };
      }
      values.poster_path = body.poster_path;
    }
    if (body.overview !== undefined && body.overview !== null) {
      if (typeof body.overview !== 'string' || body.overview.length > MAX_OVERVIEW) {
        return { error: `Overview must be text of ${MAX_OVERVIEW} characters or fewer.` };
      }
      values.overview = body.overview.trim() || null;
    }
  }

  return { values };
}

function rejectInvalid(req, res, operation, error) {
  log.warn(`Validation failed: ${operation}`, { reason: error, userId: req.session.userId, requestId: req.id });
  return res.status(400).json({ error });
}

// A missing movie is either a stale page or someone trying another user's id; both look the same.
function notFound(req, res, operation, movieId, message = 'Movie not found.') {
  log.warn(`${operation}: movie not found for this user`, { movieId, userId: req.session.userId, requestId: req.id });
  return res.status(404).json({ error: message });
}

router.get('/', (req, res) => {
  res.locals.operation = 'list movies';
  res.json({ movies: listActive.all(req.session.userId).map(toJson) });
});

router.get('/deleted', (req, res) => {
  res.locals.operation = 'list recently deleted movies';
  res.json({ movies: listDeleted.all(req.session.userId).map(toJson) });
});

// Add one movie: either { catalog_id } for a Discover movie, or typed/searched details.
router.post('/', (req, res) => {
  res.locals.operation = 'add movie';
  const userId = req.session.userId;
  const body = req.body || {};
  let values;
  let source;

  if (body.catalog_id !== undefined) {
    const catalogId = Number.isInteger(body.catalog_id) && body.catalog_id > 0 ? body.catalog_id : null;
    if (!catalogId) return rejectInvalid(req, res, 'add movie from catalog', 'Invalid catalog id.');
    const row = getCatalogMovie.get(catalogId);
    if (!row) {
      log.warn('Add rejected: catalog movie not found', { catalogId, userId, requestId: req.id });
      return res.status(404).json({ error: 'That movie is no longer in the catalog.' });
    }
    values = valuesFromCatalog(row);
    source = 'catalog';
  } else {
    const result = validateMovie(body);
    if (result.error) return rejectInvalid(req, res, 'add movie', result.error);
    values = result.values;
    source = values.tmdb_id ? 'search' : 'manual';
    // A TMDB search result that's also in the catalog gets linked to it.
    const catalogMatch = values.tmdb_id && getCatalogByTmdb.get(values.tmdb_id);
    if (catalogMatch) values.catalog_id = catalogMatch.id;
  }

  const duplicate = findDuplicate(userId, values);
  if (duplicate) {
    log.info('Add skipped: movie already on watchlist', { existingId: duplicate.id, userId, requestId: req.id });
    return res.status(409).json({ error: `${label(duplicate)} is already on your watchlist.`, existingId: duplicate.id });
  }

  const movie = insertValues(userId, values);
  log.info('Movie added', { movieId: movie.id, source, catalogId: movie.catalog_id, userId, requestId: req.id });
  return res.status(201).json({ movie: toJson(movie) });
});

// Add several catalog movies at once (the starter pack). Movies already on the watchlist are
// skipped, not duplicated; everything else is added in one transaction.
router.post('/bulk', (req, res) => {
  res.locals.operation = 'add movies from catalog';
  const userId = req.session.userId;
  const ids = (req.body || {}).catalog_ids;
  if (
    !Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK ||
    !ids.every((id) => Number.isInteger(id) && id > 0)
  ) {
    return rejectInvalid(req, res, 'add movies from catalog', `catalog_ids must be a list of 1 to ${MAX_BULK} catalog ids.`);
  }

  const added = [];
  const skipped = [];
  db.exec('BEGIN');
  try {
    for (const catalogId of new Set(ids)) {
      const row = getCatalogMovie.get(catalogId);
      if (!row) {
        skipped.push({ catalog_id: catalogId, reason: 'not in the catalog' });
        continue;
      }
      const values = valuesFromCatalog(row);
      if (findDuplicate(userId, values)) {
        skipped.push({ catalog_id: catalogId, title: row.title, reason: 'already on your watchlist' });
        continue;
      }
      added.push(toJson(insertValues(userId, values)));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  log.info('Added movies from catalog', { added: added.length, skipped: skipped.length, userId, requestId: req.id });
  return res.status(added.length ? 201 : 200).json({ added, skipped });
});

router.post('/deleted/restore-all', (req, res) => {
  res.locals.operation = 'restore all movies';
  const userId = req.session.userId;
  const restored = [];
  const skipped = [];

  // One transaction: either the whole batch is applied or none of it is.
  db.exec('BEGIN');
  try {
    for (const movie of listDeleted.all(userId)) {
      // Checked one at a time, so two deleted copies of the same movie can't both come back.
      const duplicate = findDuplicate(userId, movie);
      if (duplicate) {
        skipped.push({ id: movie.id, title: movie.title, year: movie.year, reason: 'already on your watchlist' });
        continue;
      }
      restore.run(movie.id, userId);
      restored.push(toJson(getActive.get(movie.id, userId)));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  log.info('Restored all recently deleted movies', { restored: restored.length, skipped: skipped.length, userId, requestId: req.id });
  return res.json({ restored, skipped });
});

router.patch('/:id', (req, res) => {
  res.locals.operation = 'update movie';
  const userId = req.session.userId;
  const id = parseId(req.params.id);
  if (!id) return rejectInvalid(req, res, 'update movie', 'Invalid movie id.');

  const { error, values } = validateMovie(req.body || {}, { partial: true });
  if (error) return rejectInvalid(req, res, 'update movie', error);
  if (Object.keys(values).length === 0) {
    return rejectInvalid(req, res, 'update movie', 'Provide at least one field to update.');
  }

  // Looking the movie up by id AND user_id is the ownership check: another user's
  // movie is indistinguishable from one that doesn't exist.
  const existing = getActive.get(id, userId);
  if (!existing) return notFound(req, res, 'Update rejected', id);

  const merged = { ...toJson(existing), ...values };
  if (values.title !== undefined || values.year !== undefined) {
    const duplicate = findDuplicate(userId, { title: merged.title, year: merged.year }, id);
    if (duplicate) {
      return res.status(409).json({ error: `${label(duplicate)} is already on your watchlist.` });
    }
  }

  updateMovie.run(merged.title, merged.year, merged.genre, merged.watched ? 1 : 0, id, userId);
  const changed = Object.keys(values).join(', ');
  log.info('Movie updated', { movieId: id, changed, watched: merged.watched, userId, requestId: req.id });
  return res.json({ movie: toJson(getActive.get(id, userId)) });
});

// Normal delete: moves the movie to Recently Deleted.
router.delete('/:id', (req, res) => {
  res.locals.operation = 'move movie to Recently Deleted';
  const userId = req.session.userId;
  const id = parseId(req.params.id);
  if (!id) return rejectInvalid(req, res, 'delete movie', 'Invalid movie id.');

  const info = softDelete.run(id, userId);
  if (info.changes === 0) return notFound(req, res, 'Delete rejected', id);

  log.info('Movie moved to Recently Deleted', { movieId: id, userId, requestId: req.id });
  return res.json({ message: 'Moved to Recently Deleted.', id, movie: toJson(getAny.get(id, userId)) });
});

router.post('/:id/restore', (req, res) => {
  res.locals.operation = 'restore movie';
  const userId = req.session.userId;
  const id = parseId(req.params.id);
  if (!id) return rejectInvalid(req, res, 'restore movie', 'Invalid movie id.');

  const movie = getDeleted.get(id, userId);
  if (!movie) return notFound(req, res, 'Restore rejected', id, 'That movie is no longer in Recently Deleted.');

  const duplicate = findDuplicate(userId, movie);
  if (duplicate) {
    log.info('Restore skipped: an active copy already exists', { movieId: id, existingId: duplicate.id, userId, requestId: req.id });
    return res.status(409).json({
      error: `${label(duplicate)} is already on your watchlist, so this copy wasn't restored.`,
      existingId: duplicate.id,
    });
  }

  restore.run(id, userId);
  log.info('Movie restored', { movieId: id, userId, requestId: req.id });
  return res.json({ movie: toJson(getActive.get(id, userId)) });
});

// Permanent delete only works on movies already in Recently Deleted, so it always takes two steps.
router.delete('/:id/permanent', (req, res) => {
  res.locals.operation = 'permanently delete movie';
  const userId = req.session.userId;
  const id = parseId(req.params.id);
  if (!id) return rejectInvalid(req, res, 'permanently delete movie', 'Invalid movie id.');

  const info = purge.run(id, userId);
  if (info.changes === 0) {
    return notFound(req, res, 'Permanent delete rejected', id, 'That movie is not in Recently Deleted.');
  }

  log.info('Movie permanently deleted', { movieId: id, userId, requestId: req.id });
  return res.json({ message: 'Movie permanently deleted.', id });
});

module.exports = router;
