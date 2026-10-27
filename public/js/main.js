// Watchlist page: state, data loading, the watchlist view, and every movie action
// (add, mark watched, move to Recently Deleted, restore, delete forever).
// Recently Deleted rendering lives in trash.js and TMDB search in discover.js.
const state = {
  movies: [],            // active watchlist
  moviesStatus: 'loading', // 'loading' | 'ready' | 'error'
  deleted: [],           // Recently Deleted
  deletedStatus: 'loading', // 'loading' | 'ready' | 'error'
  filter: 'all',
  query: '',
  sort: 'added-desc',
  view: 'watchlist',
  pending: new Set(),    // movie ids with a request in flight
  adding: false,
};

const watchLog = createClientLogger('Watchlist');

const FILTERS = {
  all: { heading: 'All movies', test: () => true },
  unwatched: { heading: 'To watch', test: (m) => !m.watched },
  watched: { heading: 'Watched', test: (m) => m.watched },
};

// ISO dates sort as text; ids (MongoDB ObjectIds) break ties in creation order.
const byAdded = (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
const byYear = (a, b) => (a.year ?? Infinity) - (b.year ?? Infinity) || a.title.localeCompare(b.title);
const SORTS = {
  'added-desc': (a, b) => byAdded(b, a),
  'added-asc': byAdded,
  'title-asc': (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }),
  'year-desc': (a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity) || a.title.localeCompare(b.title),
  'year-asc': byYear,
};
const SORT_STORAGE_KEY = 'movienight.sort';

const MIN_YEAR = 1888;
const MAX_YEAR = new Date().getFullYear() + 10;

const els = {
  currentUser: document.getElementById('current-user'),
  userInitial: document.getElementById('user-initial'),
  logoutButton: document.getElementById('logout-btn'),
  navLinks: document.querySelectorAll('.nav-link'),
  deletedCount: document.getElementById('nav-deleted-count'),
  viewWatchlist: document.getElementById('view-watchlist'),
  viewDeleted: document.getElementById('view-deleted'),
  summary: document.getElementById('summary'),
  statUnwatched: document.getElementById('stat-unwatched'),
  statWatched: document.getElementById('stat-watched'),
  statTotal: document.getElementById('stat-total'),
  progressBar: document.getElementById('progress-bar'),
  progressLabel: document.getElementById('progress-label'),
  addForm: document.getElementById('add-form'),
  addButton: document.getElementById('add-btn'),
  addMessage: document.getElementById('add-message'),
  resultsHeading: document.getElementById('results-heading'),
  resultsCount: document.getElementById('results-count'),
  listSearch: document.getElementById('list-search'),
  sortSelect: document.getElementById('sort'),
  listState: document.getElementById('list-state'),
  list: document.getElementById('movie-list'),
  filters: document.querySelectorAll('[data-filter]'),
  dialog: document.getElementById('confirm-dialog'),
  dialogTitle: document.getElementById('confirm-title'),
  dialogText: document.getElementById('confirm-text'),
  dialogConfirm: document.getElementById('confirm-ok'),
  credits: document.getElementById('credits'),
};

// A session that expired while the page was open: send the user to log in again.
function handleError(error, prefix = '') {
  if (error.status === 401) {
    watchLog.warn('Session expired; redirecting to login');
    window.location.href = '/login.html';
    return;
  }
  toast(prefix ? `${prefix} ${error.message}` : error.message, 'error');
}

// ---------- Lookups ----------

const sameTitle = (a, b) => a.title.trim().toLowerCase() === b.title.trim().toLowerCase();
// Same rules as the server: same catalog entry, same TMDB id, or same title and year.
const isSameMovie = (a, b) =>
  (a.catalog_id && b.catalog_id && a.catalog_id === b.catalog_id) ||
  (a.tmdb_id && b.tmdb_id && a.tmdb_id === b.tmdb_id) ||
  (sameTitle(a, b) && (a.year || null) === (b.year || null));

// Used by the add form and search results to avoid adding the same movie twice.
function findActiveMatch(candidate) {
  return state.movies.find((m) => isSameMovie(m, candidate));
}
function findDeletedMatch(candidate) {
  return state.deleted.find((m) => isSameMovie(m, candidate));
}

function visibleMovies() {
  const query = state.query.trim().toLowerCase();
  return state.movies
    .filter(FILTERS[state.filter].test)
    .filter((m) => !query || [m.title, m.genre, m.year].some((field) => field && String(field).toLowerCase().includes(query)))
    .sort(SORTS[state.sort]);
}

