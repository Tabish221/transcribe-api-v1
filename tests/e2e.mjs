#!/usr/bin/env node
// End-to-end test of the whole Transcribe API stack against a fresh, throw-away install.
//
//   node tests/e2e.mjs [--db sqlite|mysql] [--keep] [--skip-worker]
//
// 1. Installs the server with the CLI installer into tests/tmp/e2e (config.php + storage there), with the
//    cloud engine pointed at tests/mock-cloud.mjs and private webhooks allowed. config.e2e.php wraps that
//    config with small upload limits so the 413 paths can be tested; TAPI_CONFIG points at it.
// 2. Starts php -S 127.0.0.1:8091 server/index.php, the mock cloud (8092) and tests/webhook-receiver.mjs (8093).
// 3. Runs every check (routing/static files, dashboard API, public API, the real PC worker, worker API
//    semantics, cloud engine + cron, webhooks, audio Range, deletes, n8n node via tests/n8n-harness.cjs)
//    and prints a PASS/FAIL table.
// 4. Stops every process it started and deletes tests/tmp/e2e (and the MySQL test database).
// Exit code: 0 when every check passed, 1 otherwise.
//
// Options:
//   --db mysql     MySQL/MariaDB at 127.0.0.1:3306, user root, no password (override with E2E_MYSQL_HOST,
//                  E2E_MYSQL_PORT, E2E_MYSQL_USER, E2E_MYSQL_PASS). Database transcribe_api_test is (re)created.
//   --keep         after the checks, keep the server, mocks and data running until Ctrl+C (manual/browser testing).
//   --skip-worker  skip the real Whisper worker run (faster iterations).
// PHP binary: $PHP_BIN, else C:/xampp/php/php.exe on Windows and php elsewhere.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

// ---------------------------------------------------------------------------------------------
// Settings

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({
  options: {
    db: { type: 'string', default: 'sqlite' },
    keep: { type: 'boolean', default: false },
    'skip-worker': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const IS_WIN = process.platform === 'win32';
const PHP = process.env.PHP_BIN || (IS_WIN ? 'C:/xampp/php/php.exe' : 'php');
const PORT = { server: 8091, cloud: 8092, hooks: 8093, proxy: 8094 }; // proxy: worker -> php -S recorder
const BASE = `http://127.0.0.1:${PORT.server}`;
const CLOUD = `http://127.0.0.1:${PORT.cloud}`;
const HOOKS = `http://127.0.0.1:${PORT.hooks}`;

const TMP = path.join(ROOT, 'tests', 'tmp', 'e2e');
const CONFIG = path.join(TMP, 'config.php');           // written by the installer
const TEST_CONFIG = path.join(TMP, 'config.e2e.php');  // CONFIG + test limits; this is TAPI_CONFIG
const STORAGE = path.join(TMP, 'storage');

const CLIP = path.join(ROOT, 'tests', 'fixtures', 'clip.mp3');
const CLIP_BYTES = fs.readFileSync(CLIP);

// Throw-away credentials for this test install only.
const ADMIN = { email: 'admin@example.com', password: 'e2e-admin-pass-1' };
const MEMBER = { name: 'Member Person', email: 'member@example.com', password: 'e2e-member-pass-1' };
const WORKER_TOKEN = `e2e-${crypto.randomBytes(20).toString('hex')}`;
const CLOUD_KEY = `mock-${crypto.randomBytes(8).toString('hex')}`;
const MYSQL = {
  host: process.env.E2E_MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.E2E_MYSQL_PORT || 3306),
  user: process.env.E2E_MYSQL_USER || 'root',
  pass: process.env.E2E_MYSQL_PASS ?? '',
  name: 'transcribe_api_test',
};
const DASHBOARD_CSP = "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self'; "
  + "script-src 'self'; connect-src 'self'; frame-ancestors 'none'";

/** Shared state between sections (ids, keys, clients). */
const S = {};

// ---------------------------------------------------------------------------------------------
// Child processes (all tracked, all stopped on exit)

const children = new Set();

function startProcess(name, command, args, { env = {}, cwd = ROOT, stdin = 'ignore' } = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: [stdin, 'pipe', 'pipe'], windowsHide: true });
  const proc = { name, child, stdout: '', stderr: '', exited: null };
  child.stdout.on('data', (chunk) => { proc.stdout += chunk; });
  child.stderr.on('data', (chunk) => { proc.stderr += chunk; });
  proc.done = new Promise((resolve) => {
    child.once('error', (err) => {
      proc.stderr += `[spawn error] ${err.message}\n`;
      proc.exited ??= { code: -1, signal: null };
      resolve(proc.exited);
    });
    child.once('close', (code, signal) => {
      proc.exited ??= { code, signal };
      resolve(proc.exited);
    });
  });
  children.add(proc);
  proc.done.then(() => children.delete(proc));
  return proc;
}

function killProcess(proc) {
  if (proc.exited || !proc.child.pid) return;
  if (IS_WIN) spawnSync('taskkill', ['/PID', String(proc.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else proc.child.kill('SIGTERM');
}

function stopAll() {
  for (const proc of [...children]) killProcess(proc);
}

/** Runs a command to completion without blocking the event loop: {code, stdout, stderr}. */
async function run(command, args, { env, cwd, input, timeoutMs = 120000, name } = {}) {
  const proc = startProcess(name ?? path.basename(command), command, args, { env, cwd, stdin: input === undefined ? 'ignore' : 'pipe' });
  if (input !== undefined) proc.child.stdin.end(input);
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => { killProcess(proc); resolve('timeout'); }, timeoutMs);
  });
  const result = await Promise.race([proc.done, timedOut]);
  clearTimeout(timer);
  if (result === 'timeout') {
    await proc.done;
    return { code: null, timedOut: true, stdout: proc.stdout, stderr: `timed out after ${timeoutMs} ms\n${proc.stderr}` };
  }
  return { code: result.code, stdout: proc.stdout, stderr: proc.stderr };
}

const php = (args, options = {}) => run(PHP, args, { env: { TAPI_CONFIG: TEST_CONFIG }, name: 'php', ...options });

// ---------------------------------------------------------------------------------------------
// Check runner + assertions

const results = [];
let section = '';

function heading(name) {
  section = name;
  console.log(`\n== ${name}`);
}

const oneLine = (text, max = 220) => {
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
};

async function check(name, fn) {
  const started = Date.now();
  let ok = true;
  let detail = '';
  try {
    detail = (await fn()) ?? '';
  } catch (err) {
    ok = false;
    detail = err?.message ?? String(err);
  }
  results.push({ section, name, ok, detail: String(detail), ms: Date.now() - started });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${oneLine(detail, 160)}]` : ''}`);
  return ok;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function eq(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Asserts the HTTP status (and SPEC error code); returns the response. */
function expectStatus(res, status, code) {
  if (res.status !== status) {
    throw new Error(`expected HTTP ${status}${code ? ` ${code}` : ''}, got ${res.status}: ${oneLine(res.text, 300)}`);
  }
  if (code !== undefined && res.data?.error?.code !== code) {
    throw new Error(`expected error code "${code}", got ${JSON.stringify(res.data?.error ?? res.text.slice(0, 200))}`);
  }
  return res;
}

const expectField = (res, field) => eq(res.data?.error?.field, field, 'error.field');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nowSec = () => Math.floor(Date.now() / 1000);
const uploadPath = (id, ext = 'mp3') => path.join(STORAGE, 'uploads', `${id}.${ext}`);
const tail = (text, lines = 25) => String(text).trim().split(/\r?\n/).slice(-lines).join('\n');

async function waitFor(what, fn, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await delay(intervalMs);
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers

/** Minimal HTTP client with a cookie jar and automatic X-CSRF-Token for dashboard sessions. */
class Client {
  constructor(defaultHeaders = {}) {
    this.defaults = defaultHeaders;
    this.cookies = new Map();
    this.csrf = null;
  }

  async request(method, route, { json, form, headers = {}, csrf = true, timeoutMs = 120000 } = {}) {
    const h = { ...this.defaults, ...headers };
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (csrf && this.csrf && method !== 'GET' && !('X-CSRF-Token' in h)) h['X-CSRF-Token'] = this.csrf;
    let body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      h['Content-Type'] = 'application/json';
    } else if (form) {
      body = form;
    }
    const res = await fetch(BASE + route, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const setCookies = res.headers.getSetCookie();
    for (const cookie of setCookies) this.storeCookie(cookie);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let data = null;
    if ((res.headers.get('content-type') || '').includes('json')) {
      try { data = JSON.parse(text); } catch { /* left null: the check reports the raw text */ }
    }
    return { status: res.status, headers: res.headers, body: buf, text, data, setCookies };
  }

  storeCookie(header) {
    const [pair, ...attrs] = header.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const expired = value === '' || value === 'deleted' || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
    if (expired) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }

  get(route, o) { return this.request('GET', route, o); }
  post(route, o) { return this.request('POST', route, o); }
  patch(route, o) { return this.request('PATCH', route, o); }
  delete(route, o) { return this.request('DELETE', route, o); }
}

/** multipart/form-data upload body; `file` defaults to the 40 s clip. */
function uploadForm(fields = {}, file = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  form.append('file', new Blob([file.bytes ?? CLIP_BYTES], { type: file.type ?? 'audio/mpeg' }), file.name ?? 'clip.mp3');
  return form;
}

/** GET with a raw (un-normalised) path, e.g. "/app/../src/Config.php" (fetch would normalise it). */
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT.server, path: rawPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function ping(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/**
 * Reverse proxy in front of php -S that records every request (method, path, auth, body excerpt, status).
 * The PC worker talks to it, so the test sees exactly what the worker sent (heartbeats included).
 */
function startRecordingProxy() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const record = { method: req.method, path: req.url, authorization: req.headers.authorization ?? null,
      userAgent: req.headers['user-agent'] ?? null, body: '', status: null };
    requests.push(record);
    const upstream = http.request({ host: '127.0.0.1', port: PORT.server, method: req.method, path: req.url, headers: req.headers }, (up) => {
      record.status = up.statusCode;
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', (err) => {
      record.status = 502;
      res.writeHead(502).end(err.message);
    });
    req.on('data', (chunk) => {
      if (record.body.length < 4096) record.body += chunk;
      upstream.write(chunk);
    });
    req.on('end', () => upstream.end());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT.proxy, '127.0.0.1', () => resolve({ server, requests }));
  });
}

function portBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

const getJson = async (url, init) => (await fetch(url, { ...init, signal: AbortSignal.timeout(10000) })).json();

/** tests/mock-cloud.mjs control endpoints. */
const cloudMock = {
  requests: async () => (await getJson(`${CLOUD}/_mock/requests`)).requests,
  reset: () => getJson(`${CLOUD}/_mock/reset`, { method: 'POST' }),
  failNext: (status, count) => getJson(`${CLOUD}/_mock/fail`, { method: 'POST', body: JSON.stringify(count ? { status, count } : { status }) }),
};

/** tests/webhook-receiver.mjs control endpoints. */
const hooks = {
  deliveries: async (onPath) => (await getJson(`${HOOKS}/_hook/deliveries`)).deliveries.filter((d) => !onPath || d.path === onPath),
  setSecret: (secret) => getJson(`${HOOKS}/_hook/secret`, { method: 'POST', body: JSON.stringify({ secret }) }),
};

/** One SQL statement against the test install's database (tests/e2e-sql.php). */
async function sql(query, params = []) {
  const r = await php(['tests/e2e-sql.php'], { input: JSON.stringify({ sql: query, params }), name: 'sql' });
  if (r.code !== 0) throw new Error(`SQL helper failed: ${(r.stderr || r.stdout).trim()}`);
  return JSON.parse(r.stdout);
}

/** One statement against the MySQL server itself (create/drop the test database). */
async function mysqlServer(statement) {
  const r = await run(PHP, ['tests/e2e-sql.php'], {
    input: JSON.stringify({ server: MYSQL, sql: statement }),
    name: 'mysql-admin',
    env: { TAPI_CONFIG: '' },
  });
  if (r.code !== 0) throw new Error(`MySQL statement failed: ${oneLine(r.stderr || r.stdout)}`);
}

/** Runs cron/process.php once and parses its "key=value" summary line. */
async function cron() {
  const r = await php(['server/cron/process.php', '--budget=60'], { name: 'cron' });
  if (r.code !== 0) throw new Error(`cron exited with ${r.code}: ${oneLine(r.stderr || r.stdout)}`);
  return { ...r, summary: Object.fromEntries([...r.stdout.matchAll(/(\w+)=(\d+)/g)].map((m) => [m[1], Number(m[2])])) };
}

/** Runs tests/n8n-harness.cjs (the n8n node with a fake n8n context) and returns its output items. */
async function n8n(args, key = S.key1) {
  const out = path.join(TMP, `n8n-${crypto.randomBytes(4).toString('hex')}.json`);
  const r = await run(process.execPath, ['tests/n8n-harness.cjs', ...args, '--quiet', '--out', out], {
    env: { TRANSCRIBE_BASE_URL: BASE, TRANSCRIBE_API_KEY: key },
    name: 'n8n-harness',
    timeoutMs: 180000,
  });
  const items = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  fs.rmSync(out, { force: true });
  return { ...r, items };
}

/** SRT/VTT timestamps, same rounding as server/src/Formatters.php. */
function stamp(seconds, sep) {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
}

/** Shape checks shared by every completed transcription. */
function assertSegments(segments, label = 'segments') {
  assert(Array.isArray(segments) && segments.length > 0, `${label}: expected a non-empty array, got ${JSON.stringify(segments)}`);
  segments.forEach((s, i) => {
    eq(s.id, i, `${label}[${i}].id`);
    assert(typeof s.start === 'number' && typeof s.end === 'number' && s.end >= s.start, `${label}[${i}] has bad times ${JSON.stringify(s)}`);
    assert(typeof s.text === 'string' && s.text.trim() !== '' && s.text === s.text.trim(), `${label}[${i}] has bad text ${JSON.stringify(s.text)}`);
    assert(Math.round(s.start * 100) / 100 === s.start && Math.round(s.end * 100) / 100 === s.end, `${label}[${i}] times are not 2-decimal`);
  });
}

// ---------------------------------------------------------------------------------------------
// Sections

