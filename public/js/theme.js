// Theme settings. The theme is saved to the user's account (/api/settings) so it follows them
// across devices and logins. A copy is also kept in localStorage so every page can apply it
// before it paints (see the small inline script in each page's <head>).
const THEMES = {
  'after-hours': 'After Hours',
  midnight: 'Midnight',
  daydream: 'Daydream',
};
const DEFAULT_THEME = 'after-hours';
const THEME_STORAGE_KEY = 'movienight.theme';
const themeLog = createClientLogger('Theme');

function currentTheme() {
  return document.documentElement.dataset.theme || DEFAULT_THEME;
}

function applyTheme(theme) {
  if (!THEMES[theme]) theme = DEFAULT_THEME;
  if (theme === DEFAULT_THEME) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private browsing or blocked storage: the theme still applies, it just won't be cached.
  }
}

// The account's saved theme wins over whatever this browser cached.
async function loadThemePreference() {
  try {
    const { settings } = await apiRequest('/api/settings', { operation: 'load theme preference' });
    if (settings && THEMES[settings.theme]) {
      applyTheme(settings.theme);
      themeLog.debug('Applied saved theme', { theme: settings.theme });
    } else {
      themeLog.warn('Server sent an unknown theme; using the default', { settings });
    }
  } catch (error) {
    if (error.status === 401) throw error;
    themeLog.warn('Could not load the saved theme; keeping the current one', { error: error.message, requestId: error.requestId });
  }
}

function setupThemeSettings() {
  const dialog = document.getElementById('theme-dialog');
  const openButton = document.getElementById('theme-btn');
  const status = document.getElementById('theme-status');
  const radios = [...dialog.querySelectorAll('input[name="theme"]')];
  let savedTheme = currentTheme();
  let latestRequest = 0;

  const setStatus = (text, isError = false) => {
    status.textContent = text;
    status.classList.toggle('is-error', isError);
  };

  openButton.addEventListener('click', () => {
    savedTheme = currentTheme();
    radios.forEach((radio) => { radio.checked = radio.value === savedTheme; });
    setStatus('');
    dialog.showModal();
    const checked = radios.find((radio) => radio.checked);
    if (checked) checked.focus();
  });

  // Choosing a theme previews it right away, then saves it.
  dialog.addEventListener('change', async (event) => {
    if (event.target.name !== 'theme') return;
    const theme = event.target.value;
    const previous = savedTheme;
    const requestNumber = ++latestRequest;
    applyTheme(theme);
    setStatus(`Saving ${THEMES[theme]}…`);

    try {
      await apiRequest('/api/settings', { method: 'PATCH', body: { theme }, operation: 'save theme preference' });
      if (requestNumber !== latestRequest) return; // a newer choice is already on its way
      savedTheme = theme;
      setStatus(`${THEMES[theme]} theme saved.`);
      themeLog.info('Theme changed', { theme });
    } catch (error) {
      if (requestNumber !== latestRequest) return;
      if (error.status === 401) return handleError(error);
      themeLog.error('Theme change failed; reverting', { theme, previous, status: error.status, requestId: error.requestId, error: error.message });
      applyTheme(previous);
      radios.forEach((radio) => { radio.checked = radio.value === previous; });
      setStatus(`Couldn't save the ${THEMES[theme]} theme, so it's back to ${THEMES[previous]}. ${error.message}`, true);
    }
  });
}
