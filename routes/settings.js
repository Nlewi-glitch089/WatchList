// Per-user settings. For now that's just the theme, stored on the user's document.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { createLogger } = require('../lib/logger');

const log = createLogger('Settings');

const THEMES = ['after-hours', 'midnight', 'daydream'];

module.exports = function createSettingsRoutes(db) {
  const router = express.Router();
  router.use(requireAuth);
  const users = db.collection('users');

  router.get('/', async (req, res) => {
    res.locals.operation = 'load settings';
    const row = await users.findOne({ _id: req.userId }, { projection: { theme: 1 } });
    if (!row) return res.status(401).json({ error: 'You must be logged in to do that.' });
    // An unknown value (e.g. a theme that was removed) falls back to the default.
    return res.json({ settings: { theme: THEMES.includes(row.theme) ? row.theme : THEMES[0] } });
  });

  router.patch('/', async (req, res) => {
    res.locals.operation = 'update theme preference';
    const { theme } = req.body || {};
    if (typeof theme !== 'string' || !THEMES.includes(theme)) {
      log.warn('Theme update rejected: unknown theme', { theme: String(theme).slice(0, 40), userId: req.session.userId, requestId: req.id });
      return res.status(400).json({ error: `Theme must be one of: ${THEMES.join(', ')}.` });
    }

    const { matchedCount } = await users.updateOne({ _id: req.userId }, { $set: { theme } });
    if (matchedCount === 0) return res.status(401).json({ error: 'You must be logged in to do that.' });
    log.info('Theme preference updated', { theme, userId: req.session.userId, requestId: req.id });
    return res.json({ settings: { theme } });
  });

  return router;
};