async function setup() {
  heading('Setup');
  let ready = true;

  await check('php -l on every server PHP file', async () => {
    const files = fs.readdirSync(path.join(ROOT, 'server'), { recursive: true })
      .filter((f) => f.endsWith('.php')).map((f) => path.join(ROOT, 'server', f));
    const failures = [];
    for (let i = 0; i < files.length; i += 8) {
      const batch = await Promise.all(files.slice(i, i + 8).map((f) => run(PHP, ['-l', f], { name: 'php-lint' })));
      batch.forEach((r, j) => { if (r.code !== 0) failures.push(`${path.relative(ROOT, files[i + j])}: ${oneLine(r.stdout + r.stderr)}`); });
    }
    assert(failures.length === 0, failures.join('; '));
    return `${files.length} files`;
  });

  ready = await check(`ports ${Object.values(PORT).join(', ')} are free`, async () => {
    const busy = [];
    for (const port of Object.values(PORT)) if (await portBusy(port)) busy.push(port);
    assert(busy.length === 0, `in use: ${busy.join(', ')} (stop whatever listens there and retry)`);
  }) && ready;
  if (!ready) return false;

  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.mkdirSync(TMP, { recursive: true });

  if (opts.db === 'mysql') {
    ready = await check(`MySQL: (re)create database ${MYSQL.name} on ${MYSQL.host}:${MYSQL.port}`, async () => {
      await mysqlServer(`DROP DATABASE IF EXISTS \`${MYSQL.name}\``);
      await mysqlServer(`CREATE DATABASE \`${MYSQL.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    });
    if (!ready) return false;
  }

  ready = await check(`CLI installer creates a fresh ${opts.db} install in tests/tmp/e2e`, async () => {
    const r = await run(PHP, installArgs(), { name: 'install' });
    assert(r.code === 0, `exit ${r.code}: ${oneLine(r.stderr || r.stdout)}`);
    assert(/^Worker token: \S+/m.test(r.stdout), 'no "Worker token:" line in the output');
    assert(fs.existsSync(CONFIG), 'config.php was not written');
    assert(fs.existsSync(path.join(STORAGE, 'installed.lock')), 'storage/installed.lock was not written');
    const config = fs.readFileSync(CONFIG, 'utf8');
    assert(config.includes("__DIR__ . '/storage'"), 'storage_path is not written relative to __DIR__');
    fs.writeFileSync(TEST_CONFIG, [
      '<?php',
      '// e2e: the installer\'s config.php plus small limits so the 413 paths can be tested quickly.',
      "$config = require __DIR__ . '/config.php';",
      "$config['max_upload_mb'] = 2;",
      "$config['cloud']['max_mb'] = 1;",
      "$config['cloud']['max_attempts'] = 2;",
      "$config['webhooks']['timeout'] = 5;",
      'return $config;',
      '',
    ].join('\n'));
  });
  if (!ready) return false;

  return check('start php -S, mock cloud and webhook receiver', async () => {
    S.cloudProc = startProcess('mock-cloud', process.execPath, ['tests/mock-cloud.mjs', '--port', String(PORT.cloud), '--key', CLOUD_KEY]);
    S.hooksProc = startProcess('webhook-receiver', process.execPath, ['tests/webhook-receiver.mjs', '--port', String(PORT.hooks)]);
    S.server = startProcess('php-server', PHP, ['-S', `127.0.0.1:${PORT.server}`, 'server/index.php'], { env: { TAPI_CONFIG: TEST_CONFIG } });
    await waitFor('the three servers to answer', async () => {
      for (const proc of [S.cloudProc, S.hooksProc, S.server]) {
        if (proc.exited) throw new Error(`${proc.name} exited: ${oneLine(proc.stderr + proc.stdout)}`);
      }
      return (await ping(`${BASE}/api/v1/health`)) && (await ping(`${CLOUD}/_mock/requests`)) && (await ping(`${HOOKS}/_hook/deliveries`));
    }, { timeoutMs: 20000 });
    return `php -S pid ${S.server.child.pid}, mock-cloud pid ${S.cloudProc.child.pid}, receiver pid ${S.hooksProc.child.pid}`;
  });
}

function installArgs() {
  const args = [
    'server/install.php',
    `--driver=${opts.db}`,
    `--admin-email=${ADMIN.email}`,
    `--admin-password=${ADMIN.password}`,
    '--admin-name=E2E Admin',
    `--config-path=${CONFIG}`,
    '--allow-private-webhooks',
    `--cloud-base-url=${CLOUD}/v1`,
    `--cloud-api-key=${CLOUD_KEY}`,
    `--worker-token=${WORKER_TOKEN}`,
    '--default-engine=cloud',
  ];
  if (opts.db === 'mysql') {
    args.push(`--db-host=${MYSQL.host}`, `--db-port=${MYSQL.port}`, `--db-name=${MYSQL.name}`, `--db-user=${MYSQL.user}`, `--db-pass=${MYSQL.pass}`);
  }
  return args;
}

async function serverBasics() {
  heading('Server, routing, static files');
  const anon = new Client();

  await check('GET /api/v1/health -> ok, version, both engines', async () => {
    const r = expectStatus(await anon.get('/api/v1/health'), 200);
    eq(r.data, { ok: true, version: '1.0.0', engines: { cloud: true, worker: true } }, 'body');
    eq(r.headers.get('content-type'), 'application/json; charset=utf-8', 'Content-Type');
  });

  await check('security headers on API responses', async () => {
    const r = await anon.get('/api/v1/health');
    eq(r.headers.get('x-content-type-options'), 'nosniff', 'X-Content-Type-Options');
    eq(r.headers.get('x-frame-options'), 'DENY', 'X-Frame-Options');
    eq(r.headers.get('referrer-policy'), 'no-referrer', 'Referrer-Policy');
    assert(!r.headers.get('x-powered-by'), 'X-Powered-By is exposed');
  });

  await check('routing fallback /index.php/api/v1/health', async () => {
    eq(expectStatus(await anon.get('/index.php/api/v1/health'), 200).data?.ok, true, 'ok');
  });

  await check('routing fallback /index.php?route=/api/v1/health', async () => {
    eq(expectStatus(await anon.get('/index.php?route=/api/v1/health'), 200).data?.ok, true, 'ok');
  });

  await check('unknown API route -> 404 not_found JSON; wrong method -> 405', async () => {
    expectStatus(await anon.get('/api/v1/nope'), 404, 'not_found');
    expectStatus(await anon.request('PUT', '/api/v1/health'), 405, 'method_not_allowed');
  });

  await check('GET / serves the dashboard with the SPEC CSP', async () => {
    const r = expectStatus(await anon.get('/'), 200);
    assert((r.headers.get('content-type') || '').startsWith('text/html'), `Content-Type ${r.headers.get('content-type')}`);
    eq(r.headers.get('content-security-policy'), DASHBOARD_CSP, 'Content-Security-Policy');
    eq(r.headers.get('x-frame-options'), 'DENY', 'X-Frame-Options');
    assert(r.text.includes('src="app/app.js"') && r.text.includes('href="app/app.css"'), 'assets are not referenced relatively');
    eq(expectStatus(await anon.get('/index.html'), 200).text, r.text, '/index.html body');
  });

  await check('static assets served from /app/ with the right MIME types', async () => {
    const expected = { 'app.js': 'text/javascript', 'app.css': 'text/css', 'favicon.svg': 'image/svg+xml' };
    for (const [file, mime] of Object.entries(expected)) {
      const r = expectStatus(await anon.get(`/app/${file}`), 200);
      assert((r.headers.get('content-type') || '').startsWith(mime), `${file}: Content-Type ${r.headers.get('content-type')}`);
      assert(r.body.equals(fs.readFileSync(path.join(ROOT, 'server', 'app', file))), `${file}: body differs from disk`);
    }
    expectStatus(await anon.get('/app/missing.js'), 404);
  });

  await check('private files are never served (src/, storage/, cron/, config, dotfiles, traversal)', async () => {
    const paths = [
      '/src/Config.php', '/src/bootstrap.php', '/src/.htaccess', '/cron/process.php', '/config.php', '/config.sample.php',
      '/storage/.htaccess', '/storage/.gitignore', '/.htaccess', '/.user.ini', '/server/config.sample.php', '/server/src/Db.php',
      '/tests/tmp/e2e/config.php', '/tests/tmp/e2e/config.e2e.php', '/tests/tmp/e2e/storage/app.sqlite',
      '/tests/tmp/e2e/storage/installed.lock', '/SPEC.md', '/app/../src/Config.php', '/app/..%2fsrc/Config.php',
      '/app/%2e%2e/src/Config.php', '/app/..\\src\\Config.php', '/app/', '/app',
    ];
    const leaks = [];
    for (const p of paths) {
      const r = await rawGet(p);
      const leaked = r.text.includes('<?php') || r.text.includes('Require all denied') || r.text.includes(WORKER_TOKEN)
        || r.text.includes(CLOUD_KEY) || r.text.includes('SQLite format');
      if (![403, 404].includes(r.status) || leaked) leaks.push(`${p} -> ${r.status}${leaked ? ' (content leaked)' : ''}`);
    }
    assert(leaks.length === 0, leaks.join('; '));
    return `${paths.length} paths`;
  });

  await check('install.php is locked after installation (403 page, no source)', async () => {
    const r = await anon.get('/install.php');
    eq(r.status, 403, 'status');
    assert(!r.text.includes('<?php'), 'install.php source was served');
  });

  await check('config: placeholder or short worker tokens are never accepted', async () => {
    const script = "<?php require 'server/src/bootstrap.php';"
      + "\\Tapi\\Config::set(['worker' => ['tokens' => ['<random 48 hex>', 'short', '', str_repeat('a', 16)]]]);"
      + 'echo json_encode(\\Tapi\\Config::workerTokens());';
    const r = await run(PHP, [], { input: script, name: 'php-config' });
    eq(r.stdout.trim(), JSON.stringify(['a'.repeat(16)]), `workerTokens() (${oneLine(r.stderr)})`);
  });

  await check('installer refuses a second run (exit 1)', async () => {
    const r = await run(PHP, installArgs(), { name: 'install-again' });
    eq(r.code, 1, 'exit code');
    assert(/already installed/i.test(r.stderr), `stderr: ${oneLine(r.stderr)}`);
  });
}

async function dashboardApi() {
  heading('Dashboard API');
  const admin = (S.admin = new Client());

  await check('GET /api/dash/me signed out -> 401 with public config', async () => {
    const r = expectStatus(await admin.get('/api/dash/me'), 401, 'unauthorized');
    eq(r.data.config?.allow_registration, false, 'config.allow_registration');
  });

  await check('register while registration is disabled -> 403', async () => {
    expectStatus(await admin.post('/api/dash/register', { json: { name: 'X', email: 'x@example.com', password: 'whatever-123' } }), 403, 'forbidden');
  });

  await check('login with a wrong password -> 401', async () => {
    expectStatus(await admin.post('/api/dash/login', { json: { email: ADMIN.email, password: 'wrong-password' } }), 401, 'unauthorized');
    expectStatus(await admin.post('/api/dash/login', { json: { password: 'x' } }), 422, 'validation_error');
  });

  await check('login -> user + csrf_token + HttpOnly SameSite=Lax cookie', async () => {
    const r = expectStatus(await admin.post('/api/dash/login', { json: ADMIN }), 200);
    eq(r.data.user.email, ADMIN.email, 'user.email');
    eq(r.data.user.is_admin, true, 'user.is_admin');
    assert(/^usr_[a-f0-9]{24}$/.test(r.data.user.id), `user.id ${r.data.user.id}`);
    assert(/^[a-f0-9]{64}$/.test(r.data.csrf_token ?? ''), 'csrf_token missing');
    const cookie = r.setCookies.find((c) => c.startsWith('tapi_session='));
    assert(cookie && /httponly/i.test(cookie) && /samesite=lax/i.test(cookie) && /path=\//i.test(cookie), `session cookie: ${cookie}`);
    admin.csrf = r.data.csrf_token;
    S.adminId = r.data.user.id;
  });

  await check('GET /api/dash/me -> user, csrf_token, config', async () => {
    const r = expectStatus(await admin.get('/api/dash/me'), 200);
    eq(r.data.csrf_token, admin.csrf, 'csrf_token');
    eq(r.data.user.email, ADMIN.email, 'user.email');
    eq(r.data.config, {
      allow_registration: false,
      engines: { cloud: true, worker: true },
      allowed_extensions: ['mp3'],
      max_upload_mb: 2,
      cloud_max_mb: 1,
      base_url: `${BASE}/`,
      version: '1.0.0',
    }, 'config');
  });

  await check('missing X-CSRF-Token -> 403 csrf_failed', async () => {
    expectStatus(await admin.post('/api/dash/projects', { json: { name: 'x' }, csrf: false }), 403, 'csrf_failed');
  });

  await check('wrong X-CSRF-Token -> 403 csrf_failed', async () => {
    expectStatus(await admin.post('/api/dash/projects', { json: { name: 'x' }, headers: { 'X-CSRF-Token': 'f'.repeat(64) } }), 403, 'csrf_failed');
  });

  await check('cross-origin request with a valid token -> 403', async () => {
    expectStatus(await admin.post('/api/dash/projects', { json: { name: 'x' }, headers: { Origin: 'http://evil.example' } }), 403, 'csrf_failed');
  });

  await check('create project -> 201 owner with webhook secret and empty stats', async () => {
    const r = expectStatus(await admin.post('/api/dash/projects', { json: { name: 'E2E Project' } }), 201);
    assert(/^prj_[a-f0-9]{24}$/.test(r.data.id), `id ${r.data.id}`);
    eq(r.data.role, 'owner', 'role');
    eq(r.data.default_engine, 'cloud', 'default_engine');
    eq(r.data.stats, { transcriptions: 0, completed: 0, failed: 0, queued: 0 }, 'stats');
    assert(/^whsec_[a-f0-9]{48}$/.test(r.data.webhook_secret ?? ''), 'webhook_secret');
    S.p1 = r.data.id;
    const list = expectStatus(await admin.get('/api/dash/projects'), 200);
    assert(list.data.data.some((p) => p.id === S.p1), 'new project missing from the list');
  });

  await check('PATCH project settings (name, engine, language, webhook URL)', async () => {
    const r = expectStatus(await admin.patch(`/api/dash/projects/${S.p1}`, {
      json: { name: 'E2E Project (renamed)', default_engine: 'cloud', default_language: 'en', webhook_url: `${HOOKS}/hooks/project` },
    }), 200);
    eq(r.data.name, 'E2E Project (renamed)', 'name');
    eq(r.data.default_language, 'en', 'default_language');
    eq(r.data.webhook_url, `${HOOKS}/hooks/project`, 'webhook_url');
  });

  await check('PATCH validation -> 422 with field', async () => {
    expectField(expectStatus(await admin.patch(`/api/dash/projects/${S.p1}`, { json: { default_engine: 'gpu' } }), 422, 'validation_error'), 'default_engine');
    expectField(expectStatus(await admin.patch(`/api/dash/projects/${S.p1}`, { json: { webhook_url: 'ftp://example.com/x' } }), 422, 'validation_error'), 'webhook_url');
    expectField(expectStatus(await admin.patch(`/api/dash/projects/${S.p1}`, { json: { default_language: 'klingon' } }), 422, 'validation_error'), 'default_language');
    expectField(expectStatus(await admin.patch(`/api/dash/projects/${S.p1}`, { json: { name: '   ' } }), 422, 'validation_error'), 'name');
  });

  await check('rotate webhook secret -> new whsec_ value', async () => {
    const before = expectStatus(await admin.get(`/api/dash/projects/${S.p1}`), 200).data.webhook_secret;
    const r = expectStatus(await admin.post(`/api/dash/projects/${S.p1}/webhook-secret`), 200);
    assert(/^whsec_[a-f0-9]{48}$/.test(r.data.webhook_secret ?? ''), 'webhook_secret format');
    assert(r.data.webhook_secret !== before, 'secret did not change');
    eq(expectStatus(await admin.get(`/api/dash/projects/${S.p1}`), 200).data.webhook_secret, r.data.webhook_secret, 'GET project secret');
    S.p1Secret = r.data.webhook_secret;
    await hooks.setSecret(S.p1Secret);
  });

  await check('API keys: create (shown once), list, revoke', async () => {
    const created = expectStatus(await admin.post(`/api/dash/projects/${S.p1}/keys`, { json: { name: 'e2e key' } }), 201).data;
    assert(/^tk_[a-f0-9]{40}$/.test(created.key ?? ''), 'key format');
    eq(created.prefix, created.key.slice(0, 11), 'prefix');
    assert(/^key_[a-f0-9]{24}$/.test(created.id), `id ${created.id}`);
    S.key1 = created.key;
    S.key1Id = created.id;
    const doomed = expectStatus(await admin.post(`/api/dash/projects/${S.p1}/keys`, { json: { name: 'to revoke' } }), 201).data;
    S.revokedKey = doomed.key;
    const revoked = expectStatus(await admin.delete(`/api/dash/projects/${S.p1}/keys/${doomed.id}`), 200).data;
    assert(revoked.revoked_at, 'revoked_at not set');
    const list = expectStatus(await admin.get(`/api/dash/projects/${S.p1}/keys`), 200).data.data;
    eq(list.length, 2, 'key count');
    assert(list.every((k) => !('key' in k) && !('key_hash' in k)), 'list exposes key material');
    assert(list.find((k) => k.id === doomed.id)?.revoked_at, 'revoked key not marked in the list');
    expectStatus(await admin.delete(`/api/dash/projects/${S.p1}/keys/key_${'0'.repeat(24)}`), 404, 'not_found');
  });

  await check('admin creates a second user; duplicate email -> 422', async () => {
    const r = expectStatus(await admin.post('/api/dash/users', { json: { ...MEMBER, is_admin: false } }), 201);
    eq(r.data.email, MEMBER.email, 'email');
    eq(r.data.is_admin, false, 'is_admin');
    eq(r.data.disabled, false, 'disabled');
    S.memberId = r.data.id;
    expectField(expectStatus(await admin.post('/api/dash/users', { json: { ...MEMBER } }), 422, 'validation_error'), 'email');
    expectField(expectStatus(await admin.post('/api/dash/users', { json: { name: 'Short', email: 's@example.com', password: 'short' } }), 422, 'validation_error'), 'password');
    const users = expectStatus(await admin.get('/api/dash/users'), 200).data.data;
    eq(users.map((u) => u.email).sort(), [ADMIN.email, MEMBER.email].sort(), 'user list');
  });

  await check('add member by email; unknown email -> 422', async () => {
    const r = expectStatus(await admin.post(`/api/dash/projects/${S.p1}/members`, { json: { email: MEMBER.email, role: 'member' } }), 201);
    eq([r.data.user_id, r.data.role], [S.memberId, 'member'], 'member');
    expectField(expectStatus(await admin.post(`/api/dash/projects/${S.p1}/members`, { json: { email: 'nobody@example.com' } }), 422, 'validation_error'), 'email');
    const members = expectStatus(await admin.get(`/api/dash/projects/${S.p1}/members`), 200).data.data;
    eq(members.map((m) => m.role).sort(), ['member', 'owner'], 'member roles');
  });

  const member = (S.member = new Client());
  await check('member signs in and sees the project as member (no secret)', async () => {
    const r = expectStatus(await member.post('/api/dash/login', { json: { email: MEMBER.email, password: MEMBER.password } }), 200);
    member.csrf = r.data.csrf_token;
    const projects = expectStatus(await member.get('/api/dash/projects'), 200).data.data;
    eq(projects.map((p) => [p.id, p.role]), [[S.p1, 'member']], 'projects');
    const project = expectStatus(await member.get(`/api/dash/projects/${S.p1}`), 200).data;
    assert(!('webhook_secret' in project), 'member can see the webhook secret');
  });

  await check('member cannot manage keys, settings, secret or users (403)', async () => {
    expectStatus(await member.post(`/api/dash/projects/${S.p1}/keys`, { json: { name: 'nope' } }), 403, 'forbidden');
    expectStatus(await member.get(`/api/dash/projects/${S.p1}/keys`), 403, 'forbidden');
    expectStatus(await member.patch(`/api/dash/projects/${S.p1}`, { json: { name: 'hijack' } }), 403, 'forbidden');
    expectStatus(await member.post(`/api/dash/projects/${S.p1}/webhook-secret`), 403, 'forbidden');
    expectStatus(await member.delete(`/api/dash/projects/${S.p1}`), 403, 'forbidden');
    expectStatus(await member.get('/api/dash/users'), 403, 'forbidden');
  });

  await check('member can list transcriptions and members', async () => {
    const r = expectStatus(await member.get(`/api/dash/projects/${S.p1}/transcriptions`), 200);
    eq([r.data.object, Array.isArray(r.data.data), r.data.limit, r.data.offset], ['list', true, 20, 0], 'list shape');
    expectStatus(await member.get(`/api/dash/projects/${S.p1}/members`), 200);
  });

  await check('cross-project access is denied (dashboard 404, other project key 404)', async () => {
    S.p2 = expectStatus(await admin.post('/api/dash/projects', { json: { name: 'Other project' } }), 201).data.id;
    const upload = expectStatus(await admin.post(`/api/dash/projects/${S.p2}/transcriptions`, { form: uploadForm({ engine: 'cloud', wait: 'true' }) }), 200);
    eq(upload.data.status, 'completed', 'P2 upload status');
    S.p2Tr = upload.data.id;
    expectStatus(await member.get(`/api/dash/projects/${S.p2}`), 404, 'not_found');
    expectStatus(await member.get(`/api/dash/projects/${S.p2}/transcriptions`), 404, 'not_found');
    expectStatus(await member.post(`/api/dash/projects/${S.p2}/transcriptions`, { form: uploadForm({ engine: 'cloud' }) }), 404, 'not_found');
    expectStatus(await member.get(`/api/dash/transcriptions/${S.p2Tr}`), 404, 'not_found');
    expectStatus(await member.get(`/api/dash/transcriptions/${S.p2Tr}/audio`), 404, 'not_found');
    expectStatus(await member.delete(`/api/dash/transcriptions/${S.p2Tr}`), 404, 'not_found');
    const key = new Client({ Authorization: `Bearer ${S.key1}` });
    expectStatus(await key.get(`/api/v1/transcriptions/${S.p2Tr}`), 404, 'not_found');
    expectStatus(await key.delete(`/api/v1/transcriptions/${S.p2Tr}`), 404, 'not_found');
    assert(fs.existsSync(uploadPath(S.p2Tr)), 'P2 audio was deleted by a foreign request');
  });

  await check('disabling a user ends their session; re-enable works', async () => {
    expectField(expectStatus(await admin.patch(`/api/dash/users/${S.adminId}`, { json: { disabled: true } }), 422, 'validation_error'), 'disabled');
    eq(expectStatus(await admin.patch(`/api/dash/users/${S.memberId}`, { json: { disabled: true } }), 200).data.disabled, true, 'disabled');
    expectStatus(await member.get('/api/dash/me'), 401, 'unauthorized');
    expectStatus(await member.post('/api/dash/login', { json: { email: MEMBER.email, password: MEMBER.password } }), 403, 'forbidden');
    eq(expectStatus(await admin.patch(`/api/dash/users/${S.memberId}`, { json: { disabled: false } }), 200).data.disabled, false, 're-enabled');
    member.csrf = expectStatus(await member.post('/api/dash/login', { json: { email: MEMBER.email, password: MEMBER.password } }), 200).data.csrf_token;
  });

  await check('remove member (last owner protected); removed member loses access', async () => {
    expectStatus(await admin.delete(`/api/dash/projects/${S.p1}/members/${S.adminId}`), 422, 'validation_error');
    const r = expectStatus(await admin.delete(`/api/dash/projects/${S.p1}/members/${S.memberId}`), 200);
    eq(r.data, { user_id: S.memberId, deleted: true }, 'body');
    expectStatus(await member.get(`/api/dash/projects/${S.p1}`), 404, 'not_found');
    eq(expectStatus(await member.get('/api/dash/projects'), 200).data.data, [], 'member project list');
  });
}

async function publicApiAuth() {
  heading('Public API: auth and validation');
  const anon = new Client();
  const api = (S.api = new Client({ Authorization: `Bearer ${S.key1}` }));

  await check('no API key -> 401 unauthorized', async () => {
    expectStatus(await anon.get('/api/v1/transcriptions'), 401, 'unauthorized');
  });

  await check('malformed / unknown API key -> 401 invalid_api_key', async () => {
    expectStatus(await anon.get('/api/v1/transcriptions', { headers: { Authorization: 'Bearer nonsense' } }), 401, 'invalid_api_key');
    expectStatus(await anon.get('/api/v1/transcriptions', { headers: { Authorization: `Bearer tk_${'0'.repeat(40)}` } }), 401, 'invalid_api_key');
  });

  await check('revoked API key -> 401 invalid_api_key', async () => {
    expectStatus(await anon.get('/api/v1/transcriptions', { headers: { Authorization: `Bearer ${S.revokedKey}` } }), 401, 'invalid_api_key');
  });

  await check('Bearer key lists transcriptions; last_used_at is recorded', async () => {
    const r = expectStatus(await api.get('/api/v1/transcriptions'), 200);
    eq([r.data.object, r.data.total, r.data.limit, r.data.offset], ['list', 0, 20, 0], 'list shape');
    const keys = expectStatus(await S.admin.get(`/api/dash/projects/${S.p1}/keys`), 200).data.data;
    assert(keys.find((k) => k.id === S.key1Id)?.last_used_at, 'last_used_at not set');
  });

  await check('X-API-Key header works', async () => {
    expectStatus(await anon.get('/api/v1/transcriptions?limit=1', { headers: { 'X-API-Key': S.key1 } }), 200);
  });

  await check('upload validation: missing file 422, .wav 415, >max_upload_mb 413, >cloud.max_mb 413', async () => {
    const noFile = new FormData();
    noFile.append('engine', 'cloud');
    expectField(expectStatus(await api.post('/api/v1/transcriptions', { form: noFile }), 422, 'validation_error'), 'file');
    expectStatus(await api.post('/api/v1/transcriptions', { form: uploadForm({}, { name: 'clip.wav', type: 'audio/wav' }) }), 415, 'unsupported_file_type');
    expectStatus(await api.post('/api/v1/transcriptions', {
      form: uploadForm({ engine: 'worker' }, { bytes: Buffer.alloc(Math.round(2.5 * 1048576), 1), name: 'big.mp3' }),
    }), 413, 'file_too_large');
    const cloudTooBig = expectStatus(await api.post('/api/v1/transcriptions', {
      form: uploadForm({ engine: 'cloud' }, { bytes: Buffer.alloc(Math.round(1.5 * 1048576), 1), name: 'medium.mp3' }),
    }), 413, 'file_too_large');
    assert(/worker/.test(cloudTooBig.data.error.message), `413 message should suggest engine=worker: ${cloudTooBig.data.error.message}`);
    const left = await sql('SELECT COUNT(*) AS n FROM transcriptions WHERE project_id = ?', [S.p1]);
    eq(Number(left.rows[0].n), 0, 'rejected uploads must not create rows');
  });

  await check('upload validation: engine, task, language, metadata, prompt, webhook_url -> 422', async () => {
    const cases = [
      [{ engine: 'gpu' }, 'engine'],
      [{ task: 'summarize' }, 'task'],
      [{ language: 'klingon' }, 'language'],
      [{ metadata: '[1,2]' }, 'metadata'],
      [{ metadata: '{"a":' }, 'metadata'],
      [{ metadata: JSON.stringify({ blob: 'x'.repeat(5000) }) }, 'metadata'],
      [{ prompt: 'p'.repeat(1001) }, 'prompt'],
      [{ webhook_url: 'ftp://example.com/hook' }, 'webhook_url'],
    ];
    for (const [fields, field] of cases) {
      expectField(expectStatus(await api.post('/api/v1/transcriptions', { form: uploadForm(fields) }), 422, 'validation_error'), field);
    }
    return `${cases.length} cases`;
  });

  await check('list validation: bad limit/status -> 422; limit capped at 100', async () => {
    expectField(expectStatus(await api.get('/api/v1/transcriptions?limit=abc'), 422, 'validation_error'), 'limit');
    expectField(expectStatus(await api.get('/api/v1/transcriptions?status=bogus'), 422, 'validation_error'), 'status');
    eq(expectStatus(await api.get('/api/v1/transcriptions?limit=500'), 200).data.limit, 100, 'limit');
  });
}

async function workerEngine() {
  heading('Worker engine (real PC worker)');
  const api = S.api;

  await check('upload engine=worker -> 202 queued with project defaults and metadata', async () => {
    const r = expectStatus(await api.post('/api/v1/transcriptions', {
      form: uploadForm({ engine: 'worker', metadata: { order: 42, tag: 'e2e' }, webhook_url: `${HOOKS}/hooks/worker-job`, wait: 'true' }),
    }), 202);
    const t = r.data;
    assert(/^tr_[a-f0-9]{24}$/.test(t.id), `id ${t.id}`);
    eq([t.object, t.status, t.engine, t.language, t.task, t.filename, t.file_size], ['transcription', 'queued', 'worker', 'en', 'transcribe', 'clip.mp3', CLIP_BYTES.length], 'fields');
    eq([t.text, t.segments, t.progress, t.webhook_status, t.started_at, t.completed_at], [null, null, null, null, null, null], 'empty fields');
    eq(t.metadata, { order: 42, tag: 'e2e' }, 'metadata');
    assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(t.created_at), `created_at ${t.created_at}`);
    assert(fs.readFileSync(uploadPath(t.id)).equals(CLIP_BYTES), 'stored upload differs from the original');
    S.workerTr = t.id;
  });

  await check('format download before completion -> 409 not_ready', async () => {
    expectStatus(await api.get(`/api/v1/transcriptions/${S.workerTr}?format=txt`), 409, 'not_ready');
  });

  if (opts['skip-worker']) {
    console.log('  (skipped the real worker run: --skip-worker)');
    await sql("UPDATE transcriptions SET status = 'failed', error = 'skipped' WHERE id = ?", [S.workerTr]);
    return;
  }

  await check('node worker/worker.js --once (whisper-tiny) completes the job', async () => {
    const proxy = await startRecordingProxy();
    S.proxyLog = proxy.requests;
    const proc = startProcess('worker', process.execPath, ['worker.js', '--once', '--env', 'none'], {
      cwd: path.join(ROOT, 'worker'),
      env: {
        API_BASE: `http://127.0.0.1:${PORT.proxy}`,
        WORKER_TOKEN,
        WORKER_NAME: 'e2e-worker',
        MODEL: 'onnx-community/whisper-tiny',
        DTYPE: 'fp32', // tiny's q8 weights produce nonsense (see worker/README.md)
        DEVICE: 'cpu',
        HEARTBEAT_SECONDS: '5',
        POLL_SECONDS: '1',
      },
    });
    S.workerProc = proc;
    const seen = [];
    const deadline = Date.now() + 5 * 60 * 1000;
    try {
      while (!proc.exited) {
        const r = await api.get(`/api/v1/transcriptions/${S.workerTr}`).catch(() => null);
        if (r?.data?.status) seen.push(`${r.data.status}:${r.data.progress}`);
        if (Date.now() > deadline) {
          killProcess(proc);
          throw new Error(`worker did not finish within 5 minutes:\n${tail(proc.stdout + proc.stderr)}`);
        }
        await delay(300);
      }
    } finally {
      proxy.server.close();
    }
    eq(proc.exited.code, 0, `worker exit code (output: ${oneLine(tail(proc.stdout + proc.stderr, 6), 400)})`);
    assert(seen.some((s) => /^processing:\d+$/.test(s)), `never observed status=processing with a progress value (saw ${[...new Set(seen)].join(', ')})`);
    assert(!proc.stdout.includes(WORKER_TOKEN) && !proc.stderr.includes(WORKER_TOKEN), 'the worker logged its token');
    return `observed ${[...new Set(seen)].join(' -> ')}`;
  });

  await check('worker result stored: completed, text, segments with ids, duration, language', async () => {
    const t = expectStatus(await api.get(`/api/v1/transcriptions/${S.workerTr}`), 200).data;
    eq([t.status, t.progress, t.error, t.detected_language], ['completed', 100, null, 'en'], 'status/progress/error/language');
    assert(typeof t.text === 'string' && t.text.trim().length > 20, `text too short: ${JSON.stringify(t.text)}`);
    assertSegments(t.segments);
    assert(Math.abs(t.duration - 40) < 1.5, `duration ${t.duration}`);
    assert(t.started_at && t.completed_at, 'started_at/completed_at not set');
    const row = (await sql('SELECT worker_name, attempts, locked_until FROM transcriptions WHERE id = ?', [S.workerTr])).rows[0];
    eq([row.worker_name, Number(row.attempts), row.locked_until], ['e2e-worker', 1, null], 'worker_name/attempts/locked_until');
    S.workerResult = t;
    return `${t.segments.length} segments: "${oneLine(t.text, 60)}"`;
  });

  await check('worker protocol: health -> claim -> audio -> heartbeat(progress) -> complete, token on every call', async () => {
    const log = S.proxyLog ?? [];
    const jobPath = `/api/worker/jobs/${S.workerTr}`;
    const step = (r) => {
      if (r.path === '/api/v1/health') return 'health';
      if (r.path === '/api/worker/claim') return 'claim';
      return r.path.startsWith(`${jobPath}/`) ? r.path.slice(jobPath.length + 1) : r.path;
    };
    const sequence = log.map(step).filter((s, i, all) => s !== all[i - 1]); // collapse repeated heartbeats
    eq(sequence, ['health', 'claim', 'audio', 'heartbeat', 'complete'], 'request sequence');
    const failed = log.filter((r) => r.status !== 200);
    assert(failed.length === 0, `non-200 answers: ${failed.map((r) => `${r.method} ${r.path} ${r.status}`).join(', ')}`);
    assert(log.every((r) => r.authorization === `Bearer ${WORKER_TOKEN}`), 'a request was sent without the worker token');
    assert(log.every((r) => /^TranscribeWorker\/1\.0 /.test(r.userAgent ?? '')), `User-Agent: ${log[0]?.userAgent}`);
    const progress = log.filter((r) => step(r) === 'heartbeat').map((r) => JSON.parse(r.body).progress);
    assert(progress.length > 0 && progress.every((p) => Number.isInteger(p) && p >= 0 && p <= 99), `heartbeat progress values ${JSON.stringify(progress)}`);
    const complete = JSON.parse(log.find((r) => step(r) === 'complete').body);
    assert(complete.segments.every((s) => !('id' in s)), 'complete segments carry ids (the server assigns them)');
    return `${progress.length} heartbeat(s), progress ${progress.join(', ')}`;
  });

  await check('downloads: txt / srt / vtt / json with MIME types and attachment names', async () => {
    const t = S.workerResult;
    const expected = {
      txt: ['text/plain; charset=utf-8', `${t.segments.map((s) => s.text).join('\n')}\n`],
      srt: ['application/x-subrip; charset=utf-8',
        t.segments.map((s, i) => `${i + 1}\n${stamp(s.start, ',')} --> ${stamp(s.end, ',')}\n${s.text}\n`).join('\n')],
      vtt: ['text/vtt; charset=utf-8', `WEBVTT\n\n${t.segments.map((s) => `${stamp(s.start, '.')} --> ${stamp(s.end, '.')}\n${s.text}\n`).join('\n')}`],
      json: ['application/json; charset=utf-8', null],
    };
    for (const [format, [mime, body]] of Object.entries(expected)) {
      const r = expectStatus(await api.get(`/api/v1/transcriptions/${S.workerTr}?format=${format}`), 200);
      eq(r.headers.get('content-type'), mime, `${format} Content-Type`);
      const disposition = r.headers.get('content-disposition') || '';
      assert(disposition.startsWith('attachment;') && disposition.includes(`filename="clip.${format}"`), `${format} Content-Disposition: ${disposition}`);
      if (body !== null) eq(r.text, body, `${format} body`);
      else eq(JSON.parse(r.text), t, 'json body');
    }
    expectField(expectStatus(await api.get(`/api/v1/transcriptions/${S.workerTr}?format=docx`), 422, 'validation_error'), 'format');
    const dash = expectStatus(await S.admin.get(`/api/dash/transcriptions/${S.workerTr}?format=srt`), 200);
    eq(dash.text, expected.srt[1], 'dashboard srt body');
  });

  await check('webhook transcription.completed delivered with a valid signature', async () => {
    const [d] = await waitFor('the webhook delivery', async () => {
      const list = await hooks.deliveries('/hooks/worker-job');
      return list.length ? list : null;
    });
    eq(d.signature_valid, true, 'signature_valid');
    eq([d.headers['x-transcribe-event'], d.headers['x-transcribe-delivery'], d.headers['user-agent'], d.headers['content-type']],
      ['transcription.completed', S.workerTr, 'TranscribeAPI/1.0', 'application/json'], 'headers');
    eq([d.json?.event, d.json?.data?.id, d.json?.data?.status], ['transcription.completed', S.workerTr, 'completed'], 'payload');
    eq(d.json.data.segments, S.workerResult.segments, 'payload segments');
    eq(d.json.data.metadata, { order: 42, tag: 'e2e' }, 'payload metadata');
    const t = await waitFor('webhook_status=delivered', async () => {
      const r = await api.get(`/api/v1/transcriptions/${S.workerTr}`);
      return r.data?.webhook_status === 'delivered' ? r.data : null;
    }, { timeoutMs: 5000 });
    eq(t.webhook_status, 'delivered', 'webhook_status');
  });

  await check('list omits segments; status filter works', async () => {
    const r = expectStatus(await api.get('/api/v1/transcriptions?status=completed'), 200);
    const item = r.data.data.find((x) => x.id === S.workerTr);
    assert(item, 'job missing from ?status=completed');
    assert(!('segments' in item) && typeof item.text === 'string', 'list item shape');
    eq(expectStatus(await api.get('/api/v1/transcriptions?status=queued'), 200).data.total, 0, 'queued total');
  });
}

