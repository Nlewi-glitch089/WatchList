// Recently Deleted view: lists soft-deleted movies with Restore and Delete forever actions.
// The actions themselves (restoreMovie, purgeMovie, restoreAllMovies) live in main.js.
const trashEls = {
  heading: document.getElementById('deleted-heading'),
  state: document.getElementById('deleted-state'),
  list: document.getElementById('deleted-list'),
  restoreAll: document.getElementById('restore-all-btn'),
};

function createTrashItem(movie) {
  const li = el('li', 'trash-item');
  li.dataset.id = movie.id;
  const busy = state.pending.has(movie.id);

  const body = el('div', 'trash-body');
  const details = [movie.year, movie.genre].filter(Boolean).join(' · ');
  const deleted = el('p', 'trash-deleted');
  const deletedOn = formatDate(movie.deleted_at, true);
  deleted.append(
    icon('clock'),
    `${deletedOn ? `Deleted ${deletedOn}` : 'Deleted'} · ${movie.watched ? 'was marked watched' : 'was on your to-watch list'}`
  );
  body.append(el('h3', 'movie-title', movie.title));
  if (details) body.appendChild(el('p', 'movie-meta', details));
  body.appendChild(deleted);

  const actions = el('div', 'trash-actions');
  const restore = button('btn btn-secondary restore-btn', 'Restore', {
    iconName: 'undo',
    label: `Restore ${movieLabel(movie)}`,
    onClick: () => restoreFromTrash(movie.id),
  });
  const purge = button('btn btn-danger-outline purge-btn', 'Delete forever', {
    iconName: 'trash',
    label: `Delete ${movieLabel(movie)} forever`,
    onClick: () => purgeMovie(movie.id),
  });
  if (busy) [restore, purge].forEach((b) => b.setAttribute('aria-disabled', 'true'));
  actions.append(restore, purge);

  li.append(createPosterFrame(movie, { size: 'w154', mini: true }), body, actions);
  return li;
}

function renderTrash() {
  const count = state.deleted.length;
  trashEls.restoreAll.hidden = count < 2 || state.deletedStatus !== 'ready';

  if (state.deletedStatus === 'loading') {
    trashEls.list.hidden = true;
    trashEls.state.replaceChildren(createLoading('Loading Recently Deleted…'));
    return;
  }
  if (state.deletedStatus === 'error') {
    trashEls.list.hidden = true;
    trashEls.state.replaceChildren(
      createEmptyState({
        heading: "We couldn't load Recently Deleted",
        text: state.deletedError || 'Something went wrong. Try again in a moment.',
        role: 'alert',
        actions: [{ label: 'Try again', primary: true, onClick: loadDeleted }],
      })
    );
    return;
  }

  trashEls.list.replaceChildren(...state.deleted.map(createTrashItem));
  trashEls.list.hidden = count === 0;
  if (count === 0) {
    trashEls.state.replaceChildren(
      createEmptyState({
        heading: 'Nothing in Recently Deleted',
        text: "When you remove a movie from your watchlist, it lands here so you can bring it back later.",
        actions: [{ label: 'Back to your watchlist', onClick: () => showView('watchlist', { focus: true }) }],
      })
    );
  } else {
    trashEls.state.replaceChildren();
  }
}

function trashIndex(movieId) {
  return state.deleted.findIndex((m) => m.id === movieId);
}

// After an item leaves the list, move focus to the item that took its place.
function focusTrashItem(index) {
  if (state.view !== 'deleted') return;
  const items = trashEls.list.querySelectorAll('.trash-item');
  const target = items[Math.min(index, items.length - 1)];
  if (target) target.querySelector('.restore-btn').focus();
  else trashEls.heading.focus();
}

async function restoreFromTrash(movieId) {
  const index = trashIndex(movieId);
  await restoreMovie(movieId);
  // Whether it worked or not, the old button was re-rendered; put focus back in the list.
  const item = trashEls.list.querySelector(`[data-id="${movieId}"]`);
  if (item) item.querySelector('.restore-btn').focus();
  else focusTrashItem(index);
}

function setupTrash() {
  trashEls.restoreAll.addEventListener('click', restoreAllMovies);
}
