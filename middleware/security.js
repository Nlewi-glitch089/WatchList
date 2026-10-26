// Security headers and a same-origin check for state-changing API requests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLogger } = require('../lib/logger');

const log = createLogger('Security');
const PAGES = ['index.html', 'login.html', 'register.html'];

// Each page has a tiny inline script that applies the saved theme before first paint.
// Its hash is allowed by the CSP, computed from the files so editing the script can't break it silently.
function inlineScriptHashes(publicDir) {
  const hashes = new Set();
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(publicDir, page), 'utf8');
    for (const [, body] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      hashes.add(`'sha256-${crypto.createHash('sha256').update(body).digest('base64')}'`);
    }
  }
  return [...hashes];
}

function securityHeaders(publicDir, { isProduction }) {
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(publicDir).join(' ')}`,
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    // Posters: TMDB, Wikimedia Commons, and the data: URI favicon.
    "img-src 'self' data: https://image.tmdb.org https://upload.wikimedia.org https://thumb.wikimedia.org",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  };
}

// Defense in depth on top of SameSite=Lax cookies: browsers always send Origin on
// POST/PATCH/DELETE, so a mismatch means another site is trying to act as the user.
// Requests without Origin (curl, tests) carry no browser cookies by accident and are allowed.
function sameOriginOnly(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  if (originHost === req.get('host')) return next();
  log.warn('Rejected cross-origin request', { origin: origin.slice(0, 100), route: `${req.method} ${req.originalUrl}`, requestId: req.id });
  return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
}

module.exports = { securityHeaders, sameOriginOnly };
