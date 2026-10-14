// Console logging with local timestamps, plus small formatting helpers.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel = LEVELS.info;
let stream = process.stdout;

/** level: debug|info|warn|error. toStderr: keep stdout free for JSON output (local mode). */
export function configureLog({ level, toStderr } = {}) {
  if (level && LEVELS[level]) minLevel = LEVELS[level];
  if (toStderr) stream = process.stderr;
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

function timestamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(level, message) {
  if (LEVELS[level] < minLevel) return;
  stream.write(`[${timestamp()}] ${level.toUpperCase().padEnd(5)} ${message}\n`);
}

export const log = {
  debug: (msg) => write('debug', msg),
  info: (msg) => write('info', msg),
  warn: (msg) => write('warn', msg),
  error: (msg) => write('error', msg),
};

/** 754.2 -> "12:34", 4000 -> "1:06:40" */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return (h ? `${h}:${pad(m)}` : pad(m)) + `:${pad(sec)}`;
}

/** Milliseconds -> "850 ms" / "12.3 s" / "4 min 05 s" */
export function elapsed(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} min ${pad(Math.round(s % 60))} s`;
}

export const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
