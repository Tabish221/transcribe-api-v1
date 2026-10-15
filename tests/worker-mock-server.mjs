// Fake worker API (SPEC section 8) and a protocol test for worker/worker.js.
//
//   node tests/worker-mock-server.mjs           run the scenarios below against `worker.js --once`
//   node tests/worker-mock-server.mjs --serve   only run the fake server with one queued job (Ctrl+C stops it)
//
// Listens on http://127.0.0.1:8096/transcribe (a sub-folder base path, like a cPanel install);
// set MOCK_PORT to use another port.
// Worker model: MODEL / DTYPE env vars, default onnx-community/whisper-tiny with fp32 (fast and accurate
// enough; tiny's q8 encoder is too inaccurate for the text checks).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKER = path.join(ROOT, 'worker', 'worker.js');
const CLIP = path.join(ROOT, 'tests', 'fixtures', 'clip.mp3');
const TEMP_DIR = path.join(ROOT, 'tests', '.worker-tmp');
const PORT = Number(process.env.MOCK_PORT) || 8096; // MOCK_PORT=8091..8099 if 8096 is busy
const BASE_PATH = '/transcribe';
const API_BASE = `http://127.0.0.1:${PORT}${BASE_PATH}`;
const TOKEN = 'mock-worker-token-0123456789abcdef'; // test-only value
const LEASE_SECONDS = 15;                          // -> worker heartbeats every 5 s
const MAX_ATTEMPTS = 3;

// ------------------------------------------------------------------------------------------------
// Fake server

class MockServer {
  jobs = new Map();
  calls = [];
  onHeartbeat = null;

  reset() {
    this.jobs.clear();
    this.calls = [];
    this.onHeartbeat = null;
  }

  addJob({ id, filename, bytes, language = null, task = 'transcribe', audioUrl, audioFailures = 0 }) {
    this.jobs.set(id, {
      id, filename, bytes, language, task, audioUrl, audioFailures,
      status: 'queued', attempts: 0, locked_until: null, progress: null, worker_name: null,
      created_at: Date.now() + this.jobs.size, result: null, error: null,
    });
  }

  listen() {
    this.http = http.createServer((req, res) => this.handle(req, res).catch((err) => {
      console.error('mock server error', err);
      send(res, 500, { error: { code: 'server_error', message: 'mock failure' } });
    }));
    return new Promise((resolve, reject) => {
      this.http.once('error', (err) => reject(err.code === 'EADDRINUSE' ? new Error(`Port ${PORT} is busy; set MOCK_PORT to a free port (8091-8099)`) : err));
      this.http.listen(PORT, '127.0.0.1', resolve);
    });
  }

  close() {
    return new Promise((resolve) => this.http.close(resolve));
  }

  async handle(req, res) {
    const url = new URL(req.url, API_BASE);
    const route = url.pathname.startsWith(BASE_PATH + '/') ? url.pathname.slice(BASE_PATH.length) : null;
    const body = req.method === 'POST' ? await readBody(req) : null;
    const call = { method: req.method, route: route ?? url.pathname, body, status: 0 };
    this.calls.push(call);
    const reply = (status, data, headers) => { call.status = status; send(res, status, data, headers); };
    const error = (status, code, message) => reply(status, { error: { code, message } });

    if (route === '/api/v1/health' && req.method === 'GET') {
      return reply(200, { ok: true, version: '1.0.0', engines: { cloud: false, worker: true } });
    }
    if (!route?.startsWith('/api/worker/')) return error(404, 'not_found', 'Unknown route');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return error(401, 'unauthorized', 'Invalid worker token');
    if (body === undefined) return error(422, 'validation_error', 'Body must be JSON');

    if (route === '/api/worker/claim') {
      if (req.method !== 'POST') return error(405, 'method_not_allowed', 'POST only');
      if (typeof body?.worker !== 'string' || !body.worker) return error(422, 'validation_error', 'worker is required');
      const job = this.claimable();
      if (!job) return reply(204, null);
      Object.assign(job, { status: 'processing', attempts: job.attempts + 1, worker_name: body.worker, locked_until: now() + LEASE_SECONDS });
      return reply(200, {
        job: {
          id: job.id, filename: job.filename, language: job.language, task: job.task, engine: 'worker',
          file_size: job.bytes.length, audio_url: job.audioUrl, lease_seconds: LEASE_SECONDS,
        },
      });
    }

    const m = route.match(/^\/api\/worker\/jobs\/([^/]+)\/(audio|heartbeat|complete|fail)$/);
    if (!m) return error(404, 'not_found', 'Unknown route');
    const [, id, action] = m;
    call.jobId = id;
    const job = this.jobs.get(id);
    if (!job || job.status !== 'processing') return error(404, 'not_found', 'Job is not being processed');
    if ((action === 'audio') !== (req.method === 'GET')) return error(405, 'method_not_allowed', 'Wrong method');

    if (action === 'audio') {
      if (job.audioFailures > 0) {
        job.audioFailures--;
        return error(503, 'server_error', 'Simulated temporary outage');
      }
      call.status = 200;
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': job.bytes.length });
      return res.end(job.bytes);
    }
    if (action === 'heartbeat') {
      const p = body?.progress;
      if (!Number.isInteger(p) || p < 0 || p > 100) return error(422, 'validation_error', 'progress must be 0-100');
      job.progress = p;
      job.locked_until = now() + LEASE_SECONDS;
      reply(200, { ok: true });
      return this.onHeartbeat?.(job);
    }
    if (action === 'complete') {
      const problem = validateResult(body);
      if (problem) return error(422, 'validation_error', problem);
      job.result = { ...body, segments: body.segments.map((s, i) => ({ id: i, ...s })) };
      Object.assign(job, { status: 'completed', progress: 100, locked_until: null });
      return reply(200, { ok: true });
    }
    // fail
    if (typeof body?.error !== 'string' || typeof body?.retry !== 'boolean') {
      return error(422, 'validation_error', 'error (string) and retry (boolean) are required');
    }
    job.error = body.error;
    if (body.retry && body.release === true) {
      // Hand-back (graceful stop): re-queued and the claim's attempt is returned, like the real server.
      job.status = 'queued';
      job.attempts = Math.max(0, job.attempts - 1);
    } else {
      job.status = body.retry && job.attempts < MAX_ATTEMPTS ? 'queued' : 'failed';
    }
    job.locked_until = null;
    return reply(200, { ok: true });
  }

