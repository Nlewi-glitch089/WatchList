// Builds the Express application around a connected MongoDB database. server.js connects and
// starts it; the tests import createApp directly.
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');

const MongoSessionStore = require('./database/sessionStore');
const createAuthRoutes = require('./routes/auth');
const createMovieRoutes = require('./routes/movies');
const createSettingsRoutes = require('./routes/settings');
const discoverRoutes = require('./routes/discover');
const createCatalogRoutes = require('./routes/catalog');
const requestLogger = require('./middleware/requestLogger');
const { requireAuthPage, redirectIfLoggedIn } = require('./middleware/auth');
const { securityHeaders, sameOriginOnly } = require('./middleware/security');
const { createLogger } = require('./lib/logger');

const log = createLogger('App');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const publicDir = path.join(__dirname, 'public');

function getSessionSecret(isProduction) {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }
  if (isProduction) {
    throw new Error('SESSION_SECRET must be set when NODE_ENV=production. Add it under Environment in the Render dashboard.');
  }
  log.warn('SESSION_SECRET is not set; using a random secret. Logins will reset when the server restarts.');
  return crypto.randomBytes(32).toString('hex');
}

function createApp(db) {
  const isProduction = process.env.NODE_ENV === 'production';
  const app = express();

  if (isProduction) {
    // Needed for Secure cookies when running behind an HTTPS proxy/load balancer.
    app.set('trust proxy', 1);
  }
  app.disable('x-powered-by');

  app.use(requestLogger);
  app.use(securityHeaders(publicDir, { isProduction }));

  // For the hosting platform's health check: confirms the server and database respond.
  // Registered before the session middleware so health pings never touch the sessions collection.
  app.get('/healthz', async (req, res) => {
    try {
      await db.command({ ping: 1 });
      res.json({ status: 'ok' });
    } catch (err) {
      log.error('Health check failed: database unavailable', { error: err });
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use(express.json({ limit: '10kb' }));
  app.use(
    session({
      name: 'watchlist.sid',
      secret: getSessionSecret(isProduction),
      store: new MongoSessionStore(db),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
        maxAge: SEVEN_DAYS_MS,
      },
    })
  );

  // API
  app.use('/api', sameOriginOnly);
  app.use('/api/auth', createAuthRoutes(db));
  app.use('/api/movies', createMovieRoutes(db));
  app.use('/api/settings', createSettingsRoutes(db));
  app.use('/api/discover', discoverRoutes);
  app.use('/api/catalog', createCatalogRoutes(db));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // Pages
  app.get(['/', '/index.html'], requireAuthPage, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.get(['/login.html', '/register.html'], redirectIfLoggedIn);
  app.use(express.static(publicDir, { index: false }));
  app.use((req, res) => res.status(404).send('Page not found.'));

  // Errors
  app.use((err, req, res, next) => {
    const context = { requestId: req.id, route: `${req.method} ${req.originalUrl}` };
    if (err.type === 'entity.parse.failed') {
      log.warn('Rejected request with malformed JSON', context);
      return res.status(400).json({ error: 'Request body must be valid JSON.' });
    }
    if (err.type === 'entity.too.large') {
      log.warn('Rejected request body over the size limit', context);
      return res.status(413).json({ error: 'Request body is too large.' });
    }

    // Anything else is a bug or an infrastructure problem (for example a database error).
    // Routes can set res.locals.operation so the log says what was being attempted.
    log.error('Unexpected error while handling request', {
      ...context,
      operation: res.locals.operation,
      userId: req.session && req.session.userId,
      error: err,
    });
    if (res.headersSent) {
      return next(err);
    }
    return res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
  });

  return app;
}

module.exports = { createApp };
