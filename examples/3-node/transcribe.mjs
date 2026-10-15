#!/usr/bin/env node
/**
 * Transcribe one audio file with the Transcribe API.
 * Node.js 20+ only: fetch, FormData and Blob are built in. No npm install.
 *
 *   node transcribe.mjs [file.mp3] [--engine worker|cloud] [--language en|auto] [--wait] [--out folder]
 *
 * Flow: upload (POST multipart) -> poll GET /api/v1/transcriptions/{id} -> print -> save .json + .srt
 * --wait works only with --engine cloud: the server transcribes inside the upload request
 * and answers with the finished result, so no polling is needed.
 */
import { existsSync, mkdirSync, openAsBlob, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLL_SECONDS = 5;
const TIMEOUT_MINUTES = 60;

// --- Settings: ../.env (KEY=VALUE, # comments). Real environment variables win. ----------------
function loadEnv(file) {
  const values = {};
  if (existsSync(file)) {
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const eq = line.indexOf('=');
      values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return (name, fallback = '') => process.env[name] || values[name] || fallback;
}

const setting = loadEnv(join(HERE, '..', '.env'));
const API_URL = setting('TRANSCRIBE_API_URL').replace(/\/+$/, '');
const API_KEY = setting('TRANSCRIBE_API_KEY');

// --- Command line -----------------------------------------------------------------------------
const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    engine: { type: 'string', default: setting('TRANSCRIBE_ENGINE', 'worker') },
    language: { type: 'string', default: setting('TRANSCRIBE_LANGUAGE', '') },
    wait: { type: 'boolean', default: false },
    out: { type: 'string', default: join(HERE, 'output') },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (opts.help) {
  console.log('Usage: node transcribe.mjs [file.mp3] [--engine worker|cloud] [--language en|auto] [--wait] [--out folder]');
  process.exit(0);
}
const file = resolve(positionals[0] ?? join(HERE, '..', 'sample', 'clip.mp3'));
// "auto" = Whisper detects the language. Empty = not sent = the project default language.
const language = opts.language;
const wait = opts.wait && opts.engine === 'cloud'; // wait=true is a cloud-only feature

if (!API_URL || !API_KEY) fail('TRANSCRIBE_API_URL and TRANSCRIBE_API_KEY must be set in ../.env');
if (!existsSync(file)) fail(`File not found: ${file}`);

// --- Small API helper -------------------------------------------------------------------------
/** Calls the API. Returns parsed JSON (or text with asText). Throws a readable Error for HTTP errors. */
async function api(method, path, { body, asText = false } = {}) {
  let res;
  try {
    res = await fetch(API_URL + path, {
      method,
      body,
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
    });
  } catch (err) {
    throw new Error(`Cannot reach ${API_URL} (${err.cause?.code ?? err.message})`);
  }
  const text = await res.text();
  if (!res.ok) {
    // Errors look like {"error":{"code":"file_too_large","message":"..."}}
    let message = `HTTP ${res.status}`;
    try {
      const { error } = JSON.parse(text);
      message = `${error.message} (${error.code}, HTTP ${res.status})`;
    } catch {}
    const e = new Error(message);
    e.status = res.status;
    throw e;
  }
  if (asText) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The API did not answer with JSON (HTTP ${res.status}). Is TRANSCRIBE_API_URL right?`);
  }
}

// --- Main -------------------------------------------------------------------------------------
console.log('Transcribe API - Node.js demo');
console.log(`  Server:   ${API_URL}`);
console.log(`  Key:      ${API_KEY.slice(0, 7)}...`); // never print the full key
console.log(`  File:     ${file}`);
console.log(`  Engine:   ${opts.engine}    Language: ${language || '(project default)'}${wait ? '    wait: yes' : ''}\n`);

if (opts.wait && !wait) {
  console.log('Note: --wait only works with --engine cloud. Polling instead.\n');
}

// 1. Upload. openAsBlob streams the file from disk; the third argument is the file name the API sees.
const form = new FormData();
form.append('file', await openAsBlob(file, { type: 'audio/mpeg' }), basename(file));
form.append('engine', opts.engine);
if (language) form.append('language', language);
if (wait) form.append('wait', 'true');

console.log(wait ?'Uploading and transcribing (cloud, wait=true)...' : 'Uploading...');
let job;
try {
  job = await api('POST', '/api/v1/transcriptions', { body: form });
} catch (err) {
  fail(`Upload failed: ${err.message}`);
}
console.log(`  Created ${job.id} (status: ${job.status})\n`);

// If you press Ctrl+C, only this script stops. The job keeps running on the server.
process.on('SIGINT', () => {
  console.log(`\nStopped waiting. The job keeps running on the server: ${job.id}`);
  process.exit(130);
});

// 2. Poll until the job is completed or failed (not needed when wait=true already finished it).
job = await waitForResult(job);
if (job.status === 'failed') fail(`Transcription failed: ${job.error ?? 'unknown error'}`);

// 3. Print and save.
console.log(`\nDone. Audio length: ${job.duration} s, language: ${job.detected_language}\n`);
console.log('--- Transcript ---');
console.log(job.text);
console.log('------------------\n');

mkdirSync(opts.out, { recursive: true });
const name = basename(file, extname(file));
const jsonFile = join(opts.out, `${name}.json`);
const srtFile = join(opts.out, `${name}.srt`);
writeFileSync(jsonFile, JSON.stringify(job, null, 2) + '\n'); // the full object: text, segments, timings
writeFileSync(srtFile, await api('GET', `/api/v1/transcriptions/${job.id}?format=srt`, { asText: true }));
console.log(`Saved ${jsonFile}`);
console.log(`Saved ${srtFile}`);
console.log(`\nTranscription id: ${job.id} (also visible in the dashboard)`);

// --- Helpers ----------------------------------------------------------------------------------

async function waitForResult(job) {
  if (job.status === 'completed' || job.status === 'failed') return job;
  console.log(`Waiting for the result (checking every ${POLL_SECONDS} s, Ctrl+C to stop)...`);
  const started = Date.now();
  const live = process.stdout.isTTY; // in a terminal: redraw one line; in a log: print changes only
  let lastLine = '';
  let lastPrint = 0;
  let errorsInRow = 0;

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (elapsed > TIMEOUT_MINUTES * 60) fail(`Still not done after ${TIMEOUT_MINUTES} minutes. Job id: ${job.id}`);

    try {
      job = await api('GET', `/api/v1/transcriptions/${job.id}`);
      errorsInRow = 0;
    } catch (err) {
      // One network problem is not a reason to stop. 401/404 are.
      if (++errorsInRow >= 5 || err.status === 401 || err.status === 404) fail(`Status check failed: ${err.message}`);
      console.log(`\n  (status check failed, trying again: ${err.message})`);
      continue;
    }

    const line = `${progressBar(job)} ${job.status.padEnd(10)} ${String(elapsed).padStart(4)} s`;
    if (live) {
      process.stdout.write(`\r  ${line}`);
    } else if (line.slice(0, -7) !== lastLine.slice(0, -7) || elapsed - lastPrint >= 30) {
      console.log(`  ${line}`);
      lastPrint = elapsed;
    }
    lastLine = line;
    if (job.status === 'completed' || job.status === 'failed') {
      if (live) process.stdout.write('\n');
      return job;
    }
  }
}

/** [##########----------]  50% */
function progressBar(job) {
  const pct = job.status === 'completed' ? 100 : Math.max(0, Math.min(100, job.progress ?? 0));
  const filled = Math.round(pct / 5);
  return `[${'#'.repeat(filled)}${'-'.repeat(20 - filled)}] ${String(pct).padStart(3)}%`;
}

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}
