// A small in-memory rate limiter for the login and registration routes.
// Counts are per client IP (behind Render's proxy, `trust proxy` makes req.ip the real client).
// Memory is fine here: the app runs as a single process, and a restart only resets the counters.
const { createLogger } = require('../lib/logger');

const log = createLogger('RateLimit');

// Options:
//   name      label for logs
//   windowMs  length of the window
//   max       requests counted per window before the client is blocked
//   countIf   (statusCode) => boolean; which finished responses count (default: all)
//   message   error shown to the user when blocked
function rateLimit({ name, windowMs, max, countIf = () => true, message }) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Forget expired windows so the map can't grow forever.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
  }, windowMs);
  cleanup.unref();

  return (req, res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(req.ip, entry);
    }

    if (entry.count >= max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      log.warn(`${name}: too many attempts`, { ip: req.ip, retryAfter, requestId: req.id });
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message });
    }

    res.on('finish', () => {
      if (countIf(res.statusCode)) entry.count++;
    });
    return next();
  };
}

module.exports = rateLimit;
