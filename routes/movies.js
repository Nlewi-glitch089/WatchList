// Watchlist routes. Every query filters on the logged-in user's id (user_id),
// so one user can never read or change another user's movies.
//
// Deleting is a soft delete: the document stays in the database with deleted_at set, which puts
// the movie in "Recently Deleted" with all of its details and its watched status. From there it
// can be restored or permanently deleted.
const express = require('express');
const { ObjectId } = require('mongodb');
const { requireAuth } = require('../middleware/auth');
const { createLogger } = require('../lib/logger');
const { POSTER_PATH_PATTERN } = require('../lib/tmdb');

const log = createLogger('Movies');

const MAX_TITLE = 200;
const MAX_GENRE = 50;
const MAX_OVERVIEW = 1000;
const MIN_YEAR = 1888; // the earliest surviving film
const maxYear = () => new Date().getFullYear() + 10;

const MAX_BULK = 50;
const CATALOG_ID_PATTERN = /^Q\d+$/; // catalog ids are Wikidata ids
const isCatalogId = (value) => typeof value === 'string' && CATALOG_ID_PATTERN.test(value);

// The watchlist entry for a catalog movie: a copy of its details, linked by catalog_id.
// The details come from the database, never from the request, so they can't be tampered with.
function valuesFromCatalog(doc) {
  return {
    catalog_id: doc._id,
    title: doc.title,
    year: doc.year,
    genre: doc.genre,
    tmdb_id: doc.tmdb_id,
    poster_path: doc.tmdb_poster_path || null,
    poster_url: doc.tmdb_poster_path ? null : doc.poster_url,
    overview: (doc.tmdb_overview || doc.overview || '').slice(0, MAX_OVERVIEW) || null,
  };
}

const label = (movie) => `“${movie.title}”${movie.year ? ` (${movie.year})` : ''}`;

// The browser gets a plain string id, and never sees user_id or the lowercased title.
const toJson = ({ _id, user_id, title_lower, ...rest }) => ({ id: _id.toHexString(), ...rest });

function parseId(raw) {
  return typeof raw === 'string' && /^[0-9a-f]{24}$/i.test(raw) ? new ObjectId(raw) : null;
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
  log.warn(`${operation}: movie not found for this user`, { movieId: String(movieId), userId: req.session.userId, requestId: req.id });
  return res.status(404).json({ error: message });
}

