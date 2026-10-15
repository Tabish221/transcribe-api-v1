/**
 * Webhook receiver for the Transcribe API. Node.js 20+, no npm packages.
 *
 *   node receiver.mjs        (or double-click start-receiver.bat)
 *
 * Listens on http://127.0.0.1:4000/webhook. For every POST it:
 *   1. checks X-Transcribe-Signature = "sha256=" + HMAC-SHA256(raw body, TRANSCRIBE_WEBHOOK_SECRET)
 *      -> wrong or missing signature: 401, nothing is saved
 *   2. transcription.completed -> saves results/<id>.json and prints the text
 *      transcription.failed    -> prints the error
 *   3. answers 200 quickly. Any 2xx means "delivered"; other answers make the server retry later.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireSetting, setting } from './env.mjs';

const HOST = '127.0.0.1';
const PORT = Number(setting('WEBHOOK_PORT', '4000'));
const SECRET = requireSetting('TRANSCRIBE_WEBHOOK_SECRET');
const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'results');
const MAX_BODY_BYTES = 20 * 1024 * 1024; // long recordings have many segments

/** True when the header matches the HMAC of the exact raw bytes we received. */
function isValidSignature(rawBody, header) {
  if (typeof header !== 'string') return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', SECRET).update(rawBody).digest('hex'));
  const received = Buffer.from(header.trim());
  // timingSafeEqual needs equal lengths; it does not leak how many characters matched.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** What to do with a verified event. Put your own logic here (database, e-mail, ...). */
function handleEvent(payload) {
  const job = payload.data ?? {};
  if (!/^tr_[a-f0-9]{24}$/.test(job.id ?? '')) throw new Error('payload has no valid transcription id');

  if (payload.event === 'transcription.completed') {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const file = join(RESULTS_DIR, `${job.id}.json`); // id is checked above, so this path is safe
    writeFileSync(file, JSON.stringify(job, null, 2) + '\n'); // same id again = same file (retries are safe)
    console.log(`\n[${time()}] transcription.completed  ${job.id}  (${job.filename}, ${job.duration} s, ${job.detected_language})`);
    if (job.metadata) console.log(`  metadata: ${JSON.stringify(job.metadata)}`);
    console.log(`  ${job.text}`);
    console.log(`  Saved ${file}`);
  } else if (payload.event === 'transcription.failed') {
    console.log(`\n[${time()}] transcription.failed  ${job.id}  (${job.filename}): ${job.error}`);
  } else {
    console.log(`\n[${time()}] ignored unknown event "${payload.event}"`);
  }
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function time() {
  return new Date().toLocaleTimeString();
}

const server = createServer((req, res) => {
  const path = new URL(req.url, `http://${HOST}`).pathname;
  if (req.method === 'GET' && path === '/') {
    return reply(res, 200, { ok: true, message: 'Webhook receiver is running. The API posts to /webhook.' });
  }
  if (path !== '/webhook') return reply(res, 404, { error: 'not_found' });
  if (req.method !== 'POST') return reply(res, 405, { error: 'method_not_allowed' });

  // Keep the RAW bytes: the signature is calculated over them, not over re-encoded JSON.
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  });

  req.on('end', () => {
    if (size > MAX_BODY_BYTES) return reply(res, 413, { error: 'too_large' });
    const rawBody = Buffer.concat(chunks);
    if (!isValidSignature(rawBody, req.headers['x-transcribe-signature'])) {
      console.log(`\n[${time()}] REJECTED request with a missing or wrong signature (401)`);
      return reply(res, 401, { error: 'invalid_signature' });
    }
    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return reply(res, 400, { error: 'invalid_json' });
    }
    try {
      handleEvent(payload);
    } catch (err) {
      console.error(`\n[${time()}] could not handle the event: ${err.message}`);
      return reply(res, 500, { error: 'handler_failed' }); // not 2xx -> the server retries later
    }
    reply(res, 200, { received: true });
  });
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `ERROR: port ${PORT} is already in use. Is the receiver already running?` : err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('Transcribe API - webhook receiver');
  console.log(`  Listening on http://${HOST}:${PORT}/webhook`);
  console.log(`  Secret:      ${SECRET.slice(0, 7)}... (from ../.env)`);
  console.log(`  Results go to ${RESULTS_DIR}`);
  console.log('  Now run send.bat (or: node send.mjs) in another window. Ctrl+C stops the receiver.');
});
