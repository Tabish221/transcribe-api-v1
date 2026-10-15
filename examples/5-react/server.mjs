// server.mjs - the demo backend. It keeps your Transcribe API key secret.
//
// The React app (in the browser) calls THIS server. This server adds the API key
// and calls the Transcribe API. The browser never sees the key.
//
//   Browser                              This server        Transcribe API
//   POST /api/transcribe             ->  adds the key   ->  POST   /api/v1/transcriptions
//   GET  /api/transcriptions/:id     ->  adds the key   ->  GET    /api/v1/transcriptions/:id
//   GET  /api/transcriptions/:id/srt ->  adds the key   ->  GET    /api/v1/transcriptions/:id?format=srt
//   POST /api/tester/:action         ->  adds the key   ->  any endpoint (for the "API Tester" page)
//   GET  /api/config                 ->  default engine/language for the UI (no secrets)
//   GET  /api/sample                 ->  ../sample/clip.mp3, so you can try the demo without your own file
//   GET  /*                          ->  the built React app from dist/ (after "npm run build")
//
// Only Node built-ins (node:http + fetch). Start it with:  node server.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const SAMPLE = path.join(HERE, '..', 'sample', 'clip.mp3');

// ------------------------------------------------------------------ settings

/** Reads a simple KEY=VALUE file. Empty lines and lines starting with # are ignored. */
function readEnvFile(file) {
  const values = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch {
    return values; // no file: use real environment variables only
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
    values[line.slice(0, eq).trim()] = value;
  }
  return values;
}

const ENV_FILE = path.join(HERE, '..', '.env'); // shared by all demos
const fileEnv = readEnvFile(ENV_FILE);
/** Real environment variables win over the .env file. */
const setting = (name, fallback = '') => process.env[name] ?? fileEnv[name] ?? fallback;

const API_URL = setting('TRANSCRIBE_API_URL').replace(/\/+$/, '');
const API_KEY = setting('TRANSCRIBE_API_KEY');
const WEBHOOK_SECRET = setting('TRANSCRIBE_WEBHOOK_SECRET');
const DEFAULT_ENGINE = (setting('TRANSCRIBE_ENGINE') || 'worker').toLowerCase();
const DEFAULT_LANGUAGE = setting('TRANSCRIBE_LANGUAGE'); // '' or 'auto' = detect the language
const HOST = '127.0.0.1'; // only this computer can reach the backend
const PORT = Number(process.env.PORT || 3001);
const VITE_PORT = Number(process.env.VITE_PORT || 5173);
const MAX_UPLOAD_MB = 100; // same as the API's default "max_upload_mb"
const DEV = process.env.DEMO_DEV === '1'; // set by dev.mjs

if (!API_URL || !API_KEY) {
  console.error(`Missing TRANSCRIBE_API_URL or TRANSCRIBE_API_KEY.\nAdd them to ${ENV_FILE} (or set them as environment variables).`);
  process.exit(1);
}

/** What we show instead of the key: "Bearer tk_1234…". Never log or return the full key. */
const MASKED_AUTH = `Bearer ${API_KEY.slice(0, 7)}…`;
const ID_PATTERN = /^tr_[0-9a-f]{24}$/;

// ------------------------------------------------------------------ helpers

const SAFE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SAFE_HEADERS, 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

/** Same error shape as the Transcribe API, so the React app handles both the same way. */
function sendError(res, status, code, message, extra = {}, headers = {}) {
  sendJson(res, status, { error: { code, message, ...extra } }, headers);
}

/** A small error we can throw anywhere in a handler; the router turns it into JSON. */
class HttpError extends Error {
  constructor(status, code, message, extra = {}, headers = {}) {
    super(message);
    Object.assign(this, { status, code, extra, headers });
  }
}
const invalid = (field, message) => new HttpError(422, 'validation_error', message, { field });

/** A form value as trimmed text ('' when missing or when it is a file). */
const formText = (value) => (typeof value === 'string' ? value.trim() : '');

/** Checks the id BEFORE it goes into a URL (so nobody can send "../something"). */
function checkId(id) {
  if (!ID_PATTERN.test(String(id ?? ''))) throw invalid('id', 'Invalid transcription id (expected tr_ + 24 hex characters)');
  return id;
}

