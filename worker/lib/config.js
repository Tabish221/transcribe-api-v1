// Settings: command-line flags > environment variables > .env file > defaults.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';

/** The worker/ folder. Relative paths in .env are resolved against it, not the current directory. */
export const WORKER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const DTYPES = ['auto', 'fp32', 'fp16', 'q8', 'int8', 'uint8', 'q4', 'q4f16', 'bnb4'];

export const USAGE = `Transcribe API worker

Server mode (default): poll the server for worker jobs and transcribe them.
  node worker.js [--once]

Local mode: transcribe one file and print/save the JSON result.
  node worker.js --file <audio> [--language en] [--task transcribe|translate] [--out result.json]

Options:
  --once              Process at most one job, then exit (server mode)
  --file <path>       Audio file to transcribe locally (anything ffmpeg can read)
  --language <code>   ISO-639-1 code such as en, ur, ar (default: auto-detect)
  --task <task>       transcribe (default) or translate (to English)
  --out <path>        Write the JSON result to this file instead of stdout
  --model <id>        Override MODEL     --device <cpu|dml|cuda>   Override DEVICE
  --dtype <dtype>     Override DTYPE     --env <path|none>          Settings file (default: worker/.env)
  --translate-model <id>  Override TRANSLATE_MODEL
  --verbose           Debug logging      --help                     Show this help

Settings (.env or environment): API_BASE, WORKER_TOKEN, WORKER_NAME, MODEL, DEVICE, DTYPE,
POLL_SECONDS, CACHE_DIR, plus optional TRANSLATE_MODEL, HEARTBEAT_SECONDS, TEMP_DIR, FFMPEG_PATH, LOG_LEVEL.`;

export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      once: { type: 'boolean', default: false },
      file: { type: 'string' },
      language: { type: 'string' },
      task: { type: 'string' },
      out: { type: 'string' },
      model: { type: 'string' },
      'translate-model': { type: 'string' },
      device: { type: 'string' },
      dtype: { type: 'string' },
      env: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  return values;
}

/**
 * Minimal .env parser: KEY=value lines, # comments (whole-line or after the value), optional quotes,
 * optional "export ". `KEY=   # note` is an empty value; `KEY="v" # note` is v; a "#" inside an unquoted
 * value (e.g. a token "ab#cd") is kept.
 */
export function parseEnvFile(text) {
  const vars = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const quoted = m[2].match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
    vars[m[1]] = quoted ? quoted[2] : m[2].replace(/(^|\s)#.*$/, '').trim();
  }
  return vars;
}

/** "q8" -> "q8"; "encoder_model=fp32,decoder_model_merged=q4" -> per-file object. */
export function parseDtype(value) {
  const check = (d) => {
    if (!DTYPES.includes(d)) throw new Error(`Unknown DTYPE "${d}" (use one of: ${DTYPES.join(', ')})`);
    return d;
  };
  if (!value.includes('=')) return check(value);
  const map = {};
  for (const part of value.split(',')) {
    const [file, d] = part.split('=').map((s) => s.trim());
    if (!file || !d) throw new Error(`Invalid DTYPE entry "${part}"`);
    map[file] = check(d);
  }
  return map;
}

function number(name, raw, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got "${raw}")`);
  return Math.min(max, Math.max(min, n));
}

export function loadConfig(args = {}) {
  // Read the .env file (unless --env none). Real environment variables win over it.
  let fileVars = {};
  let envFile = null;
  if (args.env !== 'none') {
    envFile = args.env ? path.resolve(args.env) : path.join(WORKER_DIR, '.env');
    if (fs.existsSync(envFile)) fileVars = parseEnvFile(fs.readFileSync(envFile, 'utf8'));
    else if (args.env) throw new Error(`Settings file not found: ${envFile}`);
    else envFile = null;
  }
  const get = (name, fallback = '') => {
    const v = process.env[name] ?? fileVars[name];
    return v === undefined || v.trim() === '' ? fallback : v.trim();
  };

  const device = (args.device ?? get('DEVICE', 'cpu')).toLowerCase();
  return {
    envFile,
    apiBase: get('API_BASE').replace(/\/+$/, ''),
    token: get('WORKER_TOKEN'),
    workerName: get('WORKER_NAME', os.hostname()).slice(0, 100),
    model: args.model ?? get('MODEL', 'onnx-community/whisper-large-v3-turbo'),
    // Used for task=translate when MODEL cannot translate (large-v3-turbo, *.en). Empty: such jobs fail clearly.
    translateModel: args['translate-model'] ?? get('TRANSLATE_MODEL', ''),
    device,
    dtype: parseDtype(args.dtype ?? get('DTYPE', 'q4')),
    pollSeconds: number('POLL_SECONDS', get('POLL_SECONDS', '10'), 1, 3600),
    heartbeatSeconds: number('HEARTBEAT_SECONDS', get('HEARTBEAT_SECONDS', '60'), 5, 60),
    cacheDir: path.resolve(WORKER_DIR, get('CACHE_DIR', './models')),
    tempDir: path.resolve(WORKER_DIR, get('TEMP_DIR', './tmp')),
    ffmpegPath: get('FFMPEG_PATH', ffmpegStatic ?? ''),
    logLevel: args.verbose ? 'debug' : get('LOG_LEVEL', 'info').toLowerCase(),
  };
}

/** Checks needed before talking to the server. Returns a list of problems (empty = OK). */
export function serverConfigProblems(cfg) {
  const problems = [];
  let url = null;
  try { url = new URL(cfg.apiBase); } catch { /* reported below */ }
  if (!url || !/^https?:$/.test(url.protocol)) problems.push('API_BASE must be an http(s) URL, e.g. https://example.com/transcribe');
  if (!cfg.token) problems.push('WORKER_TOKEN is empty (copy one of the tokens from server/config.php -> worker.tokens)');
  return problems;
}
