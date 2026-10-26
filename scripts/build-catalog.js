// Builds database/catalog.json, the starter movie catalog behind the Discover page.
//
//   npm run catalog:build
//
// Every fact comes from open sources that need no API key:
//   - Wikipedia (CC BY-SA 4.0): finds each film's article and its opening description
//   - Wikidata (CC0): title, release year, genres, directors, runtime, TMDB and IMDb ids
//   - Wikimedia Commons: film posters, where a freely licensed one exists
//   - Wikimedia pageviews: how many people read about each film in the last 30 days
// The output file is committed, so the app itself never needs these services.
// Only scripts/catalog-picks.js (which films to include) is hand-written.
const fs = require('node:fs');
const path = require('node:path');
const picks = require('./catalog-picks');
const { createLogger } = require('../lib/logger');

const log = createLogger('CatalogBuild');
const OUTPUT = path.join(__dirname, '..', 'database', 'catalog.json');
const USER_AGENT = 'MovieNightCatalogBuilder/1.0 (personal watchlist project; local development)';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wikimedia asks clients to slow down with HTTP 429; wait as long as it says (or back off) and retry.
async function getJson(url, options = {}) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, { ...options, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...options.headers } });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    const retryAfter = Number(res.headers.get('retry-after')) || 5 * 2 ** (attempt - 1);
    log.warn(`Request failed (attempt ${attempt}); retrying in ${retryAfter}s`, { status: res.status, url: url.toString().slice(0, 120) });
    await sleep(retryAfter * 1000);
  }
  throw new Error(`Giving up on ${url}`);
}

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

// ---------- Wikipedia: article, Wikidata id, and opening paragraph ----------