/** Calls the Transcribe API with the secret key. Returns the fetch Response, or null when the API cannot be reached. */
async function callApi(apiPath, { method = 'GET', body, timeoutMs = 30_000, auth = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (auth) headers.Authorization = `Bearer ${API_KEY}`;
  try {
    return await fetch(API_URL + apiPath, { method, body, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    console.error(`[api] ${method} ${apiPath} failed: ${err.cause?.code || err.name || err.message}`);
    return null;
  }
}

const unreachable = () =>
  new HttpError(502, 'api_unreachable', 'Cannot reach the Transcribe API. Check TRANSCRIBE_API_URL in .env and that the server is running.');

/** Sends the API's JSON answer (success or error) to the browser unchanged. Returns the parsed data. */
async function relayJson(res, upstream) {
  if (!upstream) throw unreachable();
  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(502, 'bad_api_response', `The Transcribe API answered HTTP ${upstream.status} without JSON.`);
  }
  send(res, upstream.status, text, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  return data;
}

/**
 * Reads a multipart/form-data upload with the built-in Web Request API (no extra packages).
 * The whole upload is kept in memory, which is fine for MP3 files up to 100 MB.
 */
async function readMultipart(req) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw invalid('file', 'Send the audio as multipart/form-data field "file"');
  }
  const maxBytes = MAX_UPLOAD_MB * 1024 * 1024 + 64 * 1024; // + room for the form fields
  const tooLarge = new HttpError(413, 'file_too_large', `File is larger than the ${MAX_UPLOAD_MB} MB upload limit`, {}, { Connection: 'close' });
  if (Number(req.headers['content-length'] || 0) > maxBytes) throw tooLarge;

  let overLimit = false;
  async function* limitedBody() {
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) {
        overLimit = true;
        throw new Error('upload too large');
      }
      yield chunk;
    }
  }

  try {
    return await new Request('http://backend.local/upload', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: ReadableStream.from(limitedBody()),
      duplex: 'half',
    }).formData();
  } catch {
    throw overLimit ? tooLarge : new HttpError(400, 'bad_request', 'Could not read the upload. Please try again.');
  }
}

/** Reads a small JSON body (the tester actions send their inputs like this). */
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'payload_too_large', 'JSON body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    throw new HttpError(400, 'bad_request', 'Body must be JSON');
  }
}

