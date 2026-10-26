// SQLite connection and schema, using Node's built-in node:sqlite module.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createLogger } = require('../lib/logger');

const log = createLogger('Database');
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'movies.db');

let db;
try {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  db = new DatabaseSync(dbPath);
} catch (err) {
  log.error('Could not open the SQLite database', { dbPath, error: err });
  throw err;
}

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    theme         TEXT    NOT NULL DEFAULT 'after-hours',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- The shared Discover catalog: real movies anyone can browse. Seeded from
  -- database/catalog.json (see database/seedCatalog.js); never edited by users.
  CREATE TABLE IF NOT EXISTS catalog_movies (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    wikidata_id      TEXT    NOT NULL UNIQUE,   -- stable id the seed upserts on
    tmdb_id          INTEGER UNIQUE,
    imdb_id          TEXT,
    title            TEXT    NOT NULL,
    year             INTEGER,
    genre            TEXT,                      -- main genre shown on cards
    genres           TEXT    NOT NULL DEFAULT '[]', -- JSON array
    directors        TEXT    NOT NULL DEFAULT '[]', -- JSON array
    runtime          INTEGER,                   -- minutes
    overview         TEXT,                      -- from Wikipedia
    overview_source  TEXT,                      -- Wikipedia article URL
    poster_url       TEXT,                      -- free poster from Wikimedia Commons
    poster_page      TEXT,
    poster_credit    TEXT,
    popularity       INTEGER,                   -- Wikipedia page views in the build's 30-day window
    tags             TEXT    NOT NULL DEFAULT '[]', -- JSON array, e.g. ["starter"]
    tmdb_poster_path TEXT,                      -- filled in by npm run catalog:refresh (needs a TMDB key)
    tmdb_overview    TEXT,
    tmdb_refreshed_at TEXT,
    updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Small key/value store for app bookkeeping (e.g. which catalog file was last seeded).
  CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Each user's personal watchlist. Movies added from the catalog keep a copy of the
  -- details plus catalog_id, so the watchlist works on its own and duplicates are easy to spot.
  CREATE TABLE IF NOT EXISTS movies (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT    NOT NULL,
    year        INTEGER,
    genre       TEXT,
    watched     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    deleted_at  TEXT,               -- set when moved to Recently Deleted; NULL means active
    tmdb_id     INTEGER,            -- TMDB movie id when added from search
    poster_path TEXT,               -- TMDB poster path, e.g. /abc123.jpg
    overview    TEXT,
    catalog_id  INTEGER REFERENCES catalog_movies(id) ON DELETE SET NULL,
    poster_url  TEXT                -- full poster URL (Wikimedia Commons) for catalog movies
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT    PRIMARY KEY,
    sess    TEXT    NOT NULL,
    expires INTEGER NOT NULL
  );
`);

// Databases created before a column existed get it added here. Adding a nullable
// column (or one with a default) never touches existing rows, so this is safe to
// run on every startup.
const MIGRATIONS = [
  { table: 'users', column: 'theme', sql: "ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'after-hours'" },
  { table: 'movies', column: 'deleted_at', sql: 'ALTER TABLE movies ADD COLUMN deleted_at TEXT' },
  { table: 'movies', column: 'tmdb_id', sql: 'ALTER TABLE movies ADD COLUMN tmdb_id INTEGER' },
  { table: 'movies', column: 'poster_path', sql: 'ALTER TABLE movies ADD COLUMN poster_path TEXT' },
  { table: 'movies', column: 'overview', sql: 'ALTER TABLE movies ADD COLUMN overview TEXT' },
  {
    table: 'movies',
    column: 'catalog_id',
    sql: 'ALTER TABLE movies ADD COLUMN catalog_id INTEGER REFERENCES catalog_movies(id) ON DELETE SET NULL',
  },
  { table: 'movies', column: 'poster_url', sql: 'ALTER TABLE movies ADD COLUMN poster_url TEXT' },
];

function runMigrations() {
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const pending = MIGRATIONS.filter((m) => !columns(m.table).includes(m.column));
  if (!pending.length) return;

  db.exec('BEGIN');
  try {
    for (const migration of pending) {
      db.exec(migration.sql);
      log.info(`Migration applied: added ${migration.table}.${migration.column}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    log.error('Migration failed; no changes were made', { dbPath, error: err });
    throw err;
  }
}

runMigrations();
db.exec('CREATE INDEX IF NOT EXISTS idx_movies_user_deleted ON movies(user_id, deleted_at)');

log.info('Connected to SQLite database', { dbPath });

// Load the Discover catalog. A broken catalog file shouldn't stop the watchlist from working.
try {
  require('./seedCatalog').seedCatalog(db);
} catch (err) {
  log.error('Could not load the movie catalog; Discover will be empty', { error: err });
}

module.exports = db;
