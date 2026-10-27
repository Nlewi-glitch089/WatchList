// Entry point: connects to MongoDB, prepares it, then starts the Express server.
//
// Settings come from environment variables (see .env.example). `npm start` reads a local .env
// file if there is one; on Render they are set in the dashboard instead.
const { createLogger } = require('./lib/logger');
const log = createLogger('Server');

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', { error: reason instanceof Error ? reason : new Error(String(reason)) });
});
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception; shutting down', { error: err });
  process.exit(1);
});

const { createApp } = require('./app');
const { connectToDatabase, databaseSettings, describeUri, prepareDatabase } = require('./database/database');
const tmdb = require('./lib/tmdb');

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  const { uri, dbName } = databaseSettings();

  // The routes need the database, so connect first and only listen once it's ready. A failed
  // connection exits with an error, which Render shows as a failed deploy.
  let connection;
  try {
    connection = await connectToDatabase(uri, dbName);
    await prepareDatabase(connection.db);
  } catch (err) {
    log.error(err.message);
    if (connection) await connection.client.close().catch(() => {});
    process.exit(1);
  }
  log.info('Connected to MongoDB', { server: describeUri(uri), database: dbName });

  let app;
  try {
    app = createApp(connection.db);
  } catch (err) {
    log.error(err.message);
    await connection.client.close().catch(() => {});
    process.exit(1);
  }

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

  // Ctrl+C (SIGINT) or a process manager (SIGTERM): finish open requests, then close the connection.
  function shutdown(signal) {
    log.info(`Received ${signal}; shutting down`);
    server.close(() => {
      connection.client
        .close()
        .then(() => log.info('Database connection closed. Goodbye.'))
        .catch((err) => log.error('Error while closing the database connection', { error: err }))
        .finally(() => process.exit(0));
    });
    // Don't hang forever on keep-alive connections.
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