/** Simple CSRF guard: a POST from another website (through the visitor's browser) is refused. */
function isLocalOrigin(origin) {
  if (!origin) return true; // curl and server-to-server calls send no Origin header
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// Log job changes once (the browser polls every 2 s - we do not want 30 lines per minute).
const lastLogged = new Map();
function logJob(t) {
  if (!t?.id || !t.status) return;
  const line = t.status === 'processing' && t.progress != null ? `processing ${t.progress}%` : t.status;
  if (lastLogged.get(t.id) === line) return;
  console.log(`[job] ${t.id} ${line}${t.status === 'failed' && t.error ? ` - ${t.error}` : ''}`);
  if (t.status === 'completed' || t.status === 'failed') lastLogged.delete(t.id);
  else lastLogged.set(t.id, line);
}

// ------------------------------------------------------------------ routes for the transcribe page

/** POST /api/transcribe - multipart upload from the browser, forwarded with the key. */
async function handleTranscribe(req, res) {
  // 1. Read the upload.
  const incoming = await readMultipart(req);
  const file = incoming.get('file');
  if (!file || typeof file === 'string') throw invalid('file', 'Choose an audio file (form field "file")');

  // 2. Fill in the defaults. The browser may choose the engine and language; everything else is decided here.
  const engine = (formText(incoming.get('engine')) || DEFAULT_ENGINE).toLowerCase();
  if (engine !== 'worker' && engine !== 'cloud') throw invalid('engine', 'engine must be "worker" or "cloud"');
  const language = formText(incoming.get('language')) || DEFAULT_LANGUAGE; // "auto" = detect

  const form = new FormData();
  form.append('file', file, file.name || 'audio.mp3');
  form.append('engine', engine);
  if (language) form.append('language', language);
  form.append('metadata', JSON.stringify({ source: 'react-demo' }));
  // Cloud only: the API transcribes inside this request and answers with the finished result (HTTP 200).
  // The worker engine ignores "wait"; the React app polls GET /api/transcriptions/:id instead.
  if (engine === 'cloud') form.append('wait', 'true');

  // 3. Forward it with the secret key (long timeout: cloud + wait can take minutes for long files).
  console.log(`[upload] ${file.name} (${Math.round(file.size / 1024)} KB) engine=${engine} language=${language || 'project default'}`);
  const upstream = await callApi('/api/v1/transcriptions', { method: 'POST', body: form, timeoutMs: 15 * 60_000 });
  const data = await relayJson(res, upstream);
  if (data?.error) console.log(`[upload] refused: HTTP ${upstream.status} ${data.error.code} - ${data.error.message}`);
  logJob(data);
}

/** GET /api/transcriptions/:id - status, progress and (when completed) the transcript. */
async function handleShow(res, id) {
  // In your own app: check here that the logged-in user owns this transcription id.
  const data = await relayJson(res, await callApi(`/api/v1/transcriptions/${id}`));
  logJob(data);
}

/** GET /api/transcriptions/:id/srt - subtitle file download (409 not_ready until completed). */
async function handleSrt(res, id) {
  const upstream = await callApi(`/api/v1/transcriptions/${id}?format=srt`);
  if (!upstream || !upstream.ok) return relayJson(res, upstream);
  const body = Buffer.from(await upstream.arrayBuffer());
  send(res, 200, body, {
    'Content-Type': upstream.headers.get('content-type') || 'application/x-subrip',
    'Content-Disposition': upstream.headers.get('content-disposition') || `attachment; filename="${id}.srt"`,
    'Cache-Control': 'no-store',
  });
}

/** GET /api/config - defaults for the UI. Never put secrets here. */
async function handleConfig(res) {
  let engines = null;
  try {
    const health = await fetch(`${API_URL}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
    if (health.ok) engines = (await health.json()).engines ?? null;
  } catch {
    // API offline: the UI still works, it just cannot show which engines are on.
  }
  sendJson(res, 200, {
    defaultEngine: DEFAULT_ENGINE,
    defaultLanguage: DEFAULT_LANGUAGE || 'auto',
    engines, // e.g. { cloud: false, worker: true }
    maxUploadMb: MAX_UPLOAD_MB,
    apiUrl: API_URL, // the URL is not secret; the key is
    keyPreview: API_KEY.slice(0, 7), // first 7 characters only, e.g. "tk_1234"
  });
}

/** GET /api/sample - the demo's sample clip, so "Use sample clip" works without picking a file. */
function handleSample(res) {
  if (!fs.existsSync(SAMPLE)) throw new HttpError(404, 'not_found', 'sample/clip.mp3 was not found');
  send(res, 200, fs.readFileSync(SAMPLE), {
    'Content-Type': 'audio/mpeg',
    'Content-Disposition': 'inline; filename="clip.mp3"',
    'Cache-Control': 'no-cache',
  });
}

// ------------------------------------------------------------------ API Tester (POST /api/tester/:action)
//
// Every action calls ONE Transcribe API endpoint and answers with what happened:
//   { request:  { method, url, headers (key masked), fields },
//     response: { status, headers (a useful subset), body (JSON or text) },
//     duration_ms }
// The page shows the request and the response side by side.

const SHOWN_RESPONSE_HEADERS = [
  'content-type', 'content-length', 'content-disposition', 'cache-control',
  'location', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
];
const MAX_TEXT_BODY = 200_000; // characters; longer bodies are cut (only for display)

/** Calls the API and builds the tester envelope. `fields` = what we sent (shown on the page). */
async function testerCall(apiPath, { method = 'GET', body, fields, contentType, auth = true, timeoutMs = 30_000 } = {}) {
  const shownHeaders = { Accept: 'application/json' };
  if (auth) shownHeaders.Authorization = MASKED_AUTH; // the real key is added inside callApi() only
  if (contentType) shownHeaders['Content-Type'] = contentType;

  const started = performance.now();
  const upstream = await callApi(apiPath, { method, body, auth, timeoutMs });
  if (!upstream) throw unreachable();
  const raw = await upstream.text();
  const duration_ms = Math.round(performance.now() - started);

  const headers = {};
  for (const name of SHOWN_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers[name] = value;
  }

  let parsed = raw;
  let truncated = false;
  if ((headers['content-type'] || '').includes('json')) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* keep it as text */
    }
  }
  if (typeof parsed === 'string' && parsed.length > MAX_TEXT_BODY) {
    parsed = parsed.slice(0, MAX_TEXT_BODY);
    truncated = true;
  }

  return {
    request: { method, url: API_URL + apiPath, headers: shownHeaders, fields: fields ?? null },
    response: { status: upstream.status, ok: upstream.ok, headers, body: parsed, ...(truncated && { truncated: true }) },
    duration_ms,
  };
}

const TESTER = {
  /** GET /api/v1/health - no key needed. */
  health: () => testerCall('/api/v1/health', { auth: false }),

  /** GET /api/v1/transcriptions?status=&limit=&offset= */
  async list(input) {
    const query = new URLSearchParams();
    for (const name of ['status', 'limit', 'offset']) {
      const value = String(input[name] ?? '').trim();
      if (value) query.set(name, value); // the API validates the values; we pass them as they are
    }
    const qs = query.toString();
    return testerCall(`/api/v1/transcriptions${qs ? `?${qs}` : ''}`, { fields: Object.fromEntries(query) });
  },

  /** POST /api/v1/transcriptions (multipart). Only non-empty fields are sent, so you can test the API defaults. */
  async upload(_input, req) {
    const incoming = await readMultipart(req);
    const file = incoming.get('file');
    if (!file || typeof file === 'string') throw invalid('file', 'Choose an MP3 file first');

    const form = new FormData();
    form.append('file', file, file.name || 'audio.mp3');
    const fields = { file: `${file.name} (${Math.round(file.size / 1024)} KB, ${file.type || 'unknown type'})` };
    for (const name of ['engine', 'language', 'task', 'prompt', 'wait']) {
      const value = formText(incoming.get(name));
      if (!value) continue;
      form.append(name, value);
      fields[name] = value;
    }
    form.append('metadata', JSON.stringify({ source: 'react-demo-tester' }));
    fields.metadata = '{"source":"react-demo-tester"}';

    console.log(`[tester] upload ${file.name} engine=${fields.engine || 'default'} wait=${fields.wait || 'no'}`);
    return testerCall('/api/v1/transcriptions', {
      method: 'POST',
      body: form,
      fields,
      contentType: 'multipart/form-data; boundary=…',
      timeoutMs: 15 * 60_000, // cloud + wait=true answers only when the text is ready
    });
  },

  /** GET /api/v1/transcriptions/{id} */
  get: (input) => testerCall(`/api/v1/transcriptions/${checkId(input.id)}`, { fields: { id: input.id } }),

  /** GET /api/v1/transcriptions/{id}?format=txt|srt|vtt|json  (409 not_ready until completed) */
  format(input) {
    const id = checkId(input.id);
    const format = String(input.format || 'srt').toLowerCase();
    if (!['txt', 'srt', 'vtt', 'json'].includes(format)) throw invalid('format', 'format must be txt, srt, vtt or json');
    return testerCall(`/api/v1/transcriptions/${id}?format=${format}`, { fields: { id, format } });
  },

  /** DELETE /api/v1/transcriptions/{id} - removes the row and the audio file. */
  delete: (input) => testerCall(`/api/v1/transcriptions/${checkId(input.id)}`, { method: 'DELETE', fields: { id: input.id } }),

  /**
   * Webhook info. The public API has no "webhook" endpoint, so this action:
   *   1. lists the latest jobs and shows their webhook_status (delivered / failed:<code> / pending / null)
   *   2. adds what YOUR receiver needs to know: headers, signature format, and a signed example
   *      made with TRANSCRIBE_WEBHOOK_SECRET (the secret itself is never returned).
   */
  async 'webhook-info'() {
    const result = await testerCall('/api/v1/transcriptions?limit=10', { fields: { limit: '10' } });
    const list = result.response.body;
    if (result.response.ok && Array.isArray(list?.data)) {
      result.response.body = {
        note: 'Shortened by the demo backend: only the webhook fields of the latest 10 jobs.',
        total: list.total,
        data: list.data.map((t) => ({ id: t.id, status: t.status, webhook_status: t.webhook_status, created_at: t.created_at })),
      };
    }

    const example = JSON.stringify({
      event: 'transcription.completed',
      created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      data: { id: 'tr_0123456789abcdef01234567', object: 'transcription', status: 'completed', text: 'Hello world.' },
    });
    result.backend = {
      webhook_secret_configured: Boolean(WEBHOOK_SECRET),
      how_it_works:
        'When a job completes or fails and it has a webhook_url (request field or project setting), the API POSTs JSON to that URL. ' +
        'Any 2xx answer = delivered; other answers are retried later.',
      events: ['transcription.completed', 'transcription.failed'],
      headers_sent_by_api: {
        'Content-Type': 'application/json',
        'User-Agent': 'TranscribeAPI/1.0',
        'X-Transcribe-Event': 'transcription.completed',
        'X-Transcribe-Delivery': '<tr_id>',
        'X-Transcribe-Signature': 'sha256=<hex HMAC-SHA256 of the raw body, key = project webhook secret>',
      },
      verify_in_node: "createHmac('sha256', secret).update(rawBody).digest('hex') === header.slice(7)  // use timingSafeEqual",
      signed_example: WEBHOOK_SECRET
        ? { raw_body: example, 'X-Transcribe-Signature': 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(example).digest('hex') }
        : 'Set TRANSCRIBE_WEBHOOK_SECRET in .env to see a signed example.',
      receiver_demo: 'See the 4-webhook folder for a complete receiver.',
    };
    return result;
  },
};

async function handleTester(req, res, action) {
  const run = Object.hasOwn(TESTER, action) ? TESTER[action] : null;
  if (!run) throw new HttpError(404, 'not_found', `Unknown tester action "${action}"`);
  // "upload" reads its own multipart body; every other action gets a small JSON body.
  const input = action === 'upload' ? {} : await readJson(req);
  sendJson(res, 200, await run(input, req));
}

// ------------------------------------------------------------------ built React app (npm run build -> dist/)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const PAGE_CSP =
  "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";
const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Not built yet</title>
<body style="font:16px system-ui;max-width:560px;margin:60px auto;padding:0 16px;line-height:1.5">
<h1>The React app is not built yet</h1>
<p>Run <code>npm run build</code>, then <code>npm start</code> again.</p>
<p>For development run <code>npm run dev</code> and open <a href="http://localhost:${VITE_PORT}">http://localhost:${VITE_PORT}</a>.</p></body>`;

function serveStatic(res, pathname) {
  const indexFile = path.join(DIST, 'index.html');
  if (!fs.existsSync(indexFile)) return send(res, 200, NOT_BUILT, { 'Content-Type': 'text/html; charset=utf-8' });

  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'bad_request', 'Bad URL');
  }
  if (relative.includes('\0')) throw new HttpError(400, 'bad_request', 'Bad URL');

  let file = path.join(DIST, path.normalize(relative));
  if (file !== DIST && !file.startsWith(DIST + path.sep)) throw new HttpError(404, 'not_found', 'Not found');
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    if (path.extname(relative)) throw new HttpError(404, 'not_found', 'Not found'); // a missing asset
    file = indexFile; // any other path shows the React app
  }

  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  if (ext === '.html') {
    headers['Content-Security-Policy'] = PAGE_CSP;
    headers['Cache-Control'] = 'no-cache';
  } else if (file.startsWith(path.join(DIST, 'assets') + path.sep)) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable'; // file names contain a content hash
  }
  send(res, 200, fs.readFileSync(file), headers);
}

