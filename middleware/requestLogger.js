// Gives every request a short id and logs API requests when they finish.
// The id is sent back in the X-Request-Id header, so an error in the browser console
// can be matched to the server log line for the same request.
const crypto = require('node:crypto');
const { createLogger } = require('../lib/logger');

const log = createLogger('HTTP');

function requestLogger(req, res, next) {
  req.id = crypto.randomBytes(4).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  const started = process.hrtime.bigint();

  res.on('finish', () => {
    // Static files and pages aren't interesting; API calls are.
    if (!req.originalUrl.startsWith('/api/')) return;
    const context = {
      requestId: req.id,
      status: res.statusCode,
      ms: Number((process.hrtime.bigint() - started) / 1000000n),
    };
    if (req.session && req.session.userId) context.userId = req.session.userId;
    // Routes log their own meaningful warnings and the error handler logs 500s,
    // so the per-request line stays at debug level to avoid duplicates.
    log.debug(`${req.method} ${req.originalUrl}`, context);
  });

  next();
}

module.exports = requestLogger;