async function workerApi() {
  heading('Worker API semantics');
  const api = S.api;
  const worker = new Client({ Authorization: `Bearer ${WORKER_TOKEN}` });
  const claim = (name = 'e2e-manual') => worker.post('/api/worker/claim', { json: { worker: name } });
  const job = (id, action, body = {}) => worker.post(`/api/worker/jobs/${id}/${action}`, { json: body });
  const uploadWorkerJob = async (fields = {}) => expectStatus(await api.post('/api/v1/transcriptions', { form: uploadForm({ engine: 'worker', ...fields }) }), 202).data.id;
  const getTr = async (id) => expectStatus(await api.get(`/api/v1/transcriptions/${id}`), 200).data;
  const row = async (id) => (await sql('SELECT attempts, worker_name, locked_until, progress FROM transcriptions WHERE id = ?', [id])).rows[0];

  await check('worker token required: none / wrong -> 401', async () => {
    expectStatus(await new Client().post('/api/worker/claim', { json: {} }), 401, 'unauthorized');
    expectStatus(await new Client({ Authorization: 'Bearer wrong-token-0123456789' }).post('/api/worker/claim', { json: {} }), 401, 'unauthorized');
  });

  await check('claim with an empty queue -> 204', async () => {
    eq((await claim()).status, 204, 'status');
  });

  await check('claim -> job with audio_url, lease; audio download incl. Range', async () => {
    S.w2 = await uploadWorkerJob({ language: 'de', task: 'translate' });
    const r = expectStatus(await claim(), 200);
    const j = r.data.job;
    eq([j.id, j.filename, j.language, j.task, j.engine, j.file_size, j.lease_seconds], [S.w2, 'clip.mp3', 'de', 'translate', 'worker', CLIP_BYTES.length, 900], 'job');
    eq(j.audio_url, `api/worker/jobs/${S.w2}/audio`, 'audio_url (base-relative)');
    const audioUrl = new URL(j.audio_url, `${BASE}/`);
    const full = await fetch(audioUrl, { headers: { Authorization: `Bearer ${WORKER_TOKEN}` } });
    eq(full.status, 200, 'audio status');
    assert(Buffer.from(await full.arrayBuffer()).equals(CLIP_BYTES), 'audio bytes differ');
    const part = await fetch(audioUrl, { headers: { Authorization: `Bearer ${WORKER_TOKEN}`, Range: 'bytes=0-1023' } });
    eq([part.status, part.headers.get('content-range')], [206, `bytes 0-1023/${CLIP_BYTES.length}`], 'range');
    eq((await fetch(audioUrl)).status, 401, 'audio without token');
    const t = await getTr(S.w2);
    eq([t.status, t.progress], ['processing', 0], 'status/progress after claim');
    assert(t.started_at, 'started_at not set');
  });

  await check('heartbeat stores progress and extends the lease', async () => {
    await sql('UPDATE transcriptions SET locked_until = ? WHERE id = ?', [nowSec() + 30, S.w2]);
    eq(expectStatus(await job(S.w2, 'heartbeat', { progress: 42 }), 200).data, { ok: true }, 'body');
    eq((await getTr(S.w2)).progress, 42, 'progress');
    assert(Number((await row(S.w2)).locked_until) >= nowSec() + 800, 'lease not extended');
    expectField(expectStatus(await job(S.w2, 'heartbeat', { progress: 'abc' }), 422, 'validation_error'), 'progress');
  });

  await check('fail retry:true re-queues; next claim gets it again (attempt 2)', async () => {
    eq(expectStatus(await job(S.w2, 'fail', { error: 'network hiccup', retry: true }), 200).data, { ok: true }, 'body');
    const t = await getTr(S.w2);
    eq([t.status, t.progress], ['queued', null], 'after retry');
    eq(expectStatus(await claim(), 200).data.job.id, S.w2, 'claimed id');
    eq(Number((await row(S.w2)).attempts), 2, 'attempts');
  });

  await check('fail retry:false -> failed + transcription.failed webhook', async () => {
    eq(expectStatus(await job(S.w2, 'fail', { error: 'Decoder exploded', retry: false }), 200).data, { ok: true }, 'body');
    const t = await getTr(S.w2);
    eq([t.status, t.error], ['failed', 'Decoder exploded'], 'status/error');
    assert(t.completed_at, 'completed_at not set');
    const d = await waitFor('the failed webhook', async () => (await hooks.deliveries('/hooks/project')).find((x) => x.json?.data?.id === S.w2));
    eq([d.json.event, d.signature_valid], ['transcription.failed', true], 'event/signature');
  });

  await check('job endpoints -> 404 for jobs that are not claimed', async () => {
    for (const action of ['heartbeat', 'complete', 'fail']) expectStatus(await job(S.w2, action, { progress: 1 }), 404, 'not_found');
    expectStatus(await worker.get(`/api/worker/jobs/${S.w2}/audio`), 404, 'not_found');
    expectStatus(await job(`tr_${'0'.repeat(24)}`, 'heartbeat'), 404, 'not_found');
    expectStatus(await job(S.workerTr ?? S.w2, 'complete', { text: 'x' }), 404, 'not_found');
  });

  await check('expired lease is reclaimed by another worker', async () => {
    S.w3 = await uploadWorkerJob();
    eq(expectStatus(await claim('worker-a'), 200).data.job.id, S.w3, 'first claim');
    eq((await claim('worker-b')).status, 204, 'claim while the lease is valid');
    await sql('UPDATE transcriptions SET locked_until = ? WHERE id = ?', [nowSec() - 5, S.w3]);
    eq(expectStatus(await claim('worker-b'), 200).data.job.id, S.w3, 'reclaim');
    const r = await row(S.w3);
    eq([r.worker_name, Number(r.attempts)], ['worker-b', 2], 'worker_name/attempts');
  });

  await check('expired lease after worker.max_attempts -> failed, not re-claimed', async () => {
    await sql('UPDATE transcriptions SET locked_until = ?, attempts = 3 WHERE id = ?', [nowSec() - 5, S.w3]);
    eq((await claim('worker-c')).status, 204, 'claim');
    const t = await getTr(S.w3);
    eq(t.status, 'failed', 'status');
    assert(/3 attempts/.test(t.error ?? ''), `error: ${t.error}`);
  });

  await check('fail retry:true at max attempts -> failed', async () => {
    const id = await uploadWorkerJob();
    eq(expectStatus(await claim(), 200).data.job.id, id, 'claim');
    await sql('UPDATE transcriptions SET attempts = 3 WHERE id = ?', [id]);
    expectStatus(await job(id, 'fail', { error: 'still broken', retry: true }), 200);
    eq((await getTr(id)).status, 'failed', 'status');
  });

  await check('complete validates and normalises the worker result', async () => {
    const id = await uploadWorkerJob();
    eq(expectStatus(await claim(), 200).data.job.id, id, 'claim');
    expectField(expectStatus(await job(id, 'complete', { segments: 'nope' }), 422, 'validation_error'), 'segments');
    expectField(expectStatus(await job(id, 'complete', { duration: 'long' }), 422, 'validation_error'), 'duration');
    expectStatus(await job(id, 'complete', {
      text: '',
      segments: [{ start: 0, end: 1.234, text: ' Hello ' }, { start: 1.234, end: 0.5, text: 'world' }, { start: 2, end: 3, text: '   ' }],
      duration: 3.456,
      detected_language: 'English',
    }), 200);
    const t = await getTr(id);
    eq([t.status, t.text, t.duration, t.detected_language, t.progress], ['completed', 'Hello world', 3.46, 'en', 100], 'fields');
    eq(t.segments, [{ id: 0, start: 0, end: 1.23, text: 'Hello' }, { id: 1, start: 1.23, end: 1.23, text: 'world' }], 'segments');
    eq((await claim()).status, 204, 'queue empty afterwards');
  });
}

