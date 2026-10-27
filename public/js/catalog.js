// Discover page: browse the shared movie catalog (real films from Wikidata/Wikipedia, see
// database/catalog.json) and add them to your own watchlist with one click.
// Also provides the starter pack and the "picks" shown on an empty watchlist.
const catalogLog = createClientLogger('Discover');
const catalog = {
  movies: [],
  info: null,
  status: 'loading', // 'loading' | 'ready' | 'error'
  error: '',
  genre: '',
  decade: '',
  query: '',
};

const SHELF_SIZE = 14;
const catalogEls = {
  summary: document.getElementById('catalog-summary'),
  starterPanel: document.getElementById('starter-panel'),
  starterText: document.getElementById('starter-text'),
  starterButton: document.getElementById('starter-btn'),
  search: document.getElementById('catalog-search'),
  genres: document.getElementById('genre-chips'),
  decades: document.getElementById('decade-chips'),
  results: document.getElementById('explore-results'),
  resultsHeading: document.getElementById('explore-results-heading'),
  resultsGrid: document.getElementById('explore-results-grid'),
  resultsState: document.getElementById('explore-results-state'),
  shelves: document.getElementById('explore-shelves'),
  sources: document.getElementById('catalog-sources'),
  movieDialog: document.getElementById('movie-dialog'),
  starterDialog: document.getElementById('starter-dialog'),
  starterList: document.getElementById('starter-list'),
  starterSubmit: document.getElementById('starter-submit'),
};

const decadeOf = (movie) => (movie.year ? Math.floor(movie.year / 10) * 10 : null);
const byPopularity = (a, b) => (b.popularity ?? -1) - (a.popularity ?? -1) || a.title.localeCompare(b.title);
const hasGenre = (...names) => (movie) => names.some((name) => movie.genres.includes(name));
const asCandidate = (movie) => ({ catalog_id: movie.id, tmdb_id: movie.tmdb_id, title: movie.title, year: movie.year });
const catalogMeta = (movie) => [movie.year, movie.genre].filter(Boolean).join(' · ');