  /** Oldest queued job, or a processing one whose lease expired (attempts permitting). */
  claimable() {
    const t = now();
    for (const job of this.jobs.values()) {
      if (job.status === 'processing' && job.locked_until < t && job.attempts >= MAX_ATTEMPTS) job.status = 'failed';
    }
    return [...this.jobs.values()]
      .filter((j) => j.status === 'queued' || (j.status === 'processing' && j.locked_until < t))
      .sort((a, b) => a.created_at - b.created_at)[0] ?? null;
  }
}

function validateResult(b) {
  if (typeof b?.text !== 'string') return 'text must be a string';
  if (!Array.isArray(b.segments)) return 'segments must be an array';
  for (const s of b.segments) {
    if (typeof s.start !== 'number' || typeof s.end !== 'number' || typeof s.text !== 'string') return 'segment needs start, end, text';
    if (s.start < 0 || s.end < s.start) return `bad segment times ${s.start}-${s.end}`;
  }
  if (typeof b.duration !== 'number' || b.duration <= 0) return 'duration must be a positive number';
  if (b.detected_language !== null && typeof b.detected_language !== 'string') return 'detected_language must be a string or null';
  return null;
}

const now = () => Math.floor(Date.now() / 1000);

function send(res, status, data, headers = {}) {
  if (status === 204) { res.writeHead(204, headers); return res.end(); }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return undefined; }
}

// ------------------------------------------------------------------------------------------------
// Test runner

function runWorker(args, env, { timeoutMs = 300000, onStart } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [WORKER, '--env', 'none', ...args], {
      env: {
        ...process.env,
        API_BASE, WORKER_TOKEN: TOKEN, WORKER_NAME: 'mock-test-pc', POLL_SECONDS: '1', TEMP_DIR,
        MODEL: process.env.MODEL || 'onnx-community/whisper-tiny',
        DTYPE: process.env.DTYPE || 'fp32',
        DEVICE: process.env.DEVICE || 'cpu',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let output = '';
    const collect = (chunk) => {
      output += chunk;
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) console.log(`    | ${line}`);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { output += '\n[test] timeout, killing worker'; child.kill(); }, timeoutMs);
    onStart?.(child);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output, ms: Date.now() - started });
    });
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
}

const routesOf = (server, jobId) => server.calls.filter((c) => !jobId || c.jobId === jobId || c.route.endsWith('/claim'))
  .map((c) => `${c.route.split('/').pop()}:${c.status}`);

function tempLeftovers() {
  return fs.existsSync(TEMP_DIR) ? fs.readdirSync(TEMP_DIR) : [];
}

