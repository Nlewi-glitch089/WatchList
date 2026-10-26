// Movie search powered by TMDB, through the server's /api/discover routes (the API key never
// reaches the browser). If the server has no key, or search fails, manual entry still works.
const discoverLog = createClientLogger('Discover');
const discover = { enabled: false, results: [], controller: null, timer: null };

const discoverEls = {
  modeSwitch: document.getElementById('add-mode'),
  modeButtons: document.querySelectorAll('[data-mode]'),
  panel: document.getElementById('tmdb-search'),
  manual: document.getElementById('manual-add'),
  form: document.getElementById('discover-form'),
  input: document.getElementById('discover-q'),
  status: document.getElementById('discover-status'),
  fallback: document.getElementById('discover-fallback'),
  results: document.getElementById('discover-results'),
};

function isDiscoverEnabled() {
  return discover.enabled;
}

function setAddMode(mode) {
  const searching = mode === 'search' && discover.enabled;
  discoverEls.panel.hidden = !searching;
  discoverEls.manual.hidden = searching;
  discoverEls.modeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === (searching ? 'search' : 'manual'))));
}

function setSearchStatus(text, kind = '') {
  discoverEls.status.textContent = text;
  discoverEls.status.classList.toggle('is-loading', kind === 'loading');
  discoverEls.status.classList.toggle('is-error', kind === 'error');
}

// "Add it manually" button shown under empty or failed searches, prefilled with the query.
function showManualFallback(query) {
  const fallback = button('btn btn-secondary btn-sm', query ? `Add “${query}” manually` : 'Add a movie manually', {
    iconName: 'plus',
    onClick: () => {
      setAddMode('manual');
      if (query) els.addForm.title.value = query;
      els.addForm.title.focus();
    },
  });
  discoverEls.fallback.replaceChildren(fallback);
}

function resultAction(result) {
  const active = findActiveMatch(result);
  if (active) {
    return button('btn result-action result-on-list', 'On your list', {
      iconName: 'check',
      label: `${movieLabel(result)} is on your watchlist. Show it`,
      onClick: () => revealMovie(active.id),
    });
  }
  const deleted = findDeletedMatch(result);
  if (deleted) {
    return button('btn btn-secondary result-action', 'Restore', {
      iconName: 'undo',
      label: `Restore ${movieLabel(result)} from Recently Deleted`,
      onClick: (event) => restoreFromSearch(deleted.id, event.currentTarget),
    });
  }
  return button('btn btn-accent result-action', 'Add', {
    iconName: 'plus',
    label: `Add ${movieLabel(result)} to your watchlist`,
    onClick: (event) => addFromSearch(result, event.currentTarget),
  });
}

function createResult(result, index) {
  const li = el('li', 'result');
  li.dataset.index = index;
  const thumb = el('div', 'result-thumb');
  thumb.appendChild(createPosterFrame(result, { size: 'w154', mini: true }));

  const body = el('div', 'result-body');
  body.appendChild(el('p', 'result-title', result.title));
  const meta = [result.year, result.genre].filter(Boolean).join(' · ');
  if (meta) body.appendChild(el('p', 'result-meta', meta));
  if (result.overview) body.appendChild(el('p', 'result-overview', result.overview));
  body.appendChild(resultAction(result));

  li.append(thumb, body);
  return li;
}

// Watchlist changed (added, restored, deleted): update each result's button in place,
// keeping keyboard focus on it.
function refreshResultActions() {
  discoverEls.results.querySelectorAll('.result').forEach((li) => {
    const result = discover.results[Number(li.dataset.index)];
    const current = li.querySelector('.result-action');
    if (!result || !current) return;
    const hadFocus = current === document.activeElement;
    const next = resultAction(result);
    current.replaceWith(next);
    if (hadFocus) next.focus();
  });
}

function setResultBusy(actionButton, text) {
  actionButton.setAttribute('aria-disabled', 'true');
  actionButton.querySelector('span').textContent = text;
}