// ---------- Rendering: watchlist ----------

function renderSummary() {
  const watched = state.movies.filter((m) => m.watched).length;
  const counts = { all: state.movies.length, watched, unwatched: state.movies.length - watched };

  els.statUnwatched.textContent = counts.unwatched;
  els.statWatched.textContent = counts.watched;
  els.statTotal.textContent = counts.all;
  els.filters.forEach((b) => { b.querySelector('.filter-count').textContent = counts[b.dataset.filter]; });

  const percent = counts.all ? Math.round((counts.watched / counts.all) * 100) : 0;
  els.progressBar.style.width = `${percent}%`;
  els.progressLabel.textContent = counts.all ? `${percent}% of your list watched` : 'Your progress will show up here.';

  els.summary.replaceChildren();
  if (counts.all === 0) {
    els.summary.textContent = "Nothing on the list yet. Add a movie you've been meaning to see.";
  } else if (counts.unwatched === 0) {
    els.summary.textContent = "All caught up: you've watched every movie on your list.";
  } else {
    const next = state.movies.filter((m) => !m.watched).sort(SORTS['added-desc'])[0];
    els.summary.append(`${plural(counts.unwatched, 'movie')} waiting for movie night. Up next: `, el('strong', null, next.title), '.');
  }
}

function createCard(movie) {
  const li = el('li', `movie-card${movie.watched ? ' is-watched' : ''}`);
  li.dataset.id = movie.id;
  const busy = state.pending.has(movie.id);

  const frame = createPosterFrame(movie);
  if (movie.watched) {
    const stamp = el('span', 'poster-stamp');
    stamp.append(icon('check'), el('span', 'stamp-label', 'Watched'));
    frame.appendChild(stamp);
  }

  const body = el('div', 'movie-body');
  const meta = el('p', 'movie-meta');
  const details = [movie.year, movie.genre].filter(Boolean);
  if (details.length) details.forEach((detail) => meta.appendChild(el('span', null, String(detail))));
  else meta.appendChild(el('span', null, 'No year or genre'));

  const status = el('p', 'movie-status');
  status.append(icon(movie.watched ? 'check' : 'clock'), movie.watched ? 'Watched' : 'To watch');

  const toggleText = movie.watched ? 'Mark unwatched' : 'Mark watched';
  const toggle = button(`btn toggle-btn ${movie.watched ? 'btn-secondary' : 'btn-accent'}`, toggleText, {
    iconName: movie.watched ? 'undo' : 'check',
    label: `${toggleText}: ${movie.title}`,
    onClick: () => toggleWatched(movie),
  });
  const remove = button('btn btn-danger-outline icon-btn remove-btn', null, {
    iconName: 'trash',
    label: `Remove ${movie.title}`,
    onClick: () => deleteMovie(movie),
  });
  remove.title = 'Move to Recently Deleted';
  if (busy) [toggle, remove].forEach((b) => b.setAttribute('aria-disabled', 'true'));

  const actions = el('div', 'movie-actions');
  actions.append(toggle, remove);

  body.append(el('h3', 'movie-title', movie.title), meta);
  if (movie.overview) body.appendChild(el('p', 'movie-overview', movie.overview));
  const added = formatDate(movie.created_at);
  if (added) body.appendChild(el('p', 'movie-added', `Added ${added}`));
  body.append(status, actions);
  li.append(frame, body);
  return li;
}

function renderWatchlistState(visibleCount) {
  const query = state.query.trim();
  let content = null;

  if (state.movies.length === 0) {
    // An empty watchlist points straight at real movies to pick from.
    content = createEmptyState({
      heading: 'Your lineup is empty',
      text: 'Your watchlist is for movies you choose: ones you want to see and ones you’ve already watched. Pick a few to get started, or browse the whole catalog.',
      actions: [
        { label: 'Browse Discover', primary: true, onClick: () => showView('discover', { focus: true }) },
        { label: 'Add a movie yourself', onClick: focusAddPanel },
      ],
    });
    const picks = createWatchlistPicks();
    if (picks) content.appendChild(picks);
  } else if (visibleCount === 0 && query) {
    const actions = [{ label: 'Clear search', onClick: clearListSearch }];
    if (isDiscoverEnabled()) actions.unshift({ label: `Search TMDB for “${query}”`, primary: true, onClick: () => searchTmdbFor(query) });
    content = createEmptyState({
      heading: `No matches for “${query}”`,
      text:
        state.filter === 'all'
          ? "Nothing on your watchlist matches that. Check the spelling, or find it and add it."
          : `Nothing in “${FILTERS[state.filter].heading}” matches that. It might be under a different filter.`,
      actions,
    });
  } else if (visibleCount === 0 && state.filter === 'unwatched') {
    content = createEmptyState({
      heading: "You're all caught up",
      text: 'Every movie on your list is marked watched. Add something new for your next movie night.',
      actions: [
        { label: 'Find something new', primary: true, onClick: () => showView('discover', { focus: true }) },
        { label: 'Show all movies', onClick: () => showFilter('all') },
      ],
    });
  } else if (visibleCount === 0 && state.filter === 'watched') {
    content = createEmptyState({
      heading: 'Nothing watched yet',
      text: "When you finish a movie, mark it watched and it'll land here.",
      actions: [{ label: 'Show what to watch', onClick: () => showFilter('unwatched') }],
    });
  }

  if (content) els.listState.replaceChildren(content);
  else els.listState.replaceChildren();
}

