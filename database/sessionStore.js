// express-session store that keeps sessions in the app's MongoDB database,
// so logins survive server restarts and redeploys.
//
// Each session is one document in the sessions collection: { _id: session id, session, expires }.
// A TTL index on `expires` (see database/database.js) lets MongoDB delete expired sessions itself.
const session = require('express-session');
const { createLogger } = require('../lib/logger');

const log = createLogger('Session');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

class MongoSessionStore extends session.Store {
  constructor(db) {
    super();
    this.sessions = db.collection('sessions');
  }

  expiryFor(sess) {
    const expires = sess.cookie && sess.cookie.expires;
    return expires ? new Date(expires) : new Date(Date.now() + ONE_DAY_MS);
  }

  // Session ids are secrets, so failures are logged without them.
  get(sid, callback) {
    // The TTL monitor runs about once a minute, so expired documents are also filtered out here.
    this.sessions
      .findOne({ _id: sid, expires: { $gt: new Date() } })
      .then((doc) => callback(null, doc ? JSON.parse(doc.session) : null))
      .catch((err) => {
        log.error('Could not read session from the database', { error: err });
        callback(err);
      });
  }

  set(sid, sess, callback) {
    this.sessions
      .updateOne({ _id: sid }, { $set: { session: JSON.stringify(sess), expires: this.expiryFor(sess) } }, { upsert: true })
      .then(() => callback && callback(null))
      .catch((err) => {
        log.error('Could not save session to the database', { error: err });
        if (callback) callback(err);
      });
  }

  touch(sid, sess, callback) {
    this.sessions
      .updateOne({ _id: sid }, { $set: { expires: this.expiryFor(sess) } })
      .then(() => callback && callback(null))
      .catch((err) => {
        log.error('Could not extend session expiry', { error: err });
        if (callback) callback(err);
      });
  }

  destroy(sid, callback) {
    this.sessions
      .deleteOne({ _id: sid })
      .then(() => callback && callback(null))
      .catch((err) => {
        log.error('Could not delete session from the database', { error: err });
        if (callback) callback(err);
      });
  }
}

module.exports = MongoSessionStore;
