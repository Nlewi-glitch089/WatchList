# Movie Night

Movie Night is a personal movie watchlist. Users create an account, add films from a built-in catalog, from TMDB search, or by hand, and mark them as watched. Removed movies go to Recently Deleted, where they can be restored.

Built with Node.js, Express 5, MongoDB (official `mongodb` driver), and plain HTML, CSS, and JavaScript.

## Features

- **Accounts:** registration, login, and logout. Passwords are hashed with bcrypt, and sessions are stored in MongoDB, so logins survive restarts.
- **Personal watchlists:** each user's movies are private. Every query is scoped to the logged-in user's id.
- **Watched status:** filter by All, To watch, or Watched; search your list; sort by date added, title, or year.
- **Discover catalog:** 185 real films (from `database/catalog.json`) grouped into shelves, with genre/decade filters and title/director search. New accounts are offered an optional starter pack.
- **Movie search (optional):** TMDB search when `TMDB_API_KEY` is set. The key stays on the server.
- **Recently Deleted:** deleted movies keep all their details and watched status. Restore them one at a time or all at once, or delete them permanently.
- **Themes:** After Hours, Midnight, and Daydream, saved per account.

## Requirements

- Node.js 22.9 or newer (`engines` in `package.json`; the npm scripts use `--env-file-if-exists`)
- A MongoDB database: MongoDB Atlas or a local MongoDB server

## Local setup

```bash
git clone https://github.com/Nlewi-glitch089/WatchList.git
cd WatchList
npm install
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
```

Edit `.env`:

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | yes | MongoDB connection string, e.g. `mongodb://127.0.0.1:27017` or your Atlas `mongodb+srv://` string |
| `MONGODB_DB` | no | Database name (default `movie_night`) |
| `SESSION_SECRET` | in production | Signs session cookies. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `NODE_ENV` | no | `development` locally; `production` enables Secure cookies and HSTS and requires `SESSION_SECRET` |
| `PORT` | no | Default `3000` |
| `TMDB_API_KEY` | no | TMDB API key or Read Access Token; enables movie search |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, `error`, or `silent` |

Start the app:

```bash
npm start        # or: npm run dev (restarts on file changes)
```

Open http://localhost:3000. On startup the server connects to MongoDB, creates its indexes, and loads the catalog before it accepts requests. If `MONGODB_URI` is missing or unreachable, it logs the reason (without the password) and exits.

Other scripts: `npm run db:init` checks the connection and prepares the database without starting the server. `npm run catalog:seed` reloads `database/catalog.json`. `npm run catalog:refresh` adds TMDB posters and synopses (needs `TMDB_API_KEY`). `npm run catalog:build` regenerates the catalog from Wikidata and Wikipedia.

## Testing

```bash
npm test
```

The tests use Node's built-in test runner against a throwaway MongoDB server started by `mongodb-memory-server`. They never use `MONGODB_URI` or your database. The first run downloads a MongoDB binary (cached in `node_modules/.cache`), so it needs internet access once.

## Deployment (Render)

In the Render dashboard, choose **New → Web Service** and connect this repository.

- **Build command:** `npm install --omit=dev` (skips test-only packages such as `mongodb-memory-server`)
- **Start command:** `npm start`
- **Health check path:** `/healthz` (returns 200 when MongoDB is reachable, 503 otherwise)
- **Environment variables:** `MONGODB_URI`, `SESSION_SECRET` (a new random value), and `NODE_ENV=production`. Optionally add `MONGODB_DB` and `TMDB_API_KEY`. Render sets `PORT`.

For MongoDB Atlas, allow Render's outbound IP addresses under **Network Access**. On first start the app creates its indexes and loads the catalog itself.

## Security

Never commit `.env` or any file containing credentials. `.gitignore` excludes `.env` and `.env.*` (except `.env.example`) and private keys. Keep real values only in your local `.env` and in Render's Environment settings. If a credential is ever committed or shared, rotate it in Atlas or TMDB right away.