function renderWatchlist() {
  // Until the watchlist arrives, leave the loading (or error) message alone.
  if (state.moviesStatus !== 'ready') return;
  renderSummary();
  const visible = visibleMovies();
  els.resultsHeading.firstChild.textContent = `${FILTERS[state.filter].heading} `;
  els.resultsCount.textContent = `(${visible.length})`;
  els.list.replaceChildren(...visible.map(createCard));
  els.list.hidden = visible.length === 0;
  renderWatchlistState(visible.length);
}

function renderNavCount() {
  els.deletedCount.textContent = state.deleted.length ? String(state.deleted.length) : '';
}

function render() {
  renderWatchlist();
  renderTrash();
  renderNavCount();
  document.dispatchEvent(new CustomEvent('watchlist:changed'));
}

// After a card is re-rendered or removed, keep keyboard focus somewhere sensible:
// the same card if it's still visible, otherwise the card that took its place.
function restoreFocus(movieId, index) {
  if (document.activeElement !== document.body && !els.list.contains(document.activeElement)) return;
  const card = els.list.querySelector(`[data-id="${movieId}"]`);
  const cards = els.list.querySelectorAll('.movie-card');
  const target = card || cards[Math.min(index, cards.length - 1)];
  if (target) target.querySelector('.toggle-btn').focus();
  else els.resultsHeading.focus();
}

function cardIndex(movieId) {
  return [...els.list.querySelectorAll('.movie-card')].findIndex((c) => c.dataset.id === String(movieId));
}

function showFilter(filter) {
  state.filter = filter;
  els.filters.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
  renderWatchlist();
}

function clearListSearch() {
  els.listSearch.value = '';
  state.query = '';
  renderWatchlist();
  els.listSearch.focus();
}

function focusAddPanel() {
  showView('watchlist');
  const target = isDiscoverEnabled() && !document.getElementById('tmdb-search').hidden ? document.getElementById('discover-q') : els.addForm.title;
  target.scrollIntoView({ block: 'center' });
  target.focus();
}

// Shows a movie's card: switches to the watchlist, clears anything hiding it, and focuses it.
function revealMovie(movieId) {
  showView('watchlist');
  let card = els.list.querySelector(`[data-id="${movieId}"]`);
  if (!card) {
    state.query = '';
    els.listSearch.value = '';
    showFilter('all');
    card = els.list.querySelector(`[data-id="${movieId}"]`);
  }
  if (!card) return;
  card.scrollIntoView({ block: 'center' });
  card.classList.add('is-highlighted');
  setTimeout(() => card.classList.remove('is-highlighted'), 1800);
  card.querySelector('.toggle-btn').focus();
}

// ---------- Views ----------

const VIEWS = {
  watchlist: { hash: '#watchlist', title: 'My Watchlist · Movie Night' },
  discover: { hash: '#discover', title: 'Discover · Movie Night' },
  deleted: { hash: '#deleted', title: 'Recently Deleted · Movie Night' },
};

function viewFromHash() {
  return Object.keys(VIEWS).find((view) => VIEWS[view].hash === location.hash) || 'watchlist';
}

