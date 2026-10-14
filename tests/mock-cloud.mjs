// Fake OpenAI-compatible speech-to-text API for the server's "cloud" engine (SPEC section 7).
//
//   node tests/mock-cloud.mjs [--port 8092] [--key <expected bearer key>] [--fail 500[:count]]
//
// Endpoints (base URL to put in config cloud.base_url: http://127.0.0.1:8092/v1):
//   POST /v1/audio/transcriptions   multipart: file, model, response_format=verbose_json, temperature,
//                                   timestamp_granularities[], language?, prompt?
//   POST /v1/audio/translations     multipart: file, model, response_format, temperature?, prompt?
// Both answer with a realistic verbose_json body (language "english", segments with Whisper fields).
// Requests that miss model/file or ask for another response_format get a 400 (the "assertion" failed),
// and the problem is recorded so the test can report it.
//
// Simulated failures (for retry tests):
//   - a prompt containing "mock-fail:<status>" (e.g. mock-fail:500) answers with that status every time;
//   - POST /_mock/fail {"status":429,"count":2} makes the next N requests fail;
//   - env MOCK_CLOUD_FAIL / --fail 500[:count] does the same at start-up (count omitted = forever).
//
// Control: GET /_mock/requests (recorded requests), POST /_mock/reset.

import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SEGMENTS = [
  [0.0, 4.2, ' Thank you for calling customer support, my name is Maria.'],
  [4.2, 8.96, ' How can I help you today?'],
  [8.96, 15.4, ' Hi Maria, I am calling about the invoice I received last week.'],
  [15.4, 22.08, ' It looks like I was charged twice for the same order.'],
  [22.08, 29.5, ' I am sorry to hear that. Can you give me the order number, please?'],
  [29.5, 36.12, ' Sure, it is four two seven nine one.'],
  [36.12, 40.0, ' Thank you, one moment while I check.'],
];

/** verbose_json as returned by Groq/OpenAI. */
function verboseJson(task, duration) {
  const scale = duration / 40;
  const segments = SEGMENTS.map(([start, end, text], id) => ({
    id,
    seek: 0,
    start: Math.round(start * scale * 100) / 100,
    end: Math.round(end * scale * 100) / 100,
    text,
    tokens: [50364, 400 + id, 50614],
    temperature: 0,
    avg_logprob: -0.21,
    compression_ratio: 1.38,
    no_speech_prob: 0.012,
  }));
  return {
    task,
    language: 'english',
    duration,
    text: segments.map((s) => s.text).join('').trim(),
    segments,
    x_groq: { id: `req_${crypto.randomBytes(8).toString('hex')}` },
  };
}

/** Minimal multipart/form-data parser: returns { fields: {name: value}, files: {name: {filename, contentType, size, sha256}} }. */
export function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new Error('missing multipart boundary');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const fields = {};
  const files = {};
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (body.slice(start, start + 2).toString() === '--') break; // closing boundary
    const headerEnd = body.indexOf('\r\n\r\n', start);
    const next = body.indexOf(boundary, headerEnd);
    if (headerEnd === -1 || next === -1) throw new Error('malformed multipart body');
    const headers = body.slice(start + 2, headerEnd).toString('utf8');
    const content = body.slice(headerEnd + 4, next - 2); // strip the CRLF before the boundary
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    if (name !== undefined) {
      if (filename !== undefined) {
        files[name] = {
          filename,
          contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1] ?? null,
          size: content.length,
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
        };
      } else {
        fields[name] = content.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, files };
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
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

function parseFail(spec) {
  if (!spec) return null;
  const [status, count] = String(spec).split(':');
  return { status: Number(status), remaining: count === undefined ? Infinity : Number(count) };
}

export function createMockCloud({ key = null, fail = null, duration = 40 } = {}) {
  const requests = [];
  let failNext = parseFail(fail);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://mock');
    if (req.method === 'GET' && url.pathname === '/_mock/requests') return send(res, 200, { requests });
    if (req.method === 'POST' && url.pathname === '/_mock/reset') {
      requests.length = 0;
      failNext = null;
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/_mock/fail') {
      const opts = JSON.parse((await readBody(req)).toString() || '{}');
      failNext = opts.status ? { status: Number(opts.status), remaining: opts.count ?? Infinity } : null;
      return send(res, 200, { ok: true });
    }

    const endpoint = { '/v1/audio/transcriptions': 'transcribe', '/v1/audio/translations': 'translate' }[url.pathname];
    if (req.method !== 'POST' || !endpoint) {
      return send(res, 404, { error: { message: `Unknown route ${req.method} ${url.pathname}`, type: 'invalid_request_error' } });
    }

    const raw = await readBody(req);
    const record = {
      at: new Date().toISOString(),
      path: url.pathname,
      task: endpoint,
      authorization_ok: key === null || req.headers.authorization === `Bearer ${key}`,
      user_agent: req.headers['user-agent'] ?? null,
      fields: {},
      file: null,
      problems: [],
      status: 200,
    };
    requests.push(record);
    try {
      const { fields, files } = parseMultipart(raw, req.headers['content-type']);
      record.fields = fields;
      record.file = files.file ?? null;
    } catch (err) {
      record.problems.push(`multipart: ${err.message}`);
    }

    // The assertions a real provider would enforce (plus the ones the server must always send).
    if (!record.authorization_ok) {
      record.status = 401;
      return send(res, 401, { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } });
    }
    if (!record.fields.model) record.problems.push('model is missing');
    if (!record.file || record.file.size === 0) record.problems.push('file is missing or empty');
    if (record.fields.response_format !== 'verbose_json') {
      record.problems.push(`response_format is ${JSON.stringify(record.fields.response_format)} (expected verbose_json)`);
    }
    if (endpoint === 'translate' && 'language' in record.fields) record.problems.push('translations do not take language');
    if (record.problems.length) {
      record.status = 400;
      return send(res, 400, { error: { message: `mock assertion failed: ${record.problems.join('; ')}`, type: 'invalid_request_error' } });
    }

    // Simulated failures.
    const forced = /mock-fail:(\d{3})/.exec(record.fields.prompt ?? '')?.[1];
    let failStatus = forced ? Number(forced) : null;
    if (!failStatus && failNext && failNext.remaining > 0) {
      failStatus = failNext.status;
      failNext.remaining -= 1;
    }
    if (failStatus) {
      record.status = failStatus;
      const type = failStatus === 429 ? 'rate_limit_exceeded' : failStatus >= 500 ? 'server_error' : 'invalid_request_error';
      return send(res, failStatus, { error: { message: `Simulated ${failStatus} from mock cloud`, type } });
    }

    return send(res, 200, verboseJson(endpoint, duration));
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { error: { message: `mock crashed: ${err.message}` } }));
  });
}

// CLI
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const port = Number(opt('port') ?? process.env.MOCK_CLOUD_PORT ?? 8092);
  const server = createMockCloud({
    key: opt('key') ?? process.env.MOCK_CLOUD_KEY ?? null,
    fail: opt('fail') ?? process.env.MOCK_CLOUD_FAIL ?? null,
  });
  server.on('error', (err) => {
    console.error(`mock-cloud: ${err.code === 'EADDRINUSE' ? `port ${port} is busy` : err.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => console.log(`mock-cloud listening on http://127.0.0.1:${port}/v1`));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}