module.exports = function createMovieRoutes(db) {
  const router = express.Router();
  router.use(requireAuth);
  const movies = db.collection('movies');
  const catalog = db.collection('catalog_movies');

  // Every lookup below includes user_id: that is the ownership check. Another user's movie
  // is indistinguishable from one that doesn't exist.
  const ACTIVE = { deleted_at: null };
  const DELETED = { deleted_at: { $ne: null } };

  const listActive = (userId) => movies.find({ user_id: userId, ...ACTIVE }).sort({ watched: 1, created_at: -1, _id: -1 }).toArray();
  const listDeleted = (userId) => movies.find({ user_id: userId, ...DELETED }).sort({ deleted_at: -1, _id: -1 }).toArray();
  const getActive = (id, userId) => movies.findOne({ _id: id, user_id: userId, ...ACTIVE });
  const getDeleted = (id, userId) => movies.findOne({ _id: id, user_id: userId, ...DELETED });

  // An active movie counts as a duplicate if it comes from the same catalog entry, has the same
  // TMDB id, or has the same title (ignoring case) and year. Two missing years count as equal.
  function findDuplicate(userId, movie, excludeId = null) {
    const matches = [{ title_lower: movie.title.toLowerCase(), year: movie.year ?? null }];
    if (movie.catalog_id != null) matches.push({ catalog_id: movie.catalog_id });
    if (movie.tmdb_id != null) matches.push({ tmdb_id: movie.tmdb_id });
    const filter = { user_id: userId, ...ACTIVE, $or: matches };
    if (excludeId) filter._id = { $ne: excludeId };
    return movies.findOne(filter, { projection: { title: 1, year: 1 } });
  }

  async function insertValues(userId, values) {
    const doc = {
      user_id: userId,
      title: values.title,
      title_lower: values.title.toLowerCase(),
      year: values.year ?? null,
      genre: values.genre ?? null,
      watched: false,
      created_at: new Date(),
      deleted_at: null,
      tmdb_id: values.tmdb_id ?? null,
      poster_path: values.poster_path ?? null,
      overview: values.overview ?? null,
      catalog_id: values.catalog_id ?? null,
      poster_url: values.poster_url ?? null,
    };
    const { insertedId } = await movies.insertOne(doc);
    return { ...doc, _id: insertedId };
  }

  router.get('/', async (req, res) => {
    res.locals.operation = 'list movies';
    res.json({ movies: (await listActive(req.userId)).map(toJson) });
  });

  router.get('/deleted', async (req, res) => {
    res.locals.operation = 'list recently deleted movies';
    res.json({ movies: (await listDeleted(req.userId)).map(toJson) });
  });

  // Add one movie: either { catalog_id } for a Discover movie, or typed/searched details.
  router.post('/', async (req, res) => {
    res.locals.operation = 'add movie';
    const userId = req.userId;
    const body = req.body || {};
    let values;
    let source;

    if (body.catalog_id !== undefined) {
      if (!isCatalogId(body.catalog_id)) return rejectInvalid(req, res, 'add movie from catalog', 'Invalid catalog id.');
      const doc = await catalog.findOne({ _id: body.catalog_id });
      if (!doc) {
        log.warn('Add rejected: catalog movie not found', { catalogId: body.catalog_id, userId: req.session.userId, requestId: req.id });
        return res.status(404).json({ error: 'That movie is no longer in the catalog.' });
      }
      values = valuesFromCatalog(doc);
      source = 'catalog';
    } else {
      const result = validateMovie(body);
      if (result.error) return rejectInvalid(req, res, 'add movie', result.error);
      values = result.values;
      source = values.tmdb_id ? 'search' : 'manual';
      // A TMDB search result that's also in the catalog gets linked to it.
      const catalogMatch = values.tmdb_id && (await catalog.findOne({ tmdb_id: values.tmdb_id }, { projection: { _id: 1 } }));
      if (catalogMatch) values.catalog_id = catalogMatch._id;
    }

    const duplicate = await findDuplicate(userId, values);
    if (duplicate) {
      log.info('Add skipped: movie already on watchlist', { existingId: String(duplicate._id), userId: req.session.userId, requestId: req.id });
      return res.status(409).json({ error: `${label(duplicate)} is already on your watchlist.`, existingId: duplicate._id.toHexString() });
    }

    const movie = await insertValues(userId, values);
    log.info('Movie added', { movieId: String(movie._id), source, catalogId: movie.catalog_id, userId: req.session.userId, requestId: req.id });
    return res.status(201).json({ movie: toJson(movie) });
  });

  // Add several catalog movies at once (the starter pack). Movies already on the watchlist are
  // skipped, not duplicated. Each one is checked against the movies added before it.
  router.post('/bulk', async (req, res) => {
    res.locals.operation = 'add movies from catalog';
    const userId = req.userId;
    const ids = (req.body || {}).catalog_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK || !ids.every(isCatalogId)) {
      return rejectInvalid(req, res, 'add movies from catalog', `catalog_ids must be a list of 1 to ${MAX_BULK} catalog ids.`);
    }

    const uniqueIds = [...new Set(ids)];
    const found = await catalog.find({ _id: { $in: uniqueIds } }).toArray();
    const byId = new Map(found.map((doc) => [doc._id, doc]));
    const added = [];
    const skipped = [];
    for (const catalogId of uniqueIds) {
      const doc = byId.get(catalogId);
      if (!doc) {
        skipped.push({ catalog_id: catalogId, reason: 'not in the catalog' });
        continue;
      }
      const values = valuesFromCatalog(doc);
      if (await findDuplicate(userId, values)) {
        skipped.push({ catalog_id: catalogId, title: doc.title, reason: 'already on your watchlist' });
        continue;
      }
      added.push(toJson(await insertValues(userId, values)));
    }

    log.info('Added movies from catalog', { added: added.length, skipped: skipped.length, userId: req.session.userId, requestId: req.id });
    return res.status(added.length ? 201 : 200).json({ added, skipped });
  });

  router.post('/deleted/restore-all', async (req, res) => {
    res.locals.operation = 'restore all movies';
    const userId = req.userId;
    const restored = [];
    const skipped = [];

    for (const movie of await listDeleted(userId)) {
      // Checked one at a time, so two deleted copies of the same movie can't both come back.
      const duplicate = await findDuplicate(userId, movie);
      if (duplicate) {
        skipped.push({ id: movie._id.toHexString(), title: movie.title, year: movie.year, reason: 'already on your watchlist' });
        continue;
      }
      const doc = await movies.findOneAndUpdate(
        { _id: movie._id, user_id: userId, ...DELETED },
        { $set: { deleted_at: null } },
        { returnDocument: 'after' }
      );
      if (doc) restored.push(toJson(doc));
    }

    log.info('Restored all recently deleted movies', { restored: restored.length, skipped: skipped.length, userId: req.session.userId, requestId: req.id });
    return res.json({ restored, skipped });
  });

  router.patch('/:id', async (req, res) => {
    res.locals.operation = 'update movie';
    const userId = req.userId;
    const id = parseId(req.params.id);
    if (!id) return rejectInvalid(req, res, 'update movie', 'Invalid movie id.');

    const { error, values } = validateMovie(req.body || {}, { partial: true });
    if (error) return rejectInvalid(req, res, 'update movie', error);
    if (Object.keys(values).length === 0) {
      return rejectInvalid(req, res, 'update movie', 'Provide at least one field to update.');
    }

    const existing = await getActive(id, userId);
    if (!existing) return notFound(req, res, 'Update rejected', id);

    const merged = { ...existing, ...values };
    if (values.title !== undefined || values.year !== undefined) {
      const duplicate = await findDuplicate(userId, { title: merged.title, year: merged.year }, id);
      if (duplicate) {
        return res.status(409).json({ error: `${label(duplicate)} is already on your watchlist.` });
      }
    }

    const changes = { ...values };
    if (values.title !== undefined) changes.title_lower = values.title.toLowerCase();
    const movie = await movies.findOneAndUpdate({ _id: id, user_id: userId, ...ACTIVE }, { $set: changes }, { returnDocument: 'after' });
    if (!movie) return notFound(req, res, 'Update rejected', id);

    log.info('Movie updated', { movieId: String(id), changed: Object.keys(values).join(', '), watched: movie.watched, userId: req.session.userId, requestId: req.id });
    return res.json({ movie: toJson(movie) });
  });

  // Normal delete: moves the movie to Recently Deleted.
  router.delete('/:id', async (req, res) => {
    res.locals.operation = 'move movie to Recently Deleted';
    const id = parseId(req.params.id);
    if (!id) return rejectInvalid(req, res, 'delete movie', 'Invalid movie id.');

    const movie = await movies.findOneAndUpdate(
      { _id: id, user_id: req.userId, ...ACTIVE },
      { $set: { deleted_at: new Date() } },
      { returnDocument: 'after' }
    );
    if (!movie) return notFound(req, res, 'Delete rejected', id);

    log.info('Movie moved to Recently Deleted', { movieId: String(id), userId: req.session.userId, requestId: req.id });
    return res.json({ message: 'Moved to Recently Deleted.', id: id.toHexString(), movie: toJson(movie) });
  });

  router.post('/:id/restore', async (req, res) => {
    res.locals.operation = 'restore movie';
    const userId = req.userId;
    const id = parseId(req.params.id);
    if (!id) return rejectInvalid(req, res, 'restore movie', 'Invalid movie id.');

    const deleted = await getDeleted(id, userId);
    if (!deleted) return notFound(req, res, 'Restore rejected', id, 'That movie is no longer in Recently Deleted.');

    const duplicate = await findDuplicate(userId, deleted);
    if (duplicate) {
      log.info('Restore skipped: an active copy already exists', { movieId: String(id), existingId: String(duplicate._id), userId: req.session.userId, requestId: req.id });
      return res.status(409).json({
        error: `${label(duplicate)} is already on your watchlist, so this copy wasn't restored.`,
        existingId: duplicate._id.toHexString(),
      });
    }

    const movie = await movies.findOneAndUpdate(
      { _id: id, user_id: userId, ...DELETED },
      { $set: { deleted_at: null } },
      { returnDocument: 'after' }
    );
    if (!movie) return notFound(req, res, 'Restore rejected', id, 'That movie is no longer in Recently Deleted.');

    log.info('Movie restored', { movieId: String(id), userId: req.session.userId, requestId: req.id });
    return res.json({ movie: toJson(movie) });
  });

  // Permanent delete only works on movies already in Recently Deleted, so it always takes two steps.
  router.delete('/:id/permanent', async (req, res) => {
    res.locals.operation = 'permanently delete movie';
    const id = parseId(req.params.id);
    if (!id) return rejectInvalid(req, res, 'permanently delete movie', 'Invalid movie id.');

    const { deletedCount } = await movies.deleteOne({ _id: id, user_id: req.userId, ...DELETED });
    if (deletedCount === 0) {
      return notFound(req, res, 'Permanent delete rejected', id, 'That movie is not in Recently Deleted.');
    }

    log.info('Movie permanently deleted', { movieId: String(id), userId: req.session.userId, requestId: req.id });
    return res.json({ message: 'Movie permanently deleted.', id: id.toHexString() });
  });

  return router;
};
