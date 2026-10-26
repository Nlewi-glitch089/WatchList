# Movie Night

Movie Night is a personal movie watchlist. You make an account, browse a built-in catalog of 185 real films (or search TMDB, or type a movie in yourself), and check movies off once you've watched them. If you remove something by accident, it goes to Recently Deleted instead of disappearing, so you can bring it back.

I built it with Node, Express, and SQLite, plus plain HTML, CSS, and JavaScript on the front end.

## Features

- Accounts with registration, login, and logout. Passwords are hashed with bcrypt, and sessions are stored in SQLite, so you stay logged in when the server restarts.
- A Discover page with 185 real films from the 1920s to 2025, spread across horror, sci-fi, animation, romance, comedy, crime, and more. Movies are grouped into shelves (Popular right now, Horror picks, Classics worth watching, Hidden gems…), and you can filter by genre and decade, search by title or director, and open any film for details. It works without any API key.
- New accounts land on Discover with an optional starter pack you can preview and trim before adding.
- A private watchlist for each user, separate from the shared catalog. Adding a movie from Discover takes one click and never creates duplicates. Other accounts can't see or change your movies, your deleted movies, or your settings.
- Optional movie search through TMDB for anything that isn't in the catalog. You can always add movies by hand too.
- Each movie gets a poster: the official one from TMDB if you've set up a key, a free poster from Wikimedia Commons for many classics, and otherwise a poster drawn in CSS from the title.
- Filters for All, To watch, and Watched, a search box for your own list, and sorting by date added, title, or release year. A summary shows how much of your list you've watched.
- Recently Deleted: removing a movie is undoable. From there you can restore movies one at a time or all at once, or delete them forever.
- Three themes (After Hours, Midnight, and Daydream). Your choice is saved to your account.
- Keyboard and screen reader support, visible focus states, reduced-motion support, and a layout that works on phones.
- Consistent logs on the server and in the browser console, so it's easier to see what broke and where.

## Tech Stack

- **Server:** Node.js and Express 5
- **Database:** SQLite via Node's built-in `node:sqlite` module
- **Auth:** express-session and bcryptjs
- **Front end:** HTML, CSS, and vanilla JavaScript
- **Movie data:** [Wikidata](https://www.wikidata.org), [Wikipedia](https://en.wikipedia.org), and [Wikimedia Commons](https://commons.wikimedia.org) for the built-in catalog, plus the [TMDB](https://www.themoviedb.org) API (optional)
- **Tests:** Node's built-in test runner (`node:test`)

## Getting Started

You'll need **Node.js 22.13 or newer** (`node:sqlite` isn't available before that). Check with `node -v`.

```bash
git clone <your-repo-url>
cd WatchList
npm install
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
```

Then open `.env` and fill it in:

| Variable | What it's for |
|---|---|
| `SESSION_SECRET` | Signs login cookies. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `PORT` | Defaults to 3000. Change it if something else is already using that port. |
| `NODE_ENV` | `development` locally. `production` turns on Secure cookies, HSTS, and proxy trust, and requires `SESSION_SECRET`. |
| `DB_PATH` | Where the SQLite file lives. Defaults to `data/movies.db`. |
| `TMDB_API_KEY` | Optional. Turns on movie search (see below). |
| `LOG_LEVEL` | Optional. `debug`, `info`, `warn`, or `error`. Defaults to `debug` in development and `info` in production. |

Don't commit `.env`; it's already in `.gitignore`.

The database is created automatically at `data/movies.db` the first time the server starts. If you're upgrading from an older version of Movie Night, any new columns are added on startup. That never touches your existing users or movies.

### The movie catalog

The Discover catalog lives in `database/catalog.json` and is loaded into the database automatically on startup. Loading it again (on every restart, or with `npm run catalog:seed`) updates movies in place and never creates duplicates.

Every fact in it comes from open sources: titles, years, genres, directors, runtimes, and TMDB ids from Wikidata; each film's opening description from its English Wikipedia article (linked in the app, CC BY-SA); public-domain posters from Wikimedia Commons; and "Popular right now" from Wikipedia page views over a 30-day window. To change which films are included, edit `scripts/catalog-picks.js` and run `npm run catalog:build`, which needs an internet connection and takes a few minutes.

