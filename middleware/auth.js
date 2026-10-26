// Authentication middleware for API routes and protected pages.

// For JSON API routes: reject with 401 when there is no logged-in user.
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.status(401).json({ error: 'You must be logged in to do that.' });
}

// For HTML pages: send visitors without a session to the login page.
function requireAuthPage(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.redirect('/login.html');
}

// For the login/register pages: logged-in users go straight to their watchlist.
function redirectIfLoggedIn(req, res, next) {
  if (req.session && req.session.userId) {
    return res.redirect('/');
  }
  return next();
}

module.exports = { requireAuth, requireAuthPage, redirectIfLoggedIn };
