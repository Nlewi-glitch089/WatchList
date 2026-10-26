// express-session store that keeps sessions in the same SQLite database,
// so logins survive server restarts.
const session = require('express-session');
const { createLogger } = require('../lib/logger');

const log = createLogger('Session');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

class SQLiteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.getStmt = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?');
    this.setStmt = db.prepare(`
      INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
    `);
    this.touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.cleanupStmt = db.prepare('DELETE FROM sessions WHERE expires <= ?');

    // Periodically remove expired sessions; unref() so this never keeps the process alive.
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  expiryFor(sess) {
    const expires = sess.cookie && sess.cookie.expires;
    return expires ? new Date(expires).getTime() : Date.now() + ONE_DAY_MS;
  }

  // Session ids are secrets, so failures are logged without them.
  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (err) {
      log.error('Could not read session from the database', { error: err });
      callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), this.expiryFor(sess));
      callback && callback(null);
    } catch (err) {
      log.error('Could not save session to the database', { error: err });
      callback && callback(err);
    }
  }

  touch(sid, sess, callback) {
    try {
      this.touchStmt.run(this.expiryFor(sess), sid);
      callback && callback(null);
    } catch (err) {
      log.error('Could not extend session expiry', { error: err });
      callback && callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.destroyStmt.run(sid);
      callback && callback(null);
    } catch (err) {
      log.error('Could not delete session from the database', { error: err });
      callback && callback(err);
    }
  }

  cleanup() {
    try {
      const { changes } = this.cleanupStmt.run(Date.now());
      if (changes) log.debug('Removed expired sessions', { count: changes });
    } catch (err) {
      log.error('Failed to clean up expired sessions', { error: err });
    }
  }
}

module.exports = SQLiteSessionStore;
