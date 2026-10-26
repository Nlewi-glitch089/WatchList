// Entry point: loads environment variables and starts the Express server.
require('dotenv').config({ quiet: true });

const { createLogger } = require('./lib/logger');
const log = createLogger('Server');

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', { error: reason instanceof Error ? reason : new Error(String(reason)) });
});
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception; shutting down', { error: err });
  process.exit(1);
});

const app = require('./app');
const db = require('./database/database');
const tmdb = require('./lib/tmdb');

const PORT = Number(process.env.PORT) || 3000;

const server = app.listen(PORT, () => {
  log.info(`Movie Night Watchlist running at http://localhost:${PORT}`, {
    env: process.env.NODE_ENV || 'development',
    movieSearch: tmdb.isEnabled() ? 'enabled' : 'disabled (no TMDB_API_KEY)',
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`Port ${PORT} is already in use. Stop the other program or set PORT in .env.`);
  } else {
    log.error('Failed to start', { error: err });
  }
  process.exit(1);
});

// Ctrl+C (SIGINT) or a process manager (SIGTERM): finish open requests, then close the database.
function shutdown(signal) {
  log.info(`Received ${signal}; shutting down`);
  server.close(() => {
    try {
      db.close();
      log.info('Database closed. Goodbye.');
    } catch (err) {
      log.error('Error while closing the database', { error: err });
    }
    process.exit(0);
  });
  // Don't hang forever on keep-alive connections.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