async function cloudEngine() {
  heading('Cloud engine + cron');
  const api = S.api;
  const getTr = async (id) => expectStatus(await api.get(`/api/v1/transcriptions/${id}`), 200).data;
  const upload = (fields) => api.post('/api/v1/transcriptions', { form: uploadForm({ engine: 'cloud', ...fields }) });

  await check('wait=true -> 200 completed via the mock (language, prompt sent)', async () => {
    await cloudMock.reset();
    const r = expectStatus(await upload({ language: 'en', prompt: 'Maria, invoice, order number', wait: 'true' }), 200);
    const t = r.data;
    eq([t.status, t.engine, t.language, t.detected_language, t.duration, t.error], ['completed', 'cloud', 'en', 'en', 40, null], 'fields');
    assertSegments(t.segments);
    eq(t.segments.length, 7, 'segment count');
    assert(t.text.startsWith('Thank you for calling customer support'), `text: ${t.text.slice(0, 60)}`);
    S.cloudTr = t.id;
  });

  await check('mock received model, file, response_format=verbose_json, language, prompt', async () => {
    const reqs = await cloudMock.requests();
    eq(reqs.length, 1, 'request count');
    const q = reqs[0];
    eq(q.problems, [], 'mock assertions');
    eq([q.path, q.authorization_ok, q.user_agent], ['/v1/audio/transcriptions', true, 'TranscribeAPI/1.0.0'], 'path/auth/user-agent');
    eq(q.fields, {
      model: 'whisper-large-v3-turbo',
      response_format: 'verbose_json',
      temperature: '0',
      'timestamp_granularities[]': 'segment',
      language: 'en',
      prompt: 'Maria, invoice, order number',
    }, 'fields');
    eq([q.file?.filename, q.file?.contentType, q.file?.size, q.file?.sha256], ['clip.mp3', 'audio/mpeg', CLIP_BYTES.length, sha256(CLIP_BYTES)], 'file');
  });

  await check('task=translate -> /audio/translations with translate_model, no language', async () => {
    await cloudMock.reset();
    const t = expectStatus(await upload({ task: 'translate', language: 'de', wait: '1' }), 200).data;
    eq([t.status, t.task, t.language, t.detected_language], ['completed', 'translate', 'de', 'en'], 'fields');
    const [q] = await cloudMock.requests();
    eq(q.problems, [], 'mock assertions');
    eq([q.path, q.fields.model, 'language' in q.fields, q.fields.response_format], ['/v1/audio/translations', 'whisper-large-v3', false, 'verbose_json'], 'request');
  });

  await check('async cloud job stays queued under php -S, then cron completes it', async () => {
    await cloudMock.reset();
    const queued = expectStatus(await upload({}), 202).data;
    eq([queued.status, queued.language], ['queued', 'en'], 'initial status/default language');
    await delay(500);
    eq((await getTr(queued.id)).status, 'queued', 'status before cron');
    const c = await cron();
    eq(c.summary.cloud_processed, 1, `cron summary (${oneLine(c.stdout)})`);
    const t = await getTr(queued.id);
    eq([t.status, t.segments?.length], ['completed', 7], 'after cron');
    eq(t.webhook_status, 'delivered', 'webhook_status (cron delivers immediately)');
    S.asyncTr = t.id;
    return oneLine(c.stdout);
  });

  await check('mock 500: wait=true re-queues (202), cron retries, then failed', async () => {
    await cloudMock.reset();
    await cloudMock.failNext(500);
    const first = expectStatus(await upload({ wait: 'true' }), 202).data;
    eq(first.status, 'queued', 'status after a transient error');
    await cron();
    const t = await getTr(first.id);
    eq(t.status, 'failed', 'status after cloud.max_attempts');
    assert(/HTTP 500/.test(t.error ?? ''), `error: ${t.error}`);
    eq((await cloudMock.requests()).length, 2, 'cloud requests (2 attempts)');
    await cloudMock.reset();
  });

  await check('mock 429 once: re-queued, cron succeeds on the retry', async () => {
    await cloudMock.reset();
    await cloudMock.failNext(429, 1);
    const first = expectStatus(await upload({ wait: 'true' }), 202).data;
    await cron();
    eq((await getTr(first.id)).status, 'completed', 'status');
    eq((await cloudMock.requests()).map((q) => q.status), [429, 200], 'mock statuses');
  });

  await check('mock 400 (permanent): wait=true -> 200 failed immediately', async () => {
    await cloudMock.reset();
    const t = expectStatus(await upload({ wait: 'true', prompt: 'mock-fail:400' }), 200).data;
    eq(t.status, 'failed', 'status');
    assert(/HTTP 400/.test(t.error ?? ''), `error: ${t.error}`);
    eq((await cloudMock.requests()).length, 1, 'cloud requests');
  });

  await check('failed webhook delivery is retried by cron with backoff', async () => {
    const hookPath = '/flaky/1/retry';
    const t = expectStatus(await upload({ wait: 'true', webhook_url: `${HOOKS}${hookPath}` }), 200).data;
    await waitFor('the first (failing) delivery', async () => (await hooks.deliveries(hookPath)).length === 1);
    const failed = await waitFor('webhook_status=failed:500', async () => {
      const x = await getTr(t.id);
      return x.webhook_status === 'failed:500' ? x : null;
    }, { timeoutMs: 5000 });
    eq(failed.webhook_status, 'failed:500', 'webhook_status');
    const early = await cron();
    eq(early.summary.webhooks_sent, 0, 'retry before the backoff elapsed');
    await sql('UPDATE transcriptions SET completed_at = completed_at - 300 WHERE id = ?', [t.id]);
    await cron();
    eq((await getTr(t.id)).webhook_status, 'delivered', 'webhook_status after retry');
    const deliveries = await hooks.deliveries(hookPath);
    eq(deliveries.map((d) => [d.status, d.signature_valid]), [[500, true], [204, true]], 'deliveries');
  });
}