async function addFromSearch(result, actionButton) {
  if (actionButton.getAttribute('aria-disabled') === 'true') return;
  setResultBusy(actionButton, 'Adding…');
  const payload = { title: result.title, tmdb_id: result.tmdb_id };
  for (const field of ['year', 'genre', 'poster_path', 'overview']) {
    if (result[field]) payload[field] = result[field];
  }
  try {
    await createMovie(payload);
  } catch (error) {
    if (error.status === 401) return handleError(error);
    toast(`Couldn't add “${result.title}”. ${error.message}`, 'error');
    refreshResultActions();
  }
}

async function restoreFromSearch(movieId, actionButton) {
  if (actionButton.getAttribute('aria-disabled') === 'true') return;
  setResultBusy(actionButton, 'Restoring…');
  const restored = await restoreMovie(movieId);
  if (!restored) refreshResultActions();
}

async function runSearch(rawQuery) {
  const query = rawQuery.trim();
  clearTimeout(discover.timer);
  discoverEls.fallback.replaceChildren();
  if (!query) {
    discover.results = [];
    discoverEls.results.replaceChildren();
    setSearchStatus('Type a movie title to search.');
    return;
  }

  // Only the newest search matters; cancel any slower one still running.
  if (discover.controller) discover.controller.abort();
  const controller = new AbortController();
  discover.controller = controller;
  setSearchStatus('Searching TMDB…', 'loading');
  discoverEls.results.setAttribute('aria-busy', 'true');

  try {
    const data = await apiRequest(`/api/discover/search?q=${encodeURIComponent(query)}`, {
      operation: 'search TMDB',
      signal: controller.signal,
    });
    if (!Array.isArray(data.results)) {
      discoverLog.error('Search response has no results array', { query, data });
      throw new Error('Movie search sent back something unexpected. Try again, or add the movie manually.');
    }
    discover.results = data.results;
    discoverEls.results.replaceChildren(...data.results.map(createResult));
    if (data.results.length) {
      setSearchStatus(`${plural(data.results.length, 'result')} for “${query}”.`);
    } else {
      setSearchStatus(`No movies found for “${query}”. Check the spelling, or add it yourself.`);
      showManualFallback(query);
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (error.status === 401) return handleError(error);
    // apiRequest already logged the HTTP details (endpoint, status, request id).
    discover.results = [];
    discoverEls.results.replaceChildren();
    setSearchStatus(error.message, 'error');
    showManualFallback(query);
  } finally {
    if (discover.controller === controller) {
      discover.controller = null;
      discoverEls.results.removeAttribute('aria-busy');
    }
  }
}

// Used by the "no matches" state in the watchlist search.
function searchTmdbFor(query) {
  showView('watchlist');
  setAddMode('search');
  discoverEls.input.value = query;
  discoverEls.input.scrollIntoView({ block: 'center' });
  discoverEls.input.focus();
  runSearch(query);
}

async function setupDiscover() {
  discoverEls.modeButtons.forEach((b) => b.addEventListener('click', () => {
    setAddMode(b.dataset.mode);
    (b.dataset.mode === 'search' ? discoverEls.input : els.addForm.title).focus();
  }));
  discoverEls.form.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch(discoverEls.input.value);
  });
  // Search as you type, after a short pause.
  discoverEls.input.addEventListener('input', () => {
    clearTimeout(discover.timer);
    const value = discoverEls.input.value.trim();
    if (value.length >= 2) discover.timer = setTimeout(() => runSearch(value), 450);
    else if (!value) runSearch('');
  });
  document.addEventListener('watchlist:changed', refreshResultActions);

  try {
    const { enabled } = await apiRequest('/api/discover/status', { operation: 'check movie search' });
    discover.enabled = enabled === true;
  } catch (error) {
    if (error.status === 401) return handleError(error);
    discover.enabled = false;
  }
  if (!discover.enabled) {
    discoverLog.info('Movie search is off (the server has no TMDB_API_KEY, or it could not be reached). Manual entry only.');
  }

  discoverEls.modeSwitch.hidden = !discover.enabled;
  document.getElementById('credits').hidden = !discover.enabled;
  setAddMode(discover.enabled ? 'search' : 'manual');
  renderWatchlist(); // the "no matches" state offers a TMDB search only when it's enabled
}
