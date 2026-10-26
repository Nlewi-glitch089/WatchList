// Shared helpers for talking to the Express API, plus browser-side logging.

// Console logger with the same "[LEVEL] [Area] message" shape as the server logs.
// Debug lines only show on localhost, or anywhere after running:
//   localStorage.setItem('movienight.debug', '1')
const CLIENT_DEBUG = (() => {
  try {
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1' || localStorage.getItem('movienight.debug') === '1';
  } catch {
    return false;
  }
})();

function createClientLogger(area) {
  const write = (level, method, message, details) => {
    if (level === 'DEBUG' && !CLIENT_DEBUG) return;
    const line = `[${level}] [${area}] ${message}`;
    if (details === undefined) console[method](line);
    else console[method](line, details);
  };
  return {
    debug: (message, details) => write('DEBUG', 'debug', message, details),
    info: (message, details) => write('INFO', 'info', message, details),
    warn: (message, details) => write('WARN', 'warn', message, details),
    error: (message, details) => write('ERROR', 'error', message, details),
  };
}

const apiLog = createClientLogger('API');

// Sends a JSON request and returns the parsed body. Throws an Error with the
// server's message (plus .status, .data, and .requestId) when the request fails.
//
// `operation` is a short description ("add movie") used in logs. Every failure is
// logged with the endpoint, status, and the server's request id, which matches the
// requestId in the server log for the same request.
async function apiRequest(url, { method = 'GET', body, operation, signal } = {}) {
  const what = operation || `${method} ${url}`;
  const options = { method, headers: {}, credentials: 'same-origin', signal };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch (networkError) {
    if (networkError.name === 'AbortError') throw networkError; // cancelled on purpose; not a failure
    apiLog.error(`${what} failed: network error`, { endpoint: `${method} ${url}`, error: networkError.message });
    const error = new Error('Could not reach the server. Check that it is running and try again.');
    error.status = 0;
    throw error;
  }

  const requestId = response.headers.get('X-Request-Id');
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const error = new Error((data && data.error) || `Request failed (${response.status}).`);
    error.status = response.status;
    error.data = data || {};
    error.requestId = requestId;
    const details = { endpoint: `${method} ${url}`, status: response.status, requestId, error: error.message };
    // 4xx responses are the server saying "no" on purpose (validation, conflicts, not logged in);
    // 5xx means something actually broke.
    if (response.status >= 500) apiLog.error(`${what} failed`, details);
    else apiLog.warn(`${what} was rejected`, details);
    throw error;
  }

  if (data === null || typeof data !== 'object') {
    apiLog.error(`${what} returned an invalid response`, { endpoint: `${method} ${url}`, status: response.status, requestId });
    const error = new Error('The server sent an unexpected response. Please try again.');
    error.status = response.status;
    error.requestId = requestId;
    throw error;
  }

  apiLog.debug(`${what} ok`, { endpoint: `${method} ${url}`, status: response.status, requestId });
  return data;
}

// Last-resort reporting for bugs nobody caught.
window.addEventListener('error', (event) => {
  createClientLogger('App').error('Unexpected JavaScript error', {
    message: event.message,
    source: `${event.filename}:${event.lineno}:${event.colno}`,
    stack: event.error && event.error.stack,
  });
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  createClientLogger('App').error('Unhandled promise rejection', {
    message: reason && reason.message ? reason.message : String(reason),
    status: reason && reason.status,
    requestId: reason && reason.requestId,
    stack: reason && reason.stack,
  });
});
