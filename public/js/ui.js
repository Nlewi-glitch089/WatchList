// Small UI helpers shared by the watchlist, Recently Deleted, and search code:
// element/icon builders, toasts, screen reader announcements, posters, and empty states.

const POSTER_VARIANTS = ['sun', 'beams', 'rings', 'split'];
const POSTER_PALETTES = 8;
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/';

const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 7v6M12 17h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
};

const EMPTY_ART = `
  <svg class="empty-art" viewBox="0 0 120 80" aria-hidden="true" focusable="false">
    <path class="art-ticket" stroke-width="2.5"
          d="M16 12h88a6 6 0 0 1 6 6v12a10 10 0 0 0 0 20v12a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6V50a10 10 0 0 0 0-20V18a6 6 0 0 1 6-6z"/>
    <path class="art-perforation" d="M84 16v48" stroke-width="2" stroke-dasharray="3 5"/>
    <text class="art-text" x="47" y="37" text-anchor="middle" font-family="Bebas Neue, sans-serif" font-size="15" letter-spacing="2">ADMIT</text>
    <text class="art-text" x="47" y="54" text-anchor="middle" font-family="Bebas Neue, sans-serif" font-size="15" letter-spacing="2">ONE</text>
    <path class="art-star" d="M97 33l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z"/>
  </svg>`;

const uiLog = createClientLogger('UI');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function icon(name) {
  const template = document.createElement('template');
  template.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
  return template.content.firstElementChild;
}

function button(className, text, { iconName, label, onClick } = {}) {
  const node = el('button', className);
  node.type = 'button';
  if (iconName) node.appendChild(icon(iconName));
  if (text) node.appendChild(el('span', null, text));
  if (label) node.setAttribute('aria-label', label);
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const movieLabel = (movie) => `${movie.title}${movie.year ? ` (${movie.year})` : ''}`;

// The API sends dates as ISO 8601 UTC strings, like "2026-10-26T14:03:12.000Z".
function parseDbDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value, withYear = false) {
  const date = parseDbDate(value);
  if (!date) return '';
  const options = { month: 'short', day: 'numeric' };
  if (withYear || date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
  return date.toLocaleDateString(undefined, options);
}

// ---------- Announcements and toasts ----------

// Screen reader announcements. Clearing first makes repeated messages get read again.
function announce(text, { urgent = false } = {}) {
  const region = document.getElementById(urgent ? 'sr-alert' : 'sr-status');
  if (!region) return;
  region.textContent = '';
  setTimeout(() => { region.textContent = text; }, 60);
}

// Visual notification that is also announced. An optional action (like Undo) adds a button;
// those toasts stay longer and pause while hovered or focused.
function toast(text, type = 'success', { action } = {}) {
  const container = document.getElementById('toast-container');
  const item = el('div', `toast toast-${type}`);
  item.append(icon(type === 'error' ? 'alert' : 'check'), el('p', null, text));

  if (action) {
    item.classList.add('toast-has-action');
    const actionButton = button('btn btn-secondary toast-action', action.label, {
      onClick: () => {
        item.remove();
        action.onClick();
      },
    });
    item.appendChild(actionButton);
  }

  container.appendChild(item);
  // Keep the stack short so toasts never bury the cards underneath.
  while (container.children.length > 3) container.firstElementChild.remove();
  announce(action && action.hint ? `${text} ${action.hint}` : text, { urgent: type === 'error' });

  const lifetime = action ? 9000 : type === 'error' ? 8000 : 4500;
  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => item.remove(), lifetime);
  };
  const pause = () => clearTimeout(timer);
  item.addEventListener('mouseenter', pause);
  item.addEventListener('mouseleave', schedule);
  item.addEventListener('focusin', pause);
  item.addEventListener('focusout', schedule);
  schedule();
}

// ---------- Posters ----------

// FNV-1a hash, so each title always gets the same poster.
function hashTitle(title) {
  let hash = 2166136261;
  for (const char of title.toLowerCase()) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createGeneratedPoster(movie) {
  const hash = hashTitle(movie.title);
  const variant = POSTER_VARIANTS[hash % POSTER_VARIANTS.length];
  const palette = Math.floor(hash / POSTER_VARIANTS.length) % POSTER_PALETTES;
  const length = movie.title.length;
  const size = length <= 10 ? ' is-short' : length > 26 ? ' is-long' : '';

  const poster = el('div', `poster poster--${variant} palette-${palette}`);
  const longestWord = Math.max(...movie.title.split(/\s+/).map((word) => word.length));
  poster.style.setProperty('--fit', Math.max(longestWord, 5));
  const billing = el('span', 'poster-billing');
  billing.append(el('span', null, 'Movie Night'), el('span', null, movie.year ? String(movie.year) : 'Feature'));
  poster.append(
    el('span', 'poster-kicker', movie.genre || 'Now showing'),
    el('span', `poster-title${size}`, movie.title),
    billing
  );
  return poster;
}

// Only these hosts are trusted for poster images.
const POSTER_URL_PATTERN = /^https:\/\/(upload|thumb)\.wikimedia\.org\//;

// A decorative poster: the real poster when there is one (TMDB, or a free one from Wikimedia
// Commons), drawn over the generated poster. If the image fails to load, it's removed and the
// generated poster shows instead.
function createPosterFrame(movie, { size = 'w342', mini = false } = {}) {
  const frame = el('div', `poster-frame${mini ? ' poster-mini' : ''}`);
  frame.setAttribute('aria-hidden', 'true');
  frame.appendChild(createGeneratedPoster(movie));
  const src = movie.poster_path
    ? `${TMDB_IMAGE_BASE}${size}${movie.poster_path}`
    : movie.poster_url && POSTER_URL_PATTERN.test(movie.poster_url) ? movie.poster_url : null;
  if (src) {
    const img = el('img', 'poster-img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = src;
    img.addEventListener('error', () => {
      uiLog.warn('Poster image failed to load; using the generated poster', { title: movie.title, src: img.src });
      img.remove();
    });
    frame.appendChild(img);
  }
  return frame;
}

// ---------- Empty states ----------

function createEmptyState({ heading, text, actions = [], role }) {
  const box = el('div', 'empty-state');
  if (role) box.setAttribute('role', role);
  box.innerHTML = EMPTY_ART;
  box.append(el('h3', null, heading), el('p', null, text));
  if (actions.length) {
    const row = el('div', 'empty-actions');
    actions.forEach(({ label, onClick, primary }) => row.appendChild(button(`btn ${primary ? 'btn-accent' : 'btn-secondary'}`, label, { onClick })));
    box.appendChild(row);
  }
  return box;
}

function createLoading(text) {
  const box = el('div', 'loading');
  box.setAttribute('role', 'status');
  const spinner = el('span', 'spinner');
  spinner.setAttribute('aria-hidden', 'true');
  box.append(spinner, el('p', null, text));
  return box;
}
