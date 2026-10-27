// Authentication middleware for API routes and protected pages.
const { ObjectId } = require('mongodb');

const isLoggedIn = (req) => Boolean(req.session && req.session.userId && ObjectId.isValid(req.session.userId));

// For JSON API routes: reject with 401 when there is no logged-in user. Otherwise req.userId is
// the user's ObjectId, which routes use to scope every query to the logged-in user.
function requireAuth(req, res, next) {
  if (isLoggedIn(req)) {
    req.userId = new ObjectId(req.session.userId);
    return next();
  }
  return res.status(401).json({ error: 'You must be logged in to do that.' });
}

// For HTML pages: send visitors without a session to the login page.
function requireAuthPage(req, res, next) {
  if (isLoggedIn(req)) {
    return next();
  }
  return res.redirect('/login.html');
}

// For the login/register pages: logged-in users go straight to their watchlist.
function redirectIfLoggedIn(req, res, next) {
  if (isLoggedIn(req)) {
    return res.redirect('/');
  }
  return next();
}

module.exports = { requireAuth, requireAuthPage, redirectIfLoggedIn };