async function scenarios(server) {
  const clip = fs.readFileSync(CLIP);

  console.log('\n[1] Happy path: auto language, one simulated 503 on the audio download, absolute audio_url');
  server.reset();
  server.addJob({ id: 'tr_mock_ok', filename: 'clip.mp3', bytes: clip, audioFailures: 1, audioUrl: `${API_BASE}/api/worker/jobs/tr_mock_ok/audio` });
  let run = await runWorker(['--once'], {});
  let job = server.jobs.get('tr_mock_ok');
  console.log(`  calls: ${routesOf(server).join(' -> ')}  (${(run.ms / 1000).toFixed(1)} s)`);
  check('worker exits with code 0', run.code === 0, `code ${run.code}`);
  check('claim -> audio 503 -> audio 200 sequence', /claim:200 -> audio:503 -> audio:200/.test(routesOf(server).join(' -> ')));
  const beats = server.calls.filter((c) => c.route.endsWith('/heartbeat'));
  check('at least one heartbeat with valid progress', beats.length > 0 && beats.every((c) => c.status === 200), `${beats.length} heartbeat(s): ${beats.map((c) => c.body.progress).join(',')}`);
  check('job completed', job.status === 'completed', job.status);
  const r = job.result ?? { segments: [], text: '' };
  check('detected_language is "en"', r.detected_language === 'en', r.detected_language);
  check('duration about 40 s', Math.abs(r.duration - 40) < 1.5, r.duration);
  const ordered = r.segments.every((s, i) => s.start <= s.end && s.end <= r.duration + 0.05 && (i === 0 || s.start >= r.segments[i - 1].start));
  check('segments ordered and inside the audio', r.segments.length >= 3 && ordered, `${r.segments.length} segments`);
  const words = ['hello', 'call', 'energy', 'speak', 'recorded', 'calling'].filter((w) => r.text.toLowerCase().includes(w));
  check('text is sensible English', words.length >= 3, `found: ${words.join(', ')}`);
  console.log(`  text: ${r.text.slice(0, 160)}...`);
  check('token never printed', !run.output.includes(TOKEN));
  check('temp files cleaned', tempLeftovers().length === 0, tempLeftovers().join(', '));

  console.log('\n[2] Corrupt audio -> permanent failure (retry:false), base-relative audio_url');
  server.reset();
  server.addJob({ id: 'tr_mock_bad', filename: 'broken.mp3', bytes: Buffer.from('this is not audio '.repeat(500)), audioUrl: 'api/worker/jobs/tr_mock_bad/audio' });
  run = await runWorker(['--once'], {});
  job = server.jobs.get('tr_mock_bad');
  const fail = server.calls.find((c) => c.route.endsWith('/fail'));
  console.log(`  calls: ${routesOf(server).join(' -> ')}  (${(run.ms / 1000).toFixed(1)} s)`);
  check('worker exits with code 1', run.code === 1, `code ${run.code}`);
  check('fail reported with retry:false', fail?.body?.retry === false, JSON.stringify(fail?.body));
  check('job marked failed', job.status === 'failed', job.status);
  check('temp files cleaned', tempLeftovers().length === 0, tempLeftovers().join(', '));

  console.log('\n[3] Graceful stop during transcription -> job handed back (retry + release), root-relative audio_url');
  server.reset();
  server.addJob({ id: 'tr_mock_stop', filename: 'clip.mp3', bytes: clip, language: 'en', audioUrl: `${BASE_PATH}/api/worker/jobs/tr_mock_stop/audio` });
  run = await runWorker([], {}, {
    onStart: (child) => {
      server.onHeartbeat = () => {
        server.onHeartbeat = null;
        console.log('  [test] first heartbeat received -> sending "shutdown" to the worker');
        child.send('shutdown');
      };
    },
  });
  job = server.jobs.get('tr_mock_stop');
  const stopFail = server.calls.find((c) => c.route.endsWith('/fail'));
  console.log(`  calls: ${routesOf(server).join(' -> ')}  (${(run.ms / 1000).toFixed(1)} s)`);
  check('worker exits cleanly (code 0)', run.code === 0, `code ${run.code}`);
  check('fail reported with retry:true and release:true', stopFail?.body?.retry === true && stopFail?.body?.release === true, JSON.stringify(stopFail?.body));
  check('job back in the queue, attempt given back', job.status === 'queued' && !job.result && job.attempts === 0, `${job.status}, attempts ${job.attempts}`);
  check('job handed back only once', server.calls.filter((c) => c.route.endsWith('/fail')).length === 1);
  check('temp files cleaned', tempLeftovers().length === 0, tempLeftovers().join(', '));

  console.log('\n[4] Wrong token -> clear error, exit code 1, job untouched');
  server.reset();
  server.addJob({ id: 'tr_mock_auth', filename: 'clip.mp3', bytes: clip, audioUrl: '' });
  const wrongToken = 'wrong-token-fedcba9876543210';
  run = await runWorker(['--once'], { WORKER_TOKEN: wrongToken });
  check('worker exits with code 1', run.code === 1, `code ${run.code}`);
  check('error mentions WORKER_TOKEN', /WORKER_TOKEN/.test(run.output));
  check('token never printed', !run.output.includes(wrongToken));
  check('job still queued', server.jobs.get('tr_mock_auth').status === 'queued');
}

async function main() {
  const server = new MockServer();
  await server.listen();
  console.log(`Mock worker API on ${API_BASE}`);

  if (process.argv.includes('--serve')) {
    server.addJob({ id: 'tr_mock_manual', filename: 'clip.mp3', bytes: fs.readFileSync(CLIP), audioUrl: `api/worker/jobs/tr_mock_manual/audio` });
    console.log(`One job queued. Run the worker with:\n  API_BASE=${API_BASE} WORKER_TOKEN=${TOKEN} node worker/worker.js --once`);
    process.on('SIGINT', () => server.close().then(() => process.exit(0)));
    return;
  }

  try {
    await scenarios(server);
  } finally {
    await server.close();
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
