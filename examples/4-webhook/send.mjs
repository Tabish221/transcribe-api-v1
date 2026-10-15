/**
 * Uploads a file and tells the API where to send the result (webhook_url). Then it exits.
 * No polling: the receiver (receiver.mjs) gets the result when the job is done.
 *
 *   node send.mjs [file.mp3] [--engine worker|cloud] [--language en|auto] [--webhook-url URL]
 */
import { existsSync, openAsBlob } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { requireSetting, setting } from './env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_URL = requireSetting('TRANSCRIBE_API_URL').replace(/\/+$/, '');
const API_KEY = requireSetting('TRANSCRIBE_API_KEY');

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    engine: { type: 'string', default: setting('TRANSCRIBE_ENGINE', 'worker') },
    language: { type: 'string', default: setting('TRANSCRIBE_LANGUAGE', '') },
    'webhook-url': { type: 'string', default: setting('WEBHOOK_URL', 'http://127.0.0.1:4000/webhook') },
  },
});
const file = resolve(positionals[0] ?? join(HERE, '..', 'sample', 'clip.mp3'));
// "auto" = Whisper detects the language. Empty = not sent = the project default language.
const language = opts.language;
const webhookUrl = opts['webhook-url'];

if (!existsSync(file)) {
  console.error(`ERROR: file not found: ${file}`);
  process.exit(1);
}
if (!URL.canParse(webhookUrl)) {
  console.error(`ERROR: --webhook-url is not a valid URL: ${webhookUrl}`);
  process.exit(1);
}

// Friendly check: is the receiver running? (Only a warning - the server retries failed deliveries.)
const receiverHome = new URL('/', webhookUrl);
try {
  await fetch(receiverHome, { signal: AbortSignal.timeout(2000) });
} catch {
  console.log(`Warning: nothing answers at ${receiverHome}. Start the receiver first (start-receiver.bat).\n`);
}

const form = new FormData();
form.append('file', await openAsBlob(file, { type: 'audio/mpeg' }), basename(file));
form.append('engine', opts.engine);
if (language) form.append('language', language);
form.append('webhook_url', webhookUrl);
// metadata comes back unchanged in the webhook. Use it to find your own record (order id, user id, ...).
form.append('metadata', JSON.stringify({ demo: '4-webhook', file: basename(file) }));

console.log('Transcribe API - send with webhook');
console.log(`  Server:   ${API_URL}   Key: ${API_KEY.slice(0, 7)}...`);
console.log(`  File:     ${file}`);
console.log(`  Engine:   ${opts.engine}    Language: ${language || '(project default)'}`);
console.log(`  Webhook:  ${webhookUrl}\n`);

const res = await fetch(`${API_URL}/api/v1/transcriptions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}` },
  body: form,
}).catch((err) => {
  console.error(`ERROR: cannot reach ${API_URL} (${err.cause?.code ?? err.message})`);
  process.exit(1);
});
const body = await res.json().catch(() => ({}));

if (!res.ok) {
  console.error(`ERROR: upload failed: ${body.error?.message ?? `HTTP ${res.status}`} (${body.error?.code ?? res.status})`);
  process.exit(1);
}

console.log(`Uploaded. Job ${body.id} is ${body.status}.`);
console.log('This script stops now. Watch the receiver window: the result arrives there when the job is done.');