function formatPeriod(info) {
  const period = info && info.popularity_period;
  if (!period) return '';
  const fmt = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${fmt(period.start)} – ${fmt(period.end)}`;
}

// Shelves are built from the catalog data itself; a shelf with fewer than 4 movies isn't shown.
function buildShelves(movies) {
  const newest = Math.max(...movies.map((m) => m.year || 0));
  const period = formatPeriod(catalog.info);
  return [
    {
      id: 'popular', title: 'Popular right now',
      caption: period ? `Most-read on Wikipedia, ${period}.` : 'Most-read on Wikipedia recently.',
      movies: movies.filter((m) => m.popularity != null).sort(byPopularity),
    },
    { id: 'recent', title: 'Recently released', caption: `From ${newest - 2} to ${newest}.`, movies: movies.filter((m) => m.year >= newest - 2).sort((a, b) => b.year - a.year || byPopularity(a, b)) },
    { id: 'horror', title: 'Horror picks', genre: 'Horror', movies: movies.filter(hasGenre('Horror')).sort(byPopularity) },
    { id: 'scifi', title: 'Science fiction', genre: 'Sci-Fi', movies: movies.filter(hasGenre('Sci-Fi')).sort(byPopularity) },
    { id: 'animation', title: 'Animated favorites', genre: 'Animation', movies: movies.filter(hasGenre('Animation')).sort(byPopularity) },
    { id: 'classics', title: 'Classics worth watching', caption: 'Made before 1970 and still worth a movie night.', movies: movies.filter((m) => m.year && m.year < 1970).sort(byPopularity) },
    { id: 'romance', title: 'Love stories', genre: 'Romance', movies: movies.filter(hasGenre('Romance')).sort(byPopularity) },
    { id: 'comedy', title: 'Comedies', genre: 'Comedy', movies: movies.filter(hasGenre('Comedy')).sort(byPopularity) },
    { id: 'crime', title: 'Mystery & crime', genre: 'Crime', movies: movies.filter(hasGenre('Crime', 'Mystery')).sort(byPopularity) },
    { id: 'action', title: 'Action & adventure', genre: 'Action', movies: movies.filter(hasGenre('Action', 'Adventure')).sort(byPopularity) },
    {
      id: 'gems', title: 'Hidden gems',
      caption: 'Films from this catalog that the fewest people are reading about right now.',
      movies: movies.filter((m) => m.popularity != null && m.year >= 1980).sort((a, b) => a.popularity - b.popularity),
    },
    { id: 'drama', title: 'Drama', genre: 'Drama', movies: movies.filter(hasGenre('Drama')).sort(byPopularity) },
  ].filter((shelf) => shelf.movies.length >= 4);
}

// ---------- Cards and actions ----------

// Add / On your list / Restore, matching the movie against the user's watchlist and trash.
function catalogAction(movie, { compact = false } = {}) {
  const candidate = asCandidate(movie);
  const active = findActiveMatch(candidate);
  const size = compact ? ' btn-sm' : '';
  if (active) {
    return button(`btn catalog-action result-on-list${size}`, 'On your list', {
      iconName: 'check',
      label: `${movieLabel(movie)} is on your watchlist. Show it`,
      onClick: () => revealMovie(active.id),
    });
  }
  const deleted = findDeletedMatch(candidate);
  if (deleted) {
    return button(`btn btn-secondary catalog-action${size}`, 'Restore', {
      iconName: 'undo',
      label: `Restore ${movieLabel(movie)} from Recently Deleted`,
      onClick: (event) => restoreFromCatalog(deleted.id, event.currentTarget),
    });
  }
  return button(`btn btn-accent catalog-action${size}`, compact ? 'Add' : 'Add to watchlist', {
    iconName: 'plus',
    label: `Add ${movieLabel(movie)} to your watchlist`,
    onClick: (event) => addFromCatalog(movie, event.currentTarget),
  });
}

function createCatalogCard(movie, { compact = false } = {}) {
  const li = el('li', 'catalog-card');
  li.dataset.catalogId = movie.id;
  if (findActiveMatch(asCandidate(movie))) li.classList.add('is-saved');

  const open = button('catalog-open', null, { label: `${movieLabel(movie)}: details`, onClick: () => openMovieDialog(movie) });
  open.appendChild(createPosterFrame(movie, { size: 'w342' }));
  const body = el('div', 'catalog-body');
  const title = button('catalog-title', movie.title, { onClick: () => openMovieDialog(movie) });
  title.setAttribute('aria-haspopup', 'dialog');
  body.append(title, el('p', 'catalog-meta', catalogMeta(movie) || ' '), catalogAction(movie, { compact }));
  // The poster opens the same dialog; it's skipped by Tab so each card has one stop per action.
  open.tabIndex = -1;
  open.setAttribute('aria-hidden', 'true');
  li.append(open, body);
  return li;
}

function setActionBusy(actionButton, text) {
  actionButton.setAttribute('aria-disabled', 'true');
  actionButton.querySelector('span').textContent = text;
}

async function addFromCatalog(movie, actionButton) {
  if (actionButton.getAttribute('aria-disabled') === 'true') return;
  setActionBusy(actionButton, 'Adding…');
  try {
    await createMovie({ catalog_id: movie.id });
  } catch (error) {
    if (error.status === 401) return handleError(error);
    catalogLog.warn('Could not add catalog movie', { catalogId: movie.id, title: movie.title, status: error.status, requestId: error.requestId });
    toast(`Couldn't add “${movie.title}”. ${error.message}`, 'error');
    refreshCatalogActions();
  }
}

async function restoreFromCatalog(movieId, actionButton) {
  if (actionButton.getAttribute('aria-disabled') === 'true') return;
  setActionBusy(actionButton, 'Restoring…');
  if (!(await restoreMovie(movieId))) refreshCatalogActions();
}

// The watchlist changed: update every visible Add/On your list/Restore button in place,
// keeping keyboard focus on whichever one had it.
function refreshCatalogActions() {
  const byId = new Map(catalog.movies.map((m) => [String(m.id), m]));
  document.querySelectorAll('[data-catalog-id]').forEach((node) => {
    const movie = byId.get(node.dataset.catalogId);
    const current = node.querySelector('.catalog-action');
    if (!movie || !current) return;
    const hadFocus = current === document.activeElement;
    const next = catalogAction(movie, { compact: current.classList.contains('btn-sm') });
    current.replaceWith(next);
    if (node.classList.contains('catalog-card')) node.classList.toggle('is-saved', Boolean(findActiveMatch(asCandidate(movie))));
    if (hadFocus) next.focus();
  });
  renderStarterPanel();
}

// ---------- Details dialog ----------