If you've set a TMDB key, `npm run catalog:refresh` swaps in TMDB's official posters and synopses for every catalog movie.

### Setting up movie search (optional)

1. Create a free account at [themoviedb.org](https://www.themoviedb.org).
2. Go to **Settings → API**, request an API key for personal or non-commercial use, and copy either the **API Key** or the **API Read Access Token**.
3. Paste it into `.env` as `TMDB_API_KEY=...` and restart the server.

The key stays on the server: the browser only talks to Movie Night, never to TMDB directly. TMDB is free for non-commercial use as long as you credit them, which the app does in the footer while search is turned on. Read [TMDB's terms](https://www.themoviedb.org/api-terms-of-use) before using it for anything commercial.

## Running the App

```bash
npm start
```

Then open [http://localhost:3000](http://localhost:3000) (or whatever `PORT` you set) and create an account. `npm run dev` does the same thing but restarts the server whenever you change a file.

When something goes wrong, check two places:

- **The terminal.** Every line is shaped like `2026-10-26T14:03:12Z [WARN] [Auth] Login rejected: invalid credentials {...}`, and unexpected errors include a stack trace.
- **The browser console.** Failed requests are logged with the endpoint, status, and a `requestId` that matches the server's log line for the same request.

Passwords, cookies, and keys are never logged.

## Running Tests

```bash
npm test
```

The tests use a temporary in-memory database and a fake TMDB server, so they don't need a network connection or an API key, and they never touch `data/movies.db`. They cover accounts and sessions, the watchlist, the catalog and starter pack, Recently Deleted, themes, movie search failures, logging, keeping each user's data separate, and upgrading an old database.

## Security

- Passwords are hashed with bcrypt; sessions are regenerated on login and destroyed on logout.
- Session cookies are `HttpOnly` and `SameSite=Lax`, and `Secure` in production.
- Every watchlist, Recently Deleted, and settings query is scoped to the logged-in user, and all SQL is parameterized.
- Failed logins are limited to 10 per 15 minutes per IP, and new accounts to 20 per hour per IP (in memory, so a restart resets the counts).
- Responses carry a Content Security Policy and clickjacking/MIME-sniffing protection. State-changing API requests from another origin are rejected.
- The TMDB key never leaves the server, and the logger redacts passwords, hashes, cookies, tokens, and keys.

## Deploying to Render

The repo includes a [`render.yaml`](render.yaml) Blueprint.

1. Push the repo to GitHub.
2. In the Render Dashboard choose **New → Blueprint**, connect the repo, and review the plan it shows.
3. When asked, paste a TMDB key into `TMDB_API_KEY`, or leave it empty (search is optional).
4. Deploy. Render runs `npm ci`, then `npm start`, and checks `/healthz`.

What the Blueprint sets up, and why:

- **A persistent disk at `/var/data`, with `DB_PATH=/var/data/movies.db`.** Render's normal filesystem is wiped on every deploy and restart, so without the disk every account and watchlist would disappear. Disks need a paid instance type. They also limit the service to one instance and turn off zero-downtime deploys, which is fine for SQLite. Render snapshots disks daily and keeps them for 7 days.
- **`NODE_ENV=production`.** Enables Secure cookies and HSTS, and trusts Render's HTTPS proxy.
- **`SESSION_SECRET`** is generated by Render. Never reuse your local one.
- **`NODE_VERSION=24`** pins Node so a new major release can't change the runtime under you.
- **The port.** Render sets `PORT` itself and the server already listens on it.

On the first start the app creates its tables and loads the 185-film catalog by itself. Later deploys only add missing columns and never touch existing users or movies.

Render's free instance type has no persistent disk. It works for a quick demo, but all data is lost on each deploy, restart, or idle spin-down.

## Future Improvements

- Edit a movie's title, year, or genre from the UI (the API already supports it)
- Recommendations based on what you've already watched
- Real posters for the whole catalog without needing a TMDB key
- Automatically empty Recently Deleted after 30 days
- Password reset and account deletion
- Ratings and notes for movies you've watched