async function audioAndDelete() {
  heading('Audio streaming and deletes');
  const admin = S.admin;
  const api = S.api;

  await check('dashboard upload (multipart + CSRF, wait=true) -> 200 completed', async () => {
    const r = expectStatus(await admin.post(`/api/dash/projects/${S.p1}/transcriptions`, { form: uploadForm({ engine: 'cloud', wait: 'true', language: 'auto' }) }), 200);
    eq([r.data.status, r.data.language], ['completed', null], 'status/language (auto)');
    S.dashTr = r.data.id;
    expectStatus(await admin.post(`/api/dash/projects/${S.p1}/transcriptions`, { form: uploadForm({ engine: 'cloud' }), csrf: false }), 403, 'csrf_failed');
  });

  await check('audio endpoint: full file, Range 206, suffix range, 416', async () => {
    const route = `/api/dash/transcriptions/${S.dashTr}/audio`;
    const size = CLIP_BYTES.length;
    const full = expectStatus(await admin.get(route), 200);
    eq([full.headers.get('content-type'), full.headers.get('accept-ranges'), Number(full.headers.get('content-length'))], ['audio/mpeg', 'bytes', size], 'full headers');
    assert(full.body.equals(CLIP_BYTES), 'full body differs');
    const part = expectStatus(await admin.get(route, { headers: { Range: 'bytes=100-199' } }), 206);
    eq([part.headers.get('content-range'), Number(part.headers.get('content-length'))], [`bytes 100-199/${size}`, 100], 'range headers');
    assert(part.body.equals(CLIP_BYTES.subarray(100, 200)), 'range body differs');
    const open = expectStatus(await admin.get(route, { headers: { Range: `bytes=${size - 10}-` } }), 206);
    eq(open.headers.get('content-range'), `bytes ${size - 10}-${size - 1}/${size}`, 'open range');
    const suffix = expectStatus(await admin.get(route, { headers: { Range: 'bytes=-500' } }), 206);
    assert(suffix.body.equals(CLIP_BYTES.subarray(size - 500)), 'suffix body differs');
    const bad = await admin.get(route, { headers: { Range: `bytes=${size + 10}-` } });
    eq([bad.status, bad.headers.get('content-range')], [416, `bytes */${size}`], 'unsatisfiable range');
    expectStatus(await new Client().get(route), 401, 'unauthorized');
  });

  await check('audio deleted by retention -> audio 404, transcript still readable', async () => {
    await sql('UPDATE transcriptions SET completed_at = completed_at - 8 * 86400 WHERE id = ?', [S.cloudTr]);
    const c = await cron();
    assert(c.summary.audio_deleted >= 1, `cron audio_deleted=${c.summary.audio_deleted}`);
    assert(!fs.existsSync(uploadPath(S.cloudTr)), 'file still on disk');
    expectStatus(await admin.get(`/api/dash/transcriptions/${S.cloudTr}/audio`), 404, 'not_found');
    eq(expectStatus(await api.get(`/api/v1/transcriptions/${S.cloudTr}`), 200).data.status, 'completed', 'transcript');
  });

  await check('DELETE /api/v1/transcriptions/{id} removes the row and the audio file', async () => {
    assert(fs.existsSync(uploadPath(S.asyncTr)), 'file missing before delete');
    eq(expectStatus(await api.delete(`/api/v1/transcriptions/${S.asyncTr}`), 200).data, { id: S.asyncTr, deleted: true }, 'body');
    assert(!fs.existsSync(uploadPath(S.asyncTr)), 'file still on disk');
    expectStatus(await api.get(`/api/v1/transcriptions/${S.asyncTr}`), 404, 'not_found');
    expectStatus(await api.delete(`/api/v1/transcriptions/${S.asyncTr}`), 404, 'not_found');
  });

  await check('DELETE /api/dash/transcriptions/{id} removes the row and the audio file', async () => {
    assert(fs.existsSync(uploadPath(S.dashTr)), 'file missing before delete');
    eq(expectStatus(await admin.delete(`/api/dash/transcriptions/${S.dashTr}`), 200).data, { id: S.dashTr, deleted: true }, 'body');
    assert(!fs.existsSync(uploadPath(S.dashTr)), 'file still on disk');
    expectStatus(await admin.get(`/api/dash/transcriptions/${S.dashTr}/audio`), 404, 'not_found');
  });
}