function openMovieDialog(movie) {
  const dialog = catalogEls.movieDialog;
  dialog.dataset.catalogId = movie.id;
  document.getElementById('movie-dialog-poster').replaceChildren(createPosterFrame(movie, { size: 'w500' }));
  document.getElementById('movie-dialog-title').textContent = movie.title;

  const facts = [movie.year, movie.runtime ? `${movie.runtime} min` : null].filter(Boolean);
  if (movie.directors.length) facts.push(`Directed by ${movie.directors.join(', ')}`);
  document.getElementById('movie-dialog-meta').textContent = facts.join(' · ');

  const genres = document.getElementById('movie-dialog-genres');
  genres.replaceChildren(...movie.genres.map((g) => el('li', 'genre-tag', g)));
  genres.hidden = movie.genres.length === 0;

  document.getElementById('movie-dialog-overview').textContent = movie.overview || 'No description available yet.';

  const sources = document.getElementById('movie-dialog-source');
  sources.replaceChildren();
  if (movie.overview_source) {
    const link = el('a', null, movie.overview_source.name);
    link.href = movie.overview_source.url;
    link.target = '_blank';
    link.rel = 'noopener';
    sources.append('Description from ', link, '. ');
  }
  if (movie.poster_credit) {
    sources.append('Poster: ');
    if (movie.poster_page) {
      const link = el('a', null, movie.poster_credit);
      link.href = movie.poster_page;
      link.target = '_blank';
      link.rel = 'noopener';
      sources.append(link, '.');
    } else {
      sources.append(`${movie.poster_credit}.`);
    }
  }

  const actionSlot = document.getElementById('movie-dialog-action');
  actionSlot.replaceChildren(catalogAction(movie));
  actionSlot.dataset.catalogId = movie.id;
  dialog.showModal();
  catalogLog.debug('Opened movie details', { catalogId: movie.id, title: movie.title });
}

// ---------- Starter pack ----------

const starterMovies = () => catalog.movies.filter((m) => m.tags.includes('starter'));

function renderStarterPanel() {
  const starters = starterMovies();
  const remaining = starters.filter((m) => !findActiveMatch(asCandidate(m)));
  // Shown to people with a short (or empty) watchlist, while there's something left to add.
  catalogEls.starterPanel.hidden = catalog.status !== 'ready' || remaining.length === 0 || state.movies.length >= 5 || state.moviesStatus !== 'ready';
  catalogEls.starterText.textContent =
    `Your watchlist keeps track of the movies you want to see and the ones you’ve already watched. ` +
    `Start with ${plural(starters.length, 'well-loved film')} from across the catalog. You can preview them and choose which ones to add.`;
}

function updateStarterSubmit() {
  const count = catalogEls.starterList.querySelectorAll('input:checked:not(:disabled)').length;
  catalogEls.starterSubmit.disabled = count === 0;
  catalogEls.starterSubmit.querySelector('.btn-label').textContent = count ? `Add ${plural(count, 'movie')}` : 'Choose movies to add';
}

function openStarterDialog() {
  catalogEls.starterList.replaceChildren(
    ...starterMovies().map((movie) => {
      const onList = Boolean(findActiveMatch(asCandidate(movie)));
      const li = el('li', 'starter-item');
      const label = el('label', 'starter-option');
      const box = el('input');
      box.type = 'checkbox';
      box.value = movie.id;
      box.checked = true;
      box.disabled = onList;
      const thumb = createPosterFrame(movie, { size: 'w154', mini: true });
      thumb.classList.add('starter-thumb');
      const text = el('span', 'starter-text');
      text.append(el('span', 'starter-name', movie.title), el('span', 'starter-meta', onList ? `${catalogMeta(movie)} · already on your list` : catalogMeta(movie)));
      label.append(box, thumb, text);
      li.appendChild(label);
      return li;
    })
  );
  updateStarterSubmit();
  catalogEls.starterDialog.showModal();
  const firstChoice = catalogEls.starterList.querySelector('input:not(:disabled)');
  if (firstChoice) firstChoice.focus();
}

async function addStarterPack(event) {
  event.preventDefault();
  const ids = [...catalogEls.starterList.querySelectorAll('input:checked:not(:disabled)')].map((box) => box.value);
  if (!ids.length) return;
  setButtonBusy(catalogEls.starterSubmit, true, 'Adding…');
  try {
    const { added, skipped } = await apiRequest('/api/movies/bulk', { method: 'POST', body: { catalog_ids: ids }, operation: 'add starter pack' });
    state.movies.unshift(...added);
    render();
    catalogEls.starterDialog.close();
    const already = skipped.length ? ` ${skipped.length} ${skipped.length === 1 ? 'was' : 'were'} already there.` : '';
    toast(`Added ${plural(added.length, 'movie')} to your watchlist.${already}`);
    catalogLog.info('Starter pack added', { added: added.length, skipped: skipped.length });
  } catch (error) {
    if (error.status === 401) return handleError(error);
    toast(`Couldn't add the starter pack. ${error.message}`, 'error');
  } finally {
    setButtonBusy(catalogEls.starterSubmit, false);
    updateStarterSubmit();
  }
}