// ------------------------------------------------------------------ router + start

async function route(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  const onlyLocal = () => {
    if (!isLocalOrigin(req.headers.origin)) throw new HttpError(403, 'forbidden', 'Requests from other websites are not allowed');
  };

  if (pathname === '/api/transcribe') {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST');
    onlyLocal();
    return handleTranscribe(req, res);
  }
  if (pathname === '/api/config') {
    if (!isRead) throw new HttpError(405, 'method_not_allowed', 'Use GET');
    return handleConfig(res);
  }
  if (pathname === '/api/sample') {
    if (!isRead) throw new HttpError(405, 'method_not_allowed', 'Use GET');
    return handleSample(res);
  }
  const tester = pathname.match(/^\/api\/tester\/([a-z-]+)$/);
  if (tester) {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST');
    onlyLocal();
    return handleTester(req, res, tester[1]);
  }
  const match = pathname.match(/^\/api\/transcriptions\/([^/]+)(\/srt)?$/);
  if (match) {
    if (!isRead) throw new HttpError(405, 'method_not_allowed', 'Use GET');
    const id = checkId(match[1]);
    return match[2] ? handleSrt(res, id) : handleShow(res, id);
  }
  if (pathname.startsWith('/api/')) throw new HttpError(404, 'not_found', 'No such endpoint');
  if (!isRead) throw new HttpError(405, 'method_not_allowed', 'Use GET');
  return serveStatic(res, pathname);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    if (res.headersSent) return res.destroy();
    if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message, err.extra, err.headers);
    console.error('[backend] unexpected error:', err);
    sendError(res, 500, 'server_error', 'Unexpected error in the demo backend');
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other program, or start with another PORT.`);
  else console.error('[backend] cannot start:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const built = fs.existsSync(path.join(DIST, 'index.html'));
  const app = DEV ? `http://localhost:${VITE_PORT} (Vite dev server)` : built ? `http://${HOST}:${PORT}` : 'not built yet - run "npm run build"';
  console.log('');
  console.log('  Transcribe API demo backend is running');
  console.log(`  - Backend:        http://${HOST}:${PORT}`);
  console.log(`  - Transcribe API: ${API_URL}  (key ${API_KEY.slice(0, 7)}...)`);
  console.log(`  - Defaults:       engine=${DEFAULT_ENGINE}, language=${DEFAULT_LANGUAGE || 'auto'}`);
  console.log(`  - React app:      ${app}`);
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