async function n8nNode() {
  heading('n8n node (tests/n8n-harness.cjs)');

  await check('package + examples validate', async () => {
    const r = await run(process.execPath, ['tests/n8n-harness.cjs', '--validate'], { name: 'n8n-validate' });
    eq(r.code, 0, `exit code (${oneLine(r.stdout + r.stderr)})`);
    return oneLine(r.stdout);
  });

  await check('Transcribe (cloud, wait for completion) -> completed item', async () => {
    const r = await n8n(['--op', 'transcribe', '--file', 'tests/fixtures/clip.mp3', '--engine', 'cloud', '--language', 'en', '--metadata', '{"source":"n8n"}']);
    eq(r.code, 0, `exit code (${oneLine(r.stderr)})`);
    const [item] = r.items;
    eq([item.json.status, item.json.engine, item.json.metadata], ['completed', 'cloud', { source: 'n8n' }], 'item');
    assertSegments(item.json.segments);
    S.n8nTr = item.json.id;
  });

  await check('Transcribe (worker, no wait) -> queued item', async () => {
    const r = await n8n(['--op', 'transcribe', '--file', 'tests/fixtures/clip.mp3', '--engine', 'worker', '--no-wait']);
    eq(r.code, 0, `exit code (${oneLine(r.stderr)})`);
    eq([r.items[0].json.status, r.items[0].json.engine], ['queued', 'worker'], 'item');
    expectStatus(await S.api.delete(`/api/v1/transcriptions/${r.items[0].json.id}`), 200);
  });

  await check('Get (format srt) -> subtitle content', async () => {
    const r = await n8n(['--op', 'get', '--id', S.n8nTr, '--format', 'srt']);
    eq(r.code, 0, `exit code (${oneLine(r.stderr)})`);
    const srt = expectStatus(await S.api.get(`/api/v1/transcriptions/${S.n8nTr}?format=srt`), 200).text;
    eq([r.items[0].json.id, r.items[0].json.format, r.items[0].json.content], [S.n8nTr, 'srt', srt], 'item');
  });

  await check('List (return all) includes the transcription', async () => {
    const r = await n8n(['--op', 'list', '--all']);
    eq(r.code, 0, `exit code (${oneLine(r.stderr)})`);
    const total = expectStatus(await S.api.get('/api/v1/transcriptions'), 200).data.total;
    eq(r.items.length, total, 'item count = total');
    assert(r.items.some((i) => i.json.id === S.n8nTr), 'transcription missing from the list');
  });

  await check('Delete -> {id, deleted:true}; Get afterwards fails with 404', async () => {
    const r = await n8n(['--op', 'delete', '--id', S.n8nTr]);
    eq(r.code, 0, `exit code (${oneLine(r.stderr)})`);
    eq(r.items[0].json, { id: S.n8nTr, deleted: true }, 'item');
    const again = await n8n(['--op', 'get', '--id', S.n8nTr]);
    eq(again.code, 1, 'exit code of Get after delete');
    assert(/404/.test(again.stderr), `error: ${oneLine(again.stderr)}`);
  });

  await check('wrong API key -> node error 401', async () => {
    const r = await n8n(['--op', 'list'], `tk_${'1'.repeat(40)}`);
    eq(r.code, 1, 'exit code');
    assert(/401/.test(r.stderr), `error: ${oneLine(r.stderr)}`);
  });
}

