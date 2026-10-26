// Server-side client for The Movie Database (TMDB) search API.
// The API key stays on the server: the browser only ever talks to /api/discover.
//
// TMDB_API_KEY can be either the v3 "API Key" or the longer "API Read Access Token"
// from https://www.themoviedb.org/settings/api. Without it, search is simply disabled.
const { createLogger } = require('./logger');

const log = createLogger('Discover');

const POSTER_PATH_PATTERN = /^\/[A-Za-z0-9_-]{1,100}\.(jpg|jpeg|png|webp)$/;
const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const MAX_RESULTS = 12;

const searchCache = new Map();
let genreCache = { at: 0, map: new Map() };

const apiKey = () => (process.env.TMDB_API_KEY || '').trim();
const apiBase = () => process.env.TMDB_API_BASE || 'https://api.themoviedb.org/3';
const isEnabled = () => Boolean(apiKey());

// `kind` lets the route pick the right status code and message for the user.
class TmdbError extends Error {
  constructor(message, kind, details = {}) {
    super(message);
    this.kind = kind; // 'disabled' | 'auth' | 'rate-limited' | 'timeout' | 'network' | 'upstream' | 'malformed'
    this.details = details;
  }
}

async function tmdbGet(pathname, params = {}) {
  if (!isEnabled()) throw new TmdbError('TMDB_API_KEY is not set', 'disabled');

  const url = new URL(apiBase() + pathname);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  // Logged instead of the real URL, which may contain the key.
  const endpoint = `${pathname}?${url.searchParams.toString()}`;

  const headers = { Accept: 'application/json' };
  const key = apiKey();
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; // read access token (a JWT)
  else url.searchParams.set('api_key', key);

  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new TmdbError(timedOut ? `No response within ${TIMEOUT_MS}ms` : `Network error: ${err.message}`, timedOut ? 'timeout' : 'network', { endpoint });
  }

  if (response.status === 429) {
    throw new TmdbError('Rate limited by TMDB', 'rate-limited', { endpoint, retryAfter: response.headers.get('retry-after') });
  }
  if (response.status === 401) {
    throw new TmdbError('TMDB rejected the API key (401)', 'auth', { endpoint });
  }
  if (!response.ok) {
    throw new TmdbError(`TMDB responded with HTTP ${response.status}`, 'upstream', { endpoint, status: response.status });
  }

  try {
    return await response.json();
  } catch {
    throw new TmdbError('TMDB returned a body that is not valid JSON', 'malformed', { endpoint });
  }
}

// TMDB search results only include genre ids, so the id -> name list is fetched once a day.
// If it fails, results just come back without a genre.
async function getGenres() {
  if (genreCache.map.size && Date.now() - genreCache.at < 24 * 60 * 60 * 1000) return genreCache.map;
  try {
    const data = await tmdbGet('/genre/movie/list', { language: 'en-US' });
    const map = new Map((Array.isArray(data.genres) ? data.genres : []).map((g) => [g.id, g.name]));
    genreCache = { at: Date.now(), map };
    log.debug('Loaded TMDB genre list', { count: map.size });
  } catch (err) {
    log.warn('Could not load TMDB genres; continuing without them', { kind: err.kind, error: err.message });
  }
  return genreCache.map;
}

// Turns one raw TMDB result into the shape the app uses, or null if it's unusable.
function toResult(raw, genres) {
  if (!raw || !Number.isInteger(raw.id) || typeof raw.title !== 'string' || !raw.title.trim()) return null;
  const yearMatch = typeof raw.release_date === 'string' && raw.release_date.match(/^(\d{4})/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const firstGenre = Array.isArray(raw.genre_ids) ? genres.get(raw.genre_ids[0]) : null;
  return {
    tmdb_id: raw.id,
    title: raw.title.trim().slice(0, 200),
    year: year && year >= 1888 && year <= new Date().getFullYear() + 10 ? year : null,
    genre: typeof firstGenre === 'string' ? firstGenre.slice(0, 50) : null,
    overview: typeof raw.overview === 'string' && raw.overview.trim() ? raw.overview.trim().slice(0, 1000) : null,
    poster_path: typeof raw.poster_path === 'string' && POSTER_PATH_PATTERN.test(raw.poster_path) ? raw.poster_path : null,
  };
}

async function searchMovies(query) {
  const cacheKey = query.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    log.debug('Search served from cache', { query });
    return cached.results;
  }

  const started = Date.now();
  const [data, genres] = await Promise.all([
    tmdbGet('/search/movie', { query, include_adult: 'false', language: 'en-US', page: '1' }),
    getGenres(),
  ]);
  if (!data || !Array.isArray(data.results)) {
    throw new TmdbError('TMDB search response has no results array', 'malformed', { query });
  }

  const results = data.results.map((raw) => toResult(raw, genres)).filter(Boolean).slice(0, MAX_RESULTS);
  log.debug('TMDB search finished', { query, results: results.length, ms: Date.now() - started });

  if (searchCache.size >= CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(cacheKey, { at: Date.now(), results });
  return results;
}

// Full details for one movie, used by scripts/refresh-catalog.js to add TMDB posters and
// synopses to the Discover catalog. Returns null when TMDB has no movie with that id.
async function getMovieDetails(tmdbId) {
  try {
    const data = await tmdbGet(`/movie/${tmdbId}`, { language: 'en-US' });
    if (!data || data.id !== tmdbId) throw new TmdbError('TMDB movie details have an unexpected shape', 'malformed', { tmdbId });
    return {
      poster_path: typeof data.poster_path === 'string' && POSTER_PATH_PATTERN.test(data.poster_path) ? data.poster_path : null,
      overview: typeof data.overview === 'string' && data.overview.trim() ? data.overview.trim().slice(0, 1000) : null,
    };
  } catch (err) {
    if (err instanceof TmdbError && err.kind === 'upstream' && err.details.status === 404) return null;
    throw err;
  }
}

// For tests: forget cached searches and genres.
function clearCache() {
  searchCache.clear();
  genreCache = { at: 0, map: new Map() };
}

module.exports = { isEnabled, searchMovies, getMovieDetails, clearCache, TmdbError, POSTER_PATH_PATTERN };