// ---------- Browsing: filters, search, shelves ----------

function createChip(label, value, group) {
  const chip = button('chip', label);
  chip.dataset.value = value;
  chip.setAttribute('aria-pressed', 'false');
  chip.addEventListener('click', () => {
    catalog[group] = catalog[group] === value ? '' : value;
    renderExplore({ announceResults: true });
  });
  return chip;
}

function renderChips() {
  const genreCounts = new Map();
  catalog.movies.forEach((m) => m.genres.forEach((g) => genreCounts.set(g, (genreCounts.get(g) || 0) + 1)));
  const genres = [...genreCounts].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).map(([g]) => g);
  catalogEls.genres.replaceChildren(createChip('All genres', '', 'genre'), ...genres.map((g) => createChip(g, g, 'genre')));

  const decades = [...new Set(catalog.movies.map(decadeOf).filter(Boolean))].sort((a, b) => a - b);
  catalogEls.decades.replaceChildren(createChip('Any decade', '', 'decade'), ...decades.map((d) => createChip(`${d}s`, String(d), 'decade')));
}

function syncChips() {
  catalogEls.genres.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.value === catalog.genre)));
  catalogEls.decades.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.value === catalog.decade)));
}

function filteredCatalog() {
  const query = catalog.query.trim().toLowerCase();
  return catalog.movies
    .filter((m) => !catalog.genre || m.genres.includes(catalog.genre))
    .filter((m) => !catalog.decade || String(decadeOf(m)) === catalog.decade)
    .filter((m) => !query || m.title.toLowerCase().includes(query) || m.directors.some((d) => d.toLowerCase().includes(query)) || String(m.year) === query)
    .sort(byPopularity);
}

function clearExploreFilters() {
  catalog.genre = '';
  catalog.decade = '';
  catalog.query = '';
  catalogEls.search.value = '';
  renderExplore();
  catalogEls.search.focus();
}

function renderShelves() {
  const shelves = buildShelves(catalog.movies).map((shelf) => {
    const section = el('section', 'shelf');
    const headingId = `shelf-${shelf.id}`;
    section.setAttribute('aria-labelledby', headingId);
    const header = el('div', 'shelf-header');
    const titles = el('div');
    const heading = el('h2', null, shelf.title);
    heading.id = headingId;
    titles.appendChild(heading);
    if (shelf.caption) titles.appendChild(el('p', 'shelf-caption', shelf.caption));
    header.appendChild(titles);
    if (shelf.genre && shelf.movies.length > SHELF_SIZE) {
      header.appendChild(button('btn btn-ghost btn-sm', `See all ${shelf.movies.length}`, {
        label: `See all ${shelf.movies.length} ${shelf.title.toLowerCase()}`,
        onClick: () => {
          catalog.genre = shelf.genre;
          renderExplore({ focusResults: true });
        },
      }));
    }
    const row = el('ul', 'shelf-row');
    row.append(...shelf.movies.slice(0, SHELF_SIZE).map((m) => createCatalogCard(m, { compact: true })));
    section.append(header, row);
    return section;
  });
  catalogEls.shelves.replaceChildren(...shelves);
}

function renderExplore({ announceResults = false, focusResults = false } = {}) {
  if (catalog.status !== 'ready') return;
  syncChips();
  const filtering = Boolean(catalog.genre || catalog.decade || catalog.query.trim());
  catalogEls.shelves.hidden = filtering;
  catalogEls.results.hidden = !filtering;
  if (!filtering) return;

  const matches = filteredCatalog();
  const parts = [catalog.genre, catalog.decade && `${catalog.decade}s`].filter(Boolean);
  const label = catalog.query.trim() ? `Results for “${catalog.query.trim()}”${parts.length ? ` in ${parts.join(' · ')}` : ''}` : parts.join(' · ');
  catalogEls.resultsHeading.firstChild.textContent = `${label} `;
  catalogEls.resultsHeading.querySelector('.results-count').textContent = `(${matches.length})`;
  catalogEls.resultsGrid.replaceChildren(...matches.map((m) => createCatalogCard(m)));
  catalogEls.resultsGrid.hidden = matches.length === 0;

  if (matches.length === 0) {
    const actions = [{ label: 'Clear filters', onClick: clearExploreFilters }];
    const query = catalog.query.trim();
    if (query && isDiscoverEnabled()) actions.unshift({ label: `Search TMDB for “${query}”`, primary: true, onClick: () => searchTmdbFor(query) });
    else if (query) actions.push({ label: `Add “${query}” yourself`, onClick: () => { focusAddPanel(); els.addForm.title.value = query; } });
    catalogEls.resultsState.replaceChildren(createEmptyState({
      heading: 'No movies match',
      text: query ? `Nothing in the catalog matches “${query}”${parts.length ? ' with those filters' : ''}.` : 'No catalog movies match that combination. Try another genre or decade.',
      actions,
    }));
  } else {
    catalogEls.resultsState.replaceChildren();
  }

  if (announceResults) announce(`${plural(matches.length, 'movie')} ${label ? `in ${label}` : ''}.`);
  if (focusResults) {
    catalogEls.results.scrollIntoView({ block: 'start' });
    catalogEls.resultsHeading.focus();
  }
}