async function projectDelete() {
  heading('Project delete cascade');
  const admin = S.admin;

  await check('DELETE project removes transcriptions, files, keys and members', async () => {
    const p3 = expectStatus(await admin.post('/api/dash/projects', { json: { name: 'Doomed project' } }), 201).data.id;
    const key = expectStatus(await admin.post(`/api/dash/projects/${p3}/keys`, { json: { name: 'doomed' } }), 201).data.key;
    expectStatus(await admin.post(`/api/dash/projects/${p3}/members`, { json: { email: MEMBER.email } }), 201);
    const api = new Client({ Authorization: `Bearer ${key}` });
    const done = expectStatus(await api.post('/api/v1/transcriptions', { form: uploadForm({ engine: 'cloud', wait: 'true' }) }), 200).data.id;
    const queued = expectStatus(await api.post('/api/v1/transcriptions', { form: uploadForm({ engine: 'worker' }) }), 202).data.id;
    assert(fs.existsSync(uploadPath(done)) && fs.existsSync(uploadPath(queued)), 'uploads missing before delete');

    expectStatus(await S.member.delete(`/api/dash/projects/${p3}`), 403, 'forbidden');
    eq(expectStatus(await admin.delete(`/api/dash/projects/${p3}`), 200).data, { id: p3, deleted: true }, 'body');
    for (const table of ['transcriptions', 'api_keys', 'project_members']) {
      const n = Number((await sql(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, [p3])).rows[0].n);
      eq(n, 0, `${table} rows left`);
    }
    eq(Number((await sql('SELECT COUNT(*) AS n FROM projects WHERE id = ?', [p3])).rows[0].n), 0, 'project row left');
    assert(!fs.existsSync(uploadPath(done)) && !fs.existsSync(uploadPath(queued)), 'audio files left on disk');
    expectStatus(await api.get('/api/v1/transcriptions'), 401, 'invalid_api_key');
    expectStatus(await admin.get(`/api/dash/projects/${p3}`), 404, 'not_found');
    eq(expectStatus(await S.member.get('/api/dash/projects'), 200).data.data, [], 'member project list');
  });
}

async function sessionEnd() {
  heading('Account + session');
  const admin = S.admin;

  await check('change password: wrong current -> 422; success keeps this session', async () => {
    expectField(expectStatus(await admin.post('/api/dash/password', { json: { current_password: 'nope-nope', new_password: 'whatever-123' } }), 422, 'validation_error'), 'current_password');
    expectField(expectStatus(await admin.post('/api/dash/password', { json: { current_password: ADMIN.password, new_password: 'short' } }), 422, 'validation_error'), 'new_password');
    const other = new Client();
    other.csrf = expectStatus(await other.post('/api/dash/login', { json: ADMIN }), 200).data.csrf_token;
    eq(expectStatus(await admin.post('/api/dash/password', { json: { current_password: ADMIN.password, new_password: `${ADMIN.password}-new` } }), 200).data, { ok: true }, 'body');
    expectStatus(await admin.get('/api/dash/me'), 200);
    expectStatus(await other.get('/api/dash/me'), 401, 'unauthorized');
    expectStatus(await admin.post('/api/dash/password', { json: { current_password: `${ADMIN.password}-new`, new_password: ADMIN.password } }), 200);
  });

  await check('logout -> session ends', async () => {
    eq(expectStatus(await admin.post('/api/dash/logout'), 200).data, { ok: true }, 'body');
    expectStatus(await admin.get('/api/dash/me'), 401, 'unauthorized');
    expectStatus(await admin.get('/api/dash/projects'), 401, 'unauthorized');
  });

  await check('cron run exits 0 and leaves nothing stale', async () => {
    const c = await cron();
    eq([c.summary.requeued, c.summary.failed_stale, c.summary.cloud_processed], [0, 0, 0], 'summary');
    return oneLine(c.stdout);
  });

  await check('no ERROR entries in storage/logs/app.log', async () => {
    const file = path.join(STORAGE, 'logs', 'app.log');
    const errors = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => / ERROR /.test(l)) : [];
    assert(errors.length === 0, errors.slice(0, 3).join(' | '));
  });
}

// ---------------------------------------------------------------------------------------------

function printSummary(startedAt) {
  const failed = results.filter((r) => !r.ok);
  const width = Math.max(...results.map((r) => r.section.length), 7);
  console.log(`\n${'='.repeat(110)}`);
  console.log(`RESULT  ${'SECTION'.padEnd(width)}  CHECK`);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}    ${r.section.padEnd(width)}  ${r.name}`);
    if (!r.ok) console.log(`        ${' '.repeat(width)}  -> ${oneLine(r.detail, 400)}`);
  }
  console.log('='.repeat(110));
  console.log(`${results.length - failed.length}/${results.length} checks passed (db: ${opts.db}) in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
  if (failed.length) {
    for (const proc of [S.server, S.workerProc].filter(Boolean)) {
      console.log(`\n--- last output of ${proc.name} ---\n${tail(proc.stderr + proc.stdout, 30)}`);
    }
    const log = path.join(STORAGE, 'logs', 'app.log');
    if (fs.existsSync(log)) console.log(`\n--- storage/logs/app.log (tail) ---\n${tail(fs.readFileSync(log, 'utf8'), 15)}`);
  }
}

async function cleanup() {
  stopAll();
  await Promise.all([...children].map((proc) => proc.done));
  if (opts.db === 'mysql') {
    await mysqlServer(`DROP DATABASE IF EXISTS \`${MYSQL.name}\``).catch((err) => console.error(`Could not drop ${MYSQL.name}: ${err.message}`));
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

async function main() {
  if (opts.help) {
    console.log('Usage: node tests/e2e.mjs [--db sqlite|mysql] [--keep] [--skip-worker]');
    return 0;
  }
  if (!['sqlite', 'mysql'].includes(opts.db)) {
    console.error('--db must be sqlite or mysql');
    return 2;
  }
  const startedAt = Date.now();
  process.on('exit', stopAll);
  process.on('SIGINT', () => {
    console.log('\nInterrupted: stopping child processes.');
    stopAll();
    process.exit(130);
  });

  console.log(`Transcribe API e2e (db: ${opts.db}, php: ${PHP}, server: ${BASE})`);
  try {
    if (await setup()) {
      await serverBasics();
      await dashboardApi();
      await publicApiAuth();
      await workerEngine();
      await workerApi();
      await cloudEngine();
      await audioAndDelete();
      await n8nNode();
      await projectDelete();
      await sessionEnd();
    }
  } catch (err) {
    results.push({ section, name: 'unexpected error', ok: false, detail: err?.stack ?? String(err) });
  }
  printSummary(startedAt);
  const failed = results.some((r) => !r.ok);

  if (opts.keep && S.server && !S.server.exited) {
    console.log(`\n--keep: dashboard ${BASE}/ (sign in with the ADMIN account defined in tests/e2e.mjs);`
      + ` mock cloud ${CLOUD}/v1, webhook receiver ${HOOKS}. Data: ${path.relative(ROOT, TMP)}. Press Ctrl+C to stop.`);
    await new Promise(() => {}); // until Ctrl+C (the SIGINT handler stops the children)
  }
  await cleanup();
  return failed ? 1 : 0;
}

main().then((code) => { process.exitCode = code; });
