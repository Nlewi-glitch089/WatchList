// A tiny structured logger. Every line looks like:
//   2026-10-26T14:03:12.511Z [WARN] [Auth] Login rejected: invalid credentials {"username":"dave","requestId":"a1b2c3d4"}
//
// Levels: debug < info < warn < error. Set LOG_LEVEL in .env to change how much you see
// (defaults: debug in development, info in production, silent in tests).
// Context objects are scrubbed so passwords, hashes, cookies, tokens, and secrets never reach the log.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SENSITIVE_KEY = /password|passwd|hash|secret|token|cookie|^sid$|session_?id|authorization|api_?key/i;

function defaultLevel() {
  if (process.env.NODE_ENV === 'production') return 'info';
  if (process.env.NODE_ENV === 'test') return 'silent';
  return 'debug';
}

const configured = (process.env.LOG_LEVEL || '').toLowerCase();
const threshold = LEVELS[configured] ?? LEVELS[defaultLevel()];
const showStacks = process.env.NODE_ENV !== 'production';

// Copies `context`, replacing sensitive values and turning Errors into readable objects.
function scrub(value, depth = 0) {
  if (value instanceof Error) {
    const out = { message: value.message };
    if (value.code) out.code = value.code;
    if (showStacks && value.stack) out.stack = value.stack;
    return out;
  }
  if (!value || typeof value !== 'object' || depth > 3) return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : scrub(item, depth + 1);
  }
  return out;
}

function write(level, module, message, context) {
  if (LEVELS[level] < threshold) return;
  let line = `${new Date().toISOString()} [${level.toUpperCase()}] [${module}] ${message}`;
  let stack;
  if (context && Object.keys(context).length) {
    const clean = scrub(context);
    // Print stacks on their own lines so they stay readable in the terminal.
    if (clean.error && clean.error.stack) {
      stack = clean.error.stack;
      delete clean.error.stack;
    }
    try {
      line += ` ${JSON.stringify(clean)}`;
    } catch {
      line += ' [unserializable context]';
    }
  }
  if (stack) line += `\n${stack}`;
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  out(line);
}

// Usage: const log = createLogger('Movies'); log.info('Movie added', { movieId: 4 });
function createLogger(module) {
  return {
    debug: (message, context) => write('debug', module, message, context),
    info: (message, context) => write('info', module, message, context),
    warn: (message, context) => write('warn', module, message, context),
    error: (message, context) => write('error', module, message, context),
  };
}

module.exports = { createLogger, scrub };