function showView(view, { focus = false } = {}) {
  if (!VIEWS[view]) view = 'watchlist';
  if (location.hash !== VIEWS[view].hash) history.replaceState(null, '', VIEWS[view].hash);
  state.view = view;
  for (const name of Object.keys(VIEWS)) document.getElementById(`view-${name}`).hidden = name !== view;
  els.navLinks.forEach((link) => {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.title = VIEWS[view].title;
  if (focus) {
    window.scrollTo(0, 0);
    document.querySelector(`#view-${view} .view-heading`).focus();
  }
}

// ---------- Data loading ----------

async function loadUser() {
  const { user } = await apiRequest('/api/auth/me', { operation: 'load current user' });
  els.currentUser.textContent = user.username;
  els.userInitial.textContent = user.username.charAt(0);
}

async function loadMovies() {
  state.moviesStatus = 'loading';
  els.list.hidden = true;
  els.listState.replaceChildren(createLoading('Loading your watchlist…'));
  els.list.setAttribute('aria-busy', 'true');
  try {
    const { movies } = await apiRequest('/api/movies', { operation: 'load watchlist' });
    if (!Array.isArray(movies)) throw Object.assign(new Error('The server sent an unexpected watchlist.'), { status: 200 });
    state.movies = movies;
    state.moviesStatus = 'ready';
    watchLog.debug('Watchlist loaded', { count: movies.length });
    render();
    // Opened without a view in the URL and nothing saved yet: start on Discover, not an empty list.
    if (state.chooseLandingView) {
      state.chooseLandingView = false;
      if (movies.length === 0) showView('discover');
    }
  } catch (error) {
    state.moviesStatus = 'error';
    throw error;
  } finally {
    els.list.removeAttribute('aria-busy');
  }
}

async function loadDeleted() {
  state.deletedStatus = 'loading';
  renderTrash();
  try {
    const { movies } = await apiRequest('/api/movies/deleted', { operation: 'load Recently Deleted' });
    state.deleted = movies;
    state.deletedStatus = 'ready';
  } catch (error) {
    if (error.status === 401) return handleError(error);
    state.deletedStatus = 'error';
    state.deletedError = error.message;
  }
  render();
}

function showLoadError(error) {
  watchLog.error('Could not load the watchlist', { status: error.status, requestId: error.requestId, error: error.message });
  els.summary.textContent = "We couldn't load your movies.";
  els.listState.replaceChildren(
    createEmptyState({
      heading: "We couldn't load your watchlist",
      text: error.message,
      role: 'alert',
      actions: [{ label: 'Try again', primary: true, onClick: () => loadMovies().catch(showLoadError) }],
    })
  );
}

// ---------- Actions ----------

// Validates the manual add form. Returns a list of [input, message] problems.
function validateAddForm(form) {
  const problems = [];
  const title = form.title.value.trim();
  const year = form.year.value.trim();

  if (!title) problems.push([form.title, 'Enter a movie title.']);
  if (year && (!/^\d{4}$/.test(year) || Number(year) < MIN_YEAR || Number(year) > MAX_YEAR)) {
    problems.push([form.year, `Enter a 4-digit year from ${MIN_YEAR} to ${MAX_YEAR}, or leave it blank.`]);
  }
  if (title && !problems.length) {
    const candidate = { title, year: year ? Number(year) : null };
    const active = findActiveMatch(candidate);
    const deleted = !active && findDeletedMatch(candidate);
    if (active) problems.push([form.title, `${movieLabel(active)} is already on your watchlist.`]);
    else if (deleted) problems.push([form.title, `${movieLabel(deleted)} is in Recently Deleted. Restore it from there instead of adding it again.`]);
  }
  return problems;
}

// Creates a movie (from the manual form or a search result) and adds it to the page.
async function createMovie(payload) {
  try {
    const { movie } = await apiRequest('/api/movies', { method: 'POST', body: payload, operation: 'add movie' });
    state.movies.unshift(movie);
    if (state.filter === 'watched') showFilter('all');
    render();
    toast(`Added “${movie.title}” to your watchlist.`);
    return movie;
  } catch (error) {
    watchLog.warn('Could not add movie', { title: payload.title, status: error.status, requestId: error.requestId, error: error.message });
    // The server found a duplicate this page didn't know about (e.g. added in another tab): resync.
    if (error.status === 409) loadMovies().catch(showLoadError);
    throw error;
  }
}

async function addMovieFromForm(event) {
  event.preventDefault();
  if (state.adding) return;
  const form = els.addForm;
  els.addMessage.textContent = '';
  [form.title, form.year, form.genre].forEach(clearFieldError);

  const problems = validateAddForm(form);
  if (problems.length) {
    problems.forEach(([input, message]) => setFieldError(input, message));
    problems[0][0].focus();
    return;
  }

  const payload = { title: form.title.value.trim() };
  if (form.year.value.trim()) payload.year = Number(form.year.value.trim());
  if (form.genre.value.trim()) payload.genre = form.genre.value.trim();

  state.adding = true;
  setButtonBusy(els.addButton, true, 'Adding…');
  try {
    await createMovie(payload);
    form.reset();
    form.title.focus();
  } catch (error) {
    if (error.status === 401) return handleError(error);
    els.addMessage.textContent = `Couldn't add that movie. ${error.message}`;
  } finally {
    state.adding = false;
    setButtonBusy(els.addButton, false);
  }
}

// Marks a card's buttons busy in place (aria-disabled rather than disabled,
// so the focused button keeps focus while the request runs).
function setCardBusy(movieId) {
  state.pending.add(movieId);
  const card = els.list.querySelector(`[data-id="${movieId}"]`);
  if (card) card.querySelectorAll('button').forEach((b) => b.setAttribute('aria-disabled', 'true'));
}

async function toggleWatched(movie) {
  if (state.pending.has(movie.id)) return;
  const index = cardIndex(movie.id);
  setCardBusy(movie.id);
  try {
    const { movie: updated } = await apiRequest(`/api/movies/${movie.id}`, {
      method: 'PATCH',
      body: { watched: !movie.watched },
      operation: movie.watched ? 'mark movie unwatched' : 'mark movie watched',
    });
    state.movies = state.movies.map((m) => (m.id === updated.id ? updated : m));
    toast(updated.watched ? `Marked “${updated.title}” as watched.` : `Moved “${updated.title}” back to your list.`);
  } catch (error) {
    handleError(error, `Couldn't update “${movie.title}”.`);
    if (error.status === 404) loadMovies().catch(showLoadError);
  } finally {
    state.pending.delete(movie.id);
    render();
    restoreFocus(movie.id, index);
  }
}

// Normal delete: reversible, so there's no confirmation step, just an Undo.
async function deleteMovie(movie) {
  if (state.pending.has(movie.id)) return;
  const index = cardIndex(movie.id);
  setCardBusy(movie.id);
  try {
    const { movie: deleted } = await apiRequest(`/api/movies/${movie.id}`, { method: 'DELETE', operation: 'move movie to Recently Deleted' });
    state.movies = state.movies.filter((m) => m.id !== movie.id);
    state.deleted.unshift(deleted || { ...movie, deleted_at: new Date().toISOString() });
    toast(`Moved “${movie.title}” to Recently Deleted.`, 'success', {
      action: { label: 'Undo', hint: 'You can restore it from Recently Deleted.', onClick: () => restoreMovie(movie.id, { focusCard: true }) },
    });
  } catch (error) {
    handleError(error, `Couldn't remove “${movie.title}”.`);
    if (error.status === 404) loadMovies().catch(showLoadError);
  } finally {
    state.pending.delete(movie.id);
    render();
    restoreFocus(movie.id, index);
  }
}

// Returns true if the movie came back. Used by Recently Deleted, Undo, and search results.
async function restoreMovie(movieId, { focusCard = false } = {}) {
  const movie = state.deleted.find((m) => m.id === movieId);
  if (!movie || state.pending.has(movieId)) return false;
  state.pending.add(movieId);
  renderTrash();
  try {
    const { movie: restored } = await apiRequest(`/api/movies/${movieId}/restore`, { method: 'POST', operation: 'restore movie' });
    state.deleted = state.deleted.filter((m) => m.id !== movieId);
    state.movies.unshift(restored);
    state.pending.delete(movieId);
    render();
    toast(`Restored “${restored.title}” to your watchlist.`);
    if (focusCard && state.view === 'watchlist') revealMovie(restored.id);
    return true;
  } catch (error) {
    state.pending.delete(movieId);
    if (error.status === 401) {
      handleError(error);
      return false;
    }
    toast(`Couldn't restore “${movie.title}”. ${error.message}`, 'error');
    // 404: it's gone (another tab deleted it forever). Either way, resync the list.
    if (error.status === 404) loadDeleted();
    else render();
    return false;
  }
}

async function restoreAllMovies() {
  const restoreAllButton = document.getElementById('restore-all-btn');
  setButtonBusy(restoreAllButton, true, 'Restoring…');
  try {
    const { restored, skipped } = await apiRequest('/api/movies/deleted/restore-all', { method: 'POST', operation: 'restore all movies' });
    const restoredIds = new Set(restored.map((m) => m.id));
    state.deleted = state.deleted.filter((m) => !restoredIds.has(m.id));
    state.movies.unshift(...restored);
    render();
    if (restored.length) toast(`Restored ${plural(restored.length, 'movie')} to your watchlist.`);
    if (skipped.length) {
      toast(`${plural(skipped.length, 'movie')} stayed here because ${skipped.length === 1 ? 'it is' : 'they are'} already on your watchlist.`, 'error');
    }
  } catch (error) {
    handleError(error, "Couldn't restore your movies.");
  } finally {
    setButtonBusy(restoreAllButton, false);
    if (!state.deleted.length) document.getElementById('deleted-heading').focus();
  }
}

// Native <dialog> traps focus, closes on Escape, and returns focus to the opener.
function confirmAction({ title, text, confirmLabel }) {
  els.dialogTitle.textContent = title;
  els.dialogText.textContent = text;
  els.dialogConfirm.textContent = confirmLabel;
  els.dialog.returnValue = '';
  els.dialog.showModal();
  return new Promise((resolve) => {
    els.dialog.addEventListener('close', () => resolve(els.dialog.returnValue === 'confirm'), { once: true });
  });
}

async function purgeMovie(movieId) {
  const movie = state.deleted.find((m) => m.id === movieId);
  if (!movie || state.pending.has(movieId)) return;
  const confirmed = await confirmAction({
    title: `Delete “${movie.title}” forever?`,
    text: "This removes it from Movie Night completely. You won't be able to restore it.",
    confirmLabel: 'Delete forever',
  });
  if (!confirmed) return;

  const index = trashIndex(movieId);
  state.pending.add(movieId);
  renderTrash();
  try {
    await apiRequest(`/api/movies/${movieId}/permanent`, { method: 'DELETE', operation: 'permanently delete movie' });
    state.deleted = state.deleted.filter((m) => m.id !== movieId);
    toast(`Deleted “${movie.title}” forever.`);
  } catch (error) {
    handleError(error, `Couldn't delete “${movie.title}”.`);
    if (error.status === 404) loadDeleted();
  } finally {
    state.pending.delete(movieId);
    render();
    focusTrashItem(index);
  }
}

async function logout() {
  setButtonBusy(els.logoutButton, true, 'Logging out…');
  try {
    await apiRequest('/api/auth/logout', { method: 'POST', operation: 'log out' });
    window.location.href = '/login.html';
  } catch (error) {
    setButtonBusy(els.logoutButton, false);
    handleError(error, "Couldn't log out.");
  }
}

// ---------- Wiring ----------

function init() {
  try {
    const savedSort = localStorage.getItem(SORT_STORAGE_KEY);
    if (SORTS[savedSort]) state.sort = savedSort;
  } catch {}
  els.sortSelect.value = state.sort;

  els.addForm.addEventListener('submit', addMovieFromForm);
  els.addForm.addEventListener('input', (event) => {
    if (event.target.getAttribute('aria-invalid')) clearFieldError(event.target);
  });
  els.logoutButton.addEventListener('click', logout);

  els.filters.forEach((b) => {
    b.addEventListener('click', () => {
      showFilter(b.dataset.filter);
      announce(`Showing ${FILTERS[state.filter].heading.toLowerCase()}: ${plural(visibleMovies().length, 'movie')}.`);
    });
  });

  let searchTimer;
  els.listSearch.addEventListener('input', () => {
    state.query = els.listSearch.value;
    renderWatchlist();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const count = visibleMovies().length;
      announce(state.query.trim() ? `${plural(count, 'movie')} match “${state.query.trim()}”.` : `Showing ${plural(count, 'movie')}.`);
    }, 700);
  });

  els.sortSelect.addEventListener('change', () => {
    state.sort = SORTS[els.sortSelect.value] ? els.sortSelect.value : 'added-desc';
    try { localStorage.setItem(SORT_STORAGE_KEY, state.sort); } catch {}
    renderWatchlist();
  });

  window.addEventListener('hashchange', () => showView(viewFromHash(), { focus: true }));
  state.chooseLandingView = !location.hash;
  showView(viewFromHash());

  setupThemeSettings();
  setupTrash();
  setupDiscover();
  setupCatalog();

  loadUser().catch(handleError);
  loadThemePreference().catch(handleError);
  loadMovies().catch((error) => (error.status === 401 ? handleError(error) : showLoadError(error)));
  loadDeleted();
  loadCatalog();
}

document.addEventListener('DOMContentLoaded', init);