// Used on the empty watchlist: a handful of starter movies with one-click Add buttons.
function createWatchlistPicks() {
  if (catalog.status !== 'ready') return null;
  const picks = starterMovies().filter((m) => !findActiveMatch(asCandidate(m))).slice(0, 6);
  if (!picks.length) return null;
  const box = el('div', 'watchlist-picks');
  const heading = el('h4', 'picks-heading', 'Picks to get you started');
  const row = el('ul', 'picks-row');
  row.append(...picks.map((m) => createCatalogCard(m, { compact: true })));
  box.append(heading, row);
  return box;
}

function renderCatalog() {
  if (catalog.status === 'loading') {
    catalogEls.shelves.replaceChildren(createLoading('Loading movies…'));
    return;
  }
  if (catalog.status === 'error') {
    catalogEls.summary.textContent = "We couldn't load the movie catalog.";
    catalogEls.shelves.replaceChildren(createEmptyState({
      heading: "We couldn't load Discover",
      text: catalog.error,
      role: 'alert',
      actions: [{ label: 'Try again', primary: true, onClick: loadCatalog }],
    }));
    return;
  }
  if (catalog.movies.length === 0) {
    catalogEls.summary.textContent = 'The movie catalog is empty.';
    catalogEls.shelves.replaceChildren(createEmptyState({
      heading: 'No movies in the catalog yet',
      text: 'Run "npm run catalog:seed" on the server to load the catalog, then reload this page.',
    }));
    return;
  }
  const genreCount = new Set(catalog.movies.flatMap((m) => m.genres)).size;
  const years = catalog.movies.map((m) => m.year).filter(Boolean);
  catalogEls.summary.textContent =
    `${catalog.movies.length} films across ${genreCount} genres, from ${Math.min(...years)} to ${Math.max(...years)}. ` +
    'Open any movie for details, and add the ones you want to your watchlist.';
  catalogEls.search.placeholder = `Search ${catalog.movies.length} movies by title, director, or year`;
  renderChips();
  renderShelves();
  renderStarterPanel();
  renderExplore();
  renderWatchlist(); // the empty-watchlist picks use the catalog
}

async function loadCatalog() {
  catalog.status = 'loading';
  renderCatalog();
  try {
    const data = await apiRequest('/api/catalog', { operation: 'load movie catalog' });
    if (!Array.isArray(data.movies)) throw new Error('The server sent an unexpected catalog.');
    catalog.movies = data.movies;
    catalog.info = data.info;
    catalog.status = 'ready';
    catalogLog.debug('Catalog loaded', { movies: data.movies.length });
  } catch (error) {
    if (error.status === 401) return handleError(error);
    catalogLog.error('Could not load the movie catalog', { status: error.status, requestId: error.requestId, error: error.message });
    catalog.status = 'error';
    catalog.error = error.message;
  }
  renderCatalog();
}

function setupCatalog() {
  let timer;
  catalogEls.search.addEventListener('input', () => {
    catalog.query = catalogEls.search.value;
    clearTimeout(timer);
    timer = setTimeout(() => renderExplore({ announceResults: true }), 250);
  });
  catalogEls.starterButton.addEventListener('click', openStarterDialog);
  catalogEls.starterList.addEventListener('change', updateStarterSubmit);
  document.getElementById('starter-form').addEventListener('submit', addStarterPack);
  document.getElementById('starter-cancel').addEventListener('click', () => catalogEls.starterDialog.close());
  document.addEventListener('watchlist:changed', refreshCatalogActions);
}
