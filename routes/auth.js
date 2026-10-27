// Authentication routes: register, login, logout, and current user.
const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { createLogger } = require('../lib/logger');

const log = createLogger('Auth');

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const DUPLICATE_KEY = 11000;

const SALT_ROUNDS = 10;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,30}$/;
// Compared against when a username doesn't exist, so failed logins take similar time either way.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', SALT_ROUNDS);

function validateCredentials(body) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!USERNAME_PATTERN.test(username)) {
    return { error: 'Username must be 3-30 characters: letters, numbers, or underscores.' };
  }
  if (password.length < 8 || password.length > 72) {
    return { error: 'Password must be between 8 and 72 characters.' };
  }
  return { username, password };
}

// Start a fresh session for the user (prevents session fixation).
function logIn(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

module.exports = function createAuthRoutes(db) {
  const router = express.Router();
  const users = db.collection('users');

  // Only failed logins count, so a household sharing one IP isn't locked out by normal use.
  const loginLimit = rateLimit({
    name: 'Login',
    windowMs: FIFTEEN_MINUTES_MS,
    max: 10,
    countIf: (status) => status === 401,
    message: 'Too many failed login attempts. Wait 15 minutes and try again.',
  });
  // Only accounts actually created count.
  const registerLimit = rateLimit({
    name: 'Registration',
    windowMs: ONE_HOUR_MS,
    max: 20,
    countIf: (status) => status === 201,
    message: 'Too many accounts have been created from this network. Try again in an hour.',
  });

  // Usernames are matched ignoring case, through the lowercased copy with a unique index.
  const findUserByUsername = (username) => users.findOne({ username_lower: username.toLowerCase() });

  router.post('/register', registerLimit, async (req, res) => {
    res.locals.operation = 'register user';
    const result = validateCredentials(req.body || {});
    if (result.error) {
      log.warn('Registration rejected: validation failed', { reason: result.error, requestId: req.id });
      return res.status(400).json({ error: result.error });
    }

    if (await findUserByUsername(result.username)) {
      log.warn('Registration rejected: username taken', { username: result.username, requestId: req.id });
      return res.status(409).json({ error: 'That username is already taken.' });
    }

    const passwordHash = await bcrypt.hash(result.password, SALT_ROUNDS);
    let insertedId;
    try {
      ({ insertedId } = await users.insertOne({
        username: result.username,
        username_lower: result.username.toLowerCase(),
        password_hash: passwordHash,
        theme: 'after-hours',
        created_at: new Date(),
      }));
    } catch (err) {
      // Two simultaneous registrations for the same name can race past the check above.
      if (err.code === DUPLICATE_KEY) {
        log.warn('Registration rejected: username taken by a simultaneous signup', { username: result.username, requestId: req.id });
        return res.status(409).json({ error: 'That username is already taken.' });
      }
      throw err;
    }

    const user = { id: insertedId.toHexString(), username: result.username };
    await logIn(req, user);
    log.info('User registered; session started', { userId: user.id, username: user.username, requestId: req.id });
    return res.status(201).json({ user });
  });

  router.post('/login', loginLimit, async (req, res) => {
    res.locals.operation = 'log in';
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      log.warn('Login rejected: missing username or password', { requestId: req.id });
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const row = await findUserByUsername(username.trim());
    const passwordMatches = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);

    if (!row || !passwordMatches) {
      log.warn('Login rejected: invalid credentials', {
        username: username.trim().slice(0, 30),
        reason: row ? 'wrong password' : 'unknown username',
        requestId: req.id,
      });
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const user = { id: row._id.toHexString(), username: row.username };
    await logIn(req, user);
    log.info('User logged in; session started', { userId: user.id, requestId: req.id });
    return res.json({ user });
  });

  router.post('/logout', (req, res, next) => {
    res.locals.operation = 'log out';
    const userId = req.session.userId;
    req.session.destroy((err) => {
      if (err) return next(err);
      if (userId) log.info('User logged out; session ended', { userId, requestId: req.id });
      res.clearCookie('watchlist.sid');
      return res.json({ message: 'Logged out.' });
    });
  });

  router.get('/me', requireAuth, async (req, res) => {
    const row = await users.findOne({ _id: req.userId }, { projection: { username: 1 } });
    if (!row) {
      // The account was removed after the session was created.
      log.warn('Session refers to a user that no longer exists; ending it', { userId: req.session.userId, requestId: req.id });
      return req.session.destroy(() => res.status(401).json({ error: 'You must be logged in to do that.' }));
    }
    return res.json({ user: { id: row._id.toHexString(), username: row.username } });
  });

  return router;
};
