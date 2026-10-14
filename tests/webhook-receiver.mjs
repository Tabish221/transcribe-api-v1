// Webhook receiver for tests: records every delivery and verifies X-Transcribe-Signature (SPEC section 7).
//
//   node tests/webhook-receiver.mjs [--port 8093] [--secret whsec_...]
//
// Any POST path is accepted and recorded. Response status:
//   /status/<code>...   always answers <code> (e.g. /status/500 to test failures)
//   /flaky/<n>...       answers 500 to the first n deliveries on that exact path, then 204 (retry tests)
//   anything else       204
// Control: GET /_hook/deliveries, POST /_hook/secret {"secret":"whsec_..."}, POST /_hook/reset.
// The secret can also come from WEBHOOK_SECRET. Without a secret, signature_valid is null.

import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** True when header == "sha256=" + hex HMAC-SHA256(rawBody, secret); constant-time compare. */
export function verifySignature(rawBody, header, secret) {
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const actual = Buffer.from(String(header ?? ''));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function send(res, status, data) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {});
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createWebhookReceiver({ secret = null } = {}) {
  const deliveries = [];
  const hitsByPath = new Map();

  async function handle(req, res) {
    const url = new URL(req.url, 'http://receiver');
    const raw = await readBody(req);
    if (req.method === 'GET' && url.pathname === '/_hook/deliveries') return send(res, 200, { deliveries });
    if (req.method === 'POST' && url.pathname === '/_hook/secret') {
      secret = JSON.parse(raw.toString() || '{}').secret ?? null;
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/_hook/reset') {
      deliveries.length = 0;
      hitsByPath.clear();
      return send(res, 200, { ok: true });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });

    const hits = (hitsByPath.get(url.pathname) ?? 0) + 1;
    hitsByPath.set(url.pathname, hits);
    let status = 204;
    const fixed = /^\/status\/(\d{3})/.exec(url.pathname);
    const flaky = /^\/flaky\/(\d+)/.exec(url.pathname);
    if (fixed) status = Number(fixed[1]);
    else if (flaky && hits <= Number(flaky[1])) status = 500;

    let json = null;
    try { json = JSON.parse(raw.toString('utf8')); } catch { /* recorded as null */ }
    deliveries.push({
      seq: deliveries.length + 1,
      at: new Date().toISOString(),
      path: url.pathname,
      status,
      headers: {
        'content-type': req.headers['content-type'] ?? null,
        'user-agent': req.headers['user-agent'] ?? null,
        'x-transcribe-event': req.headers['x-transcribe-event'] ?? null,
        'x-transcribe-delivery': req.headers['x-transcribe-delivery'] ?? null,
        'x-transcribe-signature': req.headers['x-transcribe-signature'] ?? null,
      },
      signature_valid: secret ? verifySignature(raw, req.headers['x-transcribe-signature'], secret) : null,
      json,
    });
    return send(res, status, status === 204 ? undefined : { received: true });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { error: err.message }));
  });
}

// CLI
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const port = Number(opt('port') ?? process.env.WEBHOOK_PORT ?? 8093);
  const server = createWebhookReceiver({ secret: opt('secret') ?? process.env.WEBHOOK_SECRET ?? null });
  server.on('error', (err) => {
    console.error(`webhook-receiver: ${err.code === 'EADDRINUSE' ? `port ${port} is busy` : err.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => console.log(`webhook-receiver listening on http://127.0.0.1:${port}`));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}