async function fetchWikipedia(titles) {
  const found = new Map();
  for (const batch of chunk(titles, 20)) {
    const url = new URL('https://en.wikipedia.org/w/api.php');
    Object.entries({
      action: 'query', format: 'json', formatversion: '2', redirects: '1',
      prop: 'pageprops|extracts|info', ppprop: 'wikibase_item', inprop: 'url',
      exintro: '1', explaintext: '1', exlimit: '20', titles: batch.join('|'),
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    const data = await getJson(url);
    // Follow normalization and redirects back to the title we asked for.
    const renames = new Map([...(data.query.normalized || []), ...(data.query.redirects || [])].map((r) => [r.from, r.to]));
    for (const asked of batch) {
      let title = asked;
      for (let i = 0; i < 3 && renames.has(title); i++) title = renames.get(title);
      const page = data.query.pages.find((p) => p.title === title);
      if (page && !page.missing && page.pageprops && page.pageprops.wikibase_item) found.set(asked, page);
    }
    await sleep(200);
  }
  return found;
}

const ABBREVIATIONS = /\b(Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|U\.S|U\.K|Bros|Inc|No|Vol|Co)\.$/;

// The first paragraph, cut at a sentence boundary if it's long.
function trimExtract(extract, max = 520) {
  const paragraph = (extract || '').split('\n').find((p) => p.trim().length > 40) || '';
  if (paragraph.length <= max) return paragraph.trim();
  let cut = 0;
  for (const match of paragraph.matchAll(/[.!?](?=\s+[A-Z"“])/g)) {
    if (match.index > max) break;
    if (!ABBREVIATIONS.test(paragraph.slice(Math.max(0, match.index - 6), match.index + 1))) cut = match.index + 1;
  }
  return (cut ? paragraph.slice(0, cut) : paragraph.slice(0, max).replace(/\s+\S*$/, '') + '…').trim();
}

// ---------- Wikimedia pageviews: a real "popular right now" signal ----------

async function fetchPageviews(articleTitle, start, end) {
  const name = encodeURIComponent(articleTitle.replace(/ /g, '_'));
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia.org/all-access/user/${name}/daily/${start}00/${end}00`;
  const data = await getJson(url);
  return data && Array.isArray(data.items) ? data.items.reduce((sum, item) => sum + item.views, 0) : null;
}

// ---------- Wikidata: structured facts ----------

async function fetchWikidata(qids) {
  const facts = new Map();
  for (const batch of chunk(qids, 40)) {
    const query = `
      SELECT ?item ?itemLabel
        (MIN(YEAR(?date)) AS ?year)
        (GROUP_CONCAT(DISTINCT ?genreLabel; separator="|") AS ?genres)
        (GROUP_CONCAT(DISTINCT ?kindLabel; separator="|") AS ?kinds)
        (GROUP_CONCAT(DISTINCT ?directorLabel; separator="|") AS ?directors)
        (SAMPLE(?tmdb) AS ?tmdbId) (SAMPLE(?imdb) AS ?imdbId)
        (MAX(?duration) AS ?runtime) (SAMPLE(?poster) AS ?posterFile)
        (GROUP_CONCAT(DISTINCT ?image; separator="|") AS ?images)
      WHERE {
        VALUES ?item { ${batch.map((q) => `wd:${q}`).join(' ')} }
        OPTIONAL { ?item wdt:P577 ?date }
        OPTIONAL { ?item wdt:P136 ?genre . ?genre rdfs:label ?genreLabel FILTER(LANG(?genreLabel) = "en") }
        OPTIONAL { ?item wdt:P31 ?kind . ?kind rdfs:label ?kindLabel FILTER(LANG(?kindLabel) = "en") }
        OPTIONAL { ?item wdt:P57 ?director . ?director rdfs:label ?directorLabel FILTER(LANG(?directorLabel) = "en") }
        OPTIONAL { ?item wdt:P4947 ?tmdb }
        OPTIONAL { ?item wdt:P345 ?imdb }
        OPTIONAL { ?item wdt:P2047 ?duration }
        OPTIONAL { ?item wdt:P3383 ?poster }
        OPTIONAL { ?item wdt:P18 ?image }
        OPTIONAL { ?item rdfs:label ?itemLabel FILTER(LANG(?itemLabel) = "en") }
      }
      GROUP BY ?item ?itemLabel`;
    const url = new URL('https://query.wikidata.org/sparql');
    url.searchParams.set('query', query);
    url.searchParams.set('format', 'json');
    const data = await getJson(url, { headers: { Accept: 'application/sparql-results+json' } });
    for (const row of data.results.bindings) {
      const qid = row.item.value.split('/').pop();
      const value = (name) => (row[name] ? row[name].value : '');
      facts.set(qid, {
        title: value('itemLabel'),
        year: value('year') ? Number(value('year')) : null,
        genreLabels: value('genres').split('|').filter(Boolean),
        kindLabels: value('kinds').split('|').filter(Boolean),
        directors: value('directors').split('|').filter(Boolean),
        tmdbId: /^\d+$/.test(value('tmdbId')) ? Number(value('tmdbId')) : null,
        imdbId: /^tt\d+$/.test(value('imdbId')) ? value('imdbId') : null,
        runtime: value('runtime') ? Math.round(Number(value('runtime'))) : null,
        // A dedicated "film poster" (P3383), or else a general image (P18) whose file name says it's a poster.
        posterFile: [value('posterFile'), ...value('images').split('|').filter((url) => /poster/i.test(decodeURIComponent(url)))]
          .filter(Boolean)
          .map((url) => decodeURIComponent(url.split('/').pop()))[0] || null,
      });
    }
    await sleep(500);
  }
  return facts;
}

// Wikidata's genre names ("science fiction horror film") mapped onto the app's genres.
const GENRE_RULES = [
  ['Animation', /anim|anime/],
  ['Horror', /horror|slasher|zombie/],
  ['Sci-Fi', /science fiction|sci-fi|cyberpunk|dystopian|space opera/],
  ['Fantasy', /fantasy|fairy tale/],
  ['Romance', /romanc|romantic/],
  ['Comedy', /comedy|satir|parody|black comedy/],
  ['Mystery', /mystery|detective|whodunit/],
  ['Crime', /crime|gangster|heist|noir/],
  ['Thriller', /thriller|suspense/],
  ['Action', /action|martial arts|superhero|wuxia|samurai/],
  ['Adventure', /adventure/],
  ['Western', /western/],
  ['War', /\bwar film|war drama|anti-war/],
  ['Musical', /musical|music film|concert/],
  ['Documentary', /documentary/],
  ['Drama', /drama/],
];

function mapGenres(labels) {
  const text = labels.map((l) => l.toLowerCase());
  return GENRE_RULES.filter(([, pattern]) => text.some((label) => pattern.test(label))).map(([name]) => name);
}

// ---------- Wikimedia Commons: free posters ----------

const stripHtml = (html) => (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function fetchPosters(files) {
  const posters = new Map();
  for (const batch of chunk(files, 40)) {
    const url = new URL('https://commons.wikimedia.org/w/api.php');
    Object.entries({
      action: 'query', format: 'json', formatversion: '2', prop: 'imageinfo',
      iiprop: 'url|size|extmetadata', iiurlwidth: '400', titles: batch.map((f) => `File:${f}`).join('|'),
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    const data = await getJson(url);
    const renames = new Map((data.query.normalized || []).map((r) => [r.from, r.to]));
    for (const file of batch) {
      const title = renames.get(`File:${file}`) || `File:${file}`;
      const page = data.query.pages.find((p) => p.title === title);
      const info = page && page.imageinfo && page.imageinfo[0];
      if (!info || !info.thumburl || !/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(info.thumburl)) continue;
      // Posters are portrait; a landscape file is a still or a banner, not a poster.
      if (info.height < info.width) continue;
      const meta = info.extmetadata || {};
      const license = stripHtml(meta.LicenseShortName && meta.LicenseShortName.value) || 'see file page';
      posters.set(file, { url: info.thumburl, page: info.descriptionurl, credit: `${license}, via Wikimedia Commons` });
    }
    await sleep(300);
  }
  return posters;
}

// ---------- Build ----------

function ymd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

async function main() {
  const end = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
  log.info(`Building catalog from ${picks.length} picks`);
  const previous = fs.existsSync(OUTPUT) ? JSON.parse(fs.readFileSync(OUTPUT, 'utf8')) : null;
  const knownViews = new Map(
    previous && previous.popularity_period && previous.popularity_period.end === end.toISOString().slice(0, 10)
      ? previous.movies.filter((m) => m.popularity != null).map((m) => [m.wikidata_id, m.popularity])
      : []
  );
  if (knownViews.size) log.info('Reusing page views from the previous build for the same period', { movies: knownViews.size });

  const articles = await fetchWikipedia(picks.map(([title]) => title));
  const missing = picks.filter(([title]) => !articles.has(title)).map(([title]) => title);
  if (missing.length) log.warn('No Wikipedia article / Wikidata item found; skipping', { missing });

  const qids = [...new Set([...articles.values()].map((p) => p.pageprops.wikibase_item))];
  const facts = await fetchWikidata(qids);
  const posterFiles = [...new Set([...facts.values()].map((f) => f.posterFile).filter(Boolean))];
  const posters = await fetchPosters(posterFiles);

  const movies = [];
  const problems = [];
  for (const [articleTitle, expectedYear, displayGenre, tags = []] of picks) {
    const page = articles.get(articleTitle);
    if (!page) continue;
    const qid = page.pageprops.wikibase_item;
    const fact = facts.get(qid);
    // A few items have no English label in Wikidata; the Wikipedia article title is the same name.
    if (fact && !fact.title) fact.title = page.title.replace(/ ([^)]*)$/, '');
    if (!fact || !fact.title) {
      problems.push(`${articleTitle}: no Wikidata facts`);
      continue;
    }
    if (fact.year && Math.abs(fact.year - expectedYear) > 1) {
      problems.push(`${articleTitle}: Wikidata year ${fact.year}, expected about ${expectedYear}; skipped (wrong article?)`);
      continue;
    }
    const genres = mapGenres([...fact.genreLabels, ...fact.kindLabels]);
    const genre = genres.includes(displayGenre) ? displayGenre : genres[0] || null;
    let popularity = knownViews.has(qid) ? knownViews.get(qid) : null;
    try {
      if (popularity === null) popularity = await fetchPageviews(page.title, ymd(start), ymd(end));
    } catch (err) {
      log.warn('No page views for this film, so it won\'t rank in "Popular right now"', { title: page.title, error: err.message });
    }
    if (!knownViews.has(qid)) await sleep(400);
    const poster = fact.posterFile && posters.get(fact.posterFile);

    movies.push({
      wikidata_id: qid,
      tmdb_id: fact.tmdbId,
      imdb_id: fact.imdbId,
      title: fact.title,
      year: fact.year,
      genre,
      genres,
      directors: fact.directors.slice(0, 3),
      runtime: fact.runtime && fact.runtime >= 30 && fact.runtime <= 400 ? fact.runtime : null,
      overview: trimExtract(page.extract),
      overview_source: page.fullurl,
      poster_url: poster ? poster.url : null,
      poster_page: poster ? poster.page : null,
      poster_credit: poster ? poster.credit : null,
      popularity,
      tags,
    });
  }

  const seen = new Set();
  const unique = movies.filter((m) => !seen.has(m.wikidata_id) && seen.add(m.wikidata_id));
  const output = {
    version: 1,
    generated_at: new Date().toISOString(),
    popularity_period: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), source: 'English Wikipedia page views' },
    sources: {
      facts: 'Wikidata (CC0), https://www.wikidata.org',
      descriptions: 'English Wikipedia (CC BY-SA 4.0), linked per movie in overview_source',
      posters: 'Wikimedia Commons, credited per movie in poster_credit',
    },
    movies: unique,
  };
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + '\n');

  problems.forEach((p) => log.warn(p));
  log.info('Catalog written', {
    file: path.relative(process.cwd(), OUTPUT),
    movies: unique.length,
    withTmdbId: unique.filter((m) => m.tmdb_id).length,
    withPoster: unique.filter((m) => m.poster_url).length,
    withoutGenre: unique.filter((m) => !m.genre).map((m) => m.title),
  });
}

main().catch((err) => {
  log.error('Catalog build failed', { error: err });
  process.exit(1);
});
