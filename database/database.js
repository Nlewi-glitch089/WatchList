// MongoDB connection and setup, using the official MongoDB Node.js driver.
//
// Collections:
//   users           accounts: username, bcrypt hash, theme
//   movies          each user's watchlist entries; user_id ties every entry to its owner, and
//                   deleted_at marks entries in Recently Deleted (null means active)
//   catalog_movies  the shared Discover catalog, seeded from database/catalog.json; _id is the
//                   film's Wikidata id, so re-seeding updates in place
//   app_meta        small key/value bookkeeping (which catalog file was last seeded)
//   sessions        login sessions (see database/sessionStore.js)
const { MongoClient } = require('mongodb');
const { createLogger } = require('../lib/logger');

const log = createLogger('Database');

// "mongodb+srv://user:secret@cluster0.example.net/..." → "mongodb+srv://cluster0.example.net",
// so connection problems can be logged without the password
function describeUri(uri) {
  try {
    const url = new URL(uri);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '(unreadable MONGODB_URI)';
  }
}

// Connects and checks the database answers, so a wrong URI or a stopped database fails at
// start-up instead of on the first request.
async function connectToDatabase(uri, dbName, { serverSelectionTimeoutMS = 8000 } = {}) {
  if (!uri) {
    throw new Error('MONGODB_URI is not set. Copy .env.example to .env for local development, or add it under Environment in the Render dashboard.');
  }
  let client;
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS });
    await client.connect();
    const db = client.db(dbName);
    await db.command({ ping: 1 });
    return { client, db };
  } catch (err) {
    if (client) await client.close().catch(() => {});
    throw new Error(`Couldn't connect to MongoDB at ${describeUri(uri)} (database "${dbName}"): ${err.message}`);
  }
}

// The connection settings from the environment (see .env.example).
function databaseSettings() {
  return { uri: process.env.MONGODB_URI, dbName: process.env.MONGODB_DB || 'movie_night' };
}

// Creating an index that already exists is a no-op, so this is safe on every start.
async function ensureIndexes(db) {
  await Promise.all([
    // Usernames are unique ignoring case: "Alice" and "alice" are the same account.
    db.collection('users').createIndex({ username_lower: 1 }, { unique: true }),
    db.collection('movies').createIndex({ user_id: 1, deleted_at: 1 }),
    db.collection('catalog_movies').createIndex(
      { tmdb_id: 1 },
      { unique: true, partialFilterExpression: { tmdb_id: { $type: 'number' } } }
    ),
    // MongoDB removes each session document once its expiry time has passed.
    db.collection('sessions').createIndex({ expires: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

// Everything the app needs before it serves requests: indexes, then the Discover catalog.
async function prepareDatabase(db) {
  await ensureIndexes(db);
  // A broken catalog file shouldn't stop the watchlist from working.
  try {
    await require('./seedCatalog').seedCatalog(db);
  } catch (err) {
    log.error('Could not load the movie catalog; Discover will be empty', { error: err });
  }
}

module.exports = { connectToDatabase, databaseSettings, describeUri, ensureIndexes, prepareDatabase };
