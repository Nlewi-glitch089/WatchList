// Movie search (TMDB). Requires login so the server's API key can't be used anonymously.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const tmdb = require('../lib/tmdb');
const { createLogger } = require('../lib/logger');

const router = express.Router();
router.use(requireAuth);
const log = createLogger('Discover');

const MAX_QUERY = 100;

// How each kind of TMDB failure is reported to the user. The details stay in the server log.
const FAILURES = {
  disabled: { status: 503, level: 'debug', error: "Movie search isn't set up on this server. You can still add movies manually." },
  'rate-limited': { status: 503, level: 'warn', error: 'Movie search is busy right now. Wait a few seconds and try again.' },
  timeout: { status: 504, level: 'warn', error: 'Movie search took too long to respond. Try again, or add the movie manually.' },
  network: { status: 503, level: 'warn', error: "Couldn't reach the movie search service. Try again, or add the movie manually." },
  auth: { status: 502, level: 'error', error: "Movie search isn't working right now. You can still add movies manually." },
  upstream: { status: 502, level: 'error', error: "Movie search isn't working right now. You can still add movies manually." },
  malformed: { status: 502, level: 'error', error: 'Movie search sent back something unexpected. Try again, or add the movie manually.' },
};

router.get('/status', (req, res) => {
  res.json({ enabled: tmdb.isEnabled() });
});

router.get('/search', async (req, res) => {
  res.locals.operation = 'search movies';
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query || query.length > MAX_QUERY) {
    log.warn('Search rejected: invalid query', { length: query.length, requestId: req.id });
    return res.status(400).json({ error: `Enter a movie title to search for (up to ${MAX_QUERY} characters).` });
  }

  try {
    const results = await tmdb.searchMovies(query);
    return res.json({ results });
  } catch (err) {
    if (!(err instanceof tmdb.TmdbError)) throw err; // a real bug: let the error handler log the stack
    const failure = FAILURES[err.kind] || FAILURES.upstream;
    log[failure.level](`Search failed: ${err.message}`, { kind: err.kind, query, ...err.details, requestId: req.id });
    return res.status(failure.status).json({ error: failure.error, code: err.kind === 'disabled' ? 'SEARCH_DISABLED' : 'SEARCH_FAILED' });
  }
});

module.exports = router;
