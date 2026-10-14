// Transcribe API PC worker.
// Server mode: claims "worker" jobs from the server, transcribes them locally with Whisper and posts
// the result back (SPEC sections 8 and 11). Local mode (--file): runs the same pipeline on one file.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { USAGE, WORKER_DIR, parseCli, loadConfig, serverConfigProblems } from './lib/config.js';
import { configureLog, log, clock, elapsed, megabytes } from './lib/log.js';
import { SAMPLE_RATE, decodeAudio, normalize } from './lib/audio.js';
import { loadModel, transcribe } from './lib/whisper.js';
import { WorkerApi, sleep, describe } from './lib/api.js';
import { HttpError, JobLostError, PermanentError, StopError } from './lib/errors.js';

// ---------------------------------------------------------------------------------------------
// Shutdown: first Ctrl+C abandons the current job cleanly (reported with retry:true), a second
// one exits immediately. When idle we simply exit.

const stopper = new AbortController();
const state = { busy: false, tempFile: null, model: null };

/**
 * Release the model and let Node exit on its own. Calling process.exit() while ONNX Runtime still has
 * native callbacks pending aborts on Windows (libuv assertion, exit code 0xC0000409), so a hard exit is
 * only the fallback if something keeps the process alive.
 */
async function exit(code) {
  const model = state.model;
  state.model = null;
  if (model) await model.dispose().catch(() => {});
  process.exitCode = code;
  setTimeout(() => process.exit(code), 3000).unref();
}

function requestStop(reason) {
  if (stopper.signal.aborted) {
    log.warn('Forced exit.');
    process.exit(130);
  }
  stopper.abort(new StopError());
  if (state.busy) {
    log.warn(`${reason}: abandoning the current job after the current step (press Ctrl+C again to force quit)`);
  } else {
    log.info(`${reason}: stopping.`);
    exit(0); // idle or still loading the model: nothing to hand back
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(sig, () => requestStop(sig === 'SIGINT' ? 'Ctrl+C' : sig));
}
// Windows cannot deliver signals to child processes, so process managers send this IPC message instead.
process.on('message', (msg) => { if (msg === 'shutdown') requestStop('Shutdown requested'); });
process.channel?.unref();
// Last-resort cleanup, also on a forced exit.
process.on('exit', () => { if (state.tempFile) fs.rmSync(state.tempFile, { force: true }); });

// ---------------------------------------------------------------------------------------------

async function main() {
  let args;
  try {
    args = parseCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const cfg = loadConfig(args);
  configureLog({ level: cfg.logLevel, toStderr: Boolean(args.file) });
  return args.file ? runLocal(cfg, args) : runServer(cfg, args);
}

const dtypeLabel = (dtype) => (typeof dtype === 'string' ? dtype : JSON.stringify(dtype));

/** Load the model; if a GPU device (dml/cuda) does not work on this PC, fall back to the CPU. */
async function loadModelWithFallback(cfg) {
  log.info(`Loading ${cfg.model} (device ${cfg.device}, dtype ${dtypeLabel(cfg.dtype)}, cache ${cfg.cacheDir})`);
  try {
    state.model = await loadModel(cfg);
  } catch (err) {
    if (cfg.device === 'cpu') throw err;
    log.warn(`DEVICE=${cfg.device} failed (${err.message.split('\n')[0]}); falling back to cpu`);
    state.model = await loadModel({ ...cfg, device: 'cpu' });
  }
  return state.model;
}

/** Progress logger: at most one line every 10 s, plus the final 100 %. */
function progressLogger(prefix) {
  const t0 = Date.now();
  let last = 0;
  return (fraction, position, duration) => {
    const now = Date.now();
    if (fraction < 1 && now - last < 10000) return;
    last = now;
    const left = fraction > 0 && fraction < 1 ? `, about ${elapsed(((now - t0) / fraction) * (1 - fraction))} left` : '';
    log.info(`${prefix}${Math.round(fraction * 100)}% (${clock(position)} of ${clock(duration)})${left}`);
  };
}

const speed = (audioSeconds, ms) => `${(audioSeconds / Math.max(ms / 1000, 0.001)).toFixed(1)}x real time`;

// ---------------------------------------------------------------------------------------------
// Local mode: node worker.js --file call.mp3 [--language en] [--task transcribe] [--out result.json]

async function runLocal(cfg, args) {
  const file = path.resolve(args.file);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`File not found: ${file}`);
  const task = args.task ?? 'transcribe';
  if (!['transcribe', 'translate'].includes(task)) throw new Error('--task must be "transcribe" or "translate"');

  const asr = await loadModelWithFallback(cfg);
  state.busy = true; // from here on Ctrl+C cancels cleanly

  const t0 = Date.now();
  const audio = normalize(await decodeAudio(file, cfg.ffmpegPath, { signal: stopper.signal }));
  const seconds = audio.length / SAMPLE_RATE;
  log.info(`Decoded ${path.basename(file)}: ${clock(seconds)} of audio in ${elapsed(Date.now() - t0)}`);

  const t1 = Date.now();
  const result = await transcribe(asr, audio, {
    language: args.language,
    task,
    signal: stopper.signal,
    onProgress: progressLogger('Transcribing: '),
  });
  const ms = Date.now() - t1;
  log.info(`Done: ${result.segments.length} segments, language ${result.detected_language}, ` +
    `transcribed in ${elapsed(ms)} (${speed(result.duration, ms)})`);

  const json = JSON.stringify(result, null, 2) + '\n';
  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), json);
    log.info(`Saved ${path.resolve(args.out)}`);
  } else {
    process.stdout.write(json);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Server mode

async function runServer(cfg, { once }) {
  const problems = serverConfigProblems(cfg);
  if (problems.length) {
    problems.forEach((p) => log.error(p));
    log.error(`Fix ${cfg.envFile ?? path.join(WORKER_DIR, '.env')} (see .env.example) and start again.`);
    return 1;
  }
  const api = new WorkerApi(cfg, stopper.signal);
  log.info(`Worker "${cfg.workerName}" for ${cfg.apiBase} (token set, ${cfg.token.length} chars)`);
  if (api.base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(api.base.hostname)) {
    log.warn('API_BASE uses plain http: the worker token and audio travel unencrypted. Use https.');
  }
  prepareTempDir(cfg.tempDir);
  await checkServer(api);
  const asr = await loadModelWithFallback(cfg);

  let connected = false;
  let failures = 0;
  let idle = false;
  while (!stopper.signal.aborted) {
    let job;
    try {
      job = await api.claim();
      connected = true;
      failures = 0;
    } catch (err) {
      if (err instanceof StopError) break;
      const hint = configHint(err);
      if (hint && !connected) { // wrong token / URL: say so instead of retrying forever
        log.error(hint);
        return 1;
      }
      if (once) {
        log.error(`Could not claim a job: ${describe(err)}`);
        return 1;
      }
      failures++;
      const wait = Math.min(300, cfg.pollSeconds * 2 ** Math.min(failures, 5));
      log.warn(`Could not claim a job (${hint ?? describe(err)}); trying again in ${Math.round(wait)} s`);
      await sleep(wait * 1000, stopper.signal).catch(() => {});
      continue;
    }

    if (!job) {
      if (once) {
        log.info('No job waiting.');
        return 0;
      }
      if (!idle) log.info(`Waiting for jobs (checking every ${cfg.pollSeconds} s, Ctrl+C to stop)`);
      idle = true;
      await sleep(cfg.pollSeconds * 1000, stopper.signal).catch(() => {});
      continue;
    }

    idle = false;
    const ok = await processJob(api, asr, cfg, job);
    if (stopper.signal.aborted) break;
    if (once) return ok ? 0 : 1;
  }
  log.info('Stopped.');
  return 0;
}

function configHint(err) {
  if (!(err instanceof HttpError)) return null;
  if (err.status === 401 || err.status === 403) return `The server rejected WORKER_TOKEN (HTTP ${err.status}). It must match one of worker.tokens in server/config.php.`;
  if (err.status === 404 || err.code === 'bad_response') return `The worker API was not found at API_BASE (${describe(err)}). Check API_BASE.`;
  return null;
}

async function checkServer(api) {
  try {
    const health = await api.health();
    if (health?.engines?.worker === false) log.warn('Server reports the worker engine is disabled (worker.enabled in config.php)');
    else log.info(`Server reachable (version ${health?.version ?? 'unknown'})`);
  } catch (err) {
    if (err instanceof StopError) throw err;
    log.warn(`Health check failed (${describe(err)}); continuing anyway`);
  }
}

/** Create TEMP_DIR and remove audio left behind by a crash (only our own job-* files). */
function prepareTempDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('job-')) fs.rmSync(path.join(dir, name), { force: true });
  }
}

function tempPathFor(dir, job) {
  const ext = path.extname(job.filename ?? '').toLowerCase();
  const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.audio';
  const id = String(job.id).replace(/[^\w-]/g, '_').slice(0, 60);
  return path.join(dir, `job-${id}-${crypto.randomBytes(4).toString('hex')}${safeExt}`);
}

/** Download -> decode -> normalise -> transcribe -> complete. Returns true when completed. */
async function processJob(api, asr, cfg, job) {
  const tag = `Job ${job.id}`;
  const started = Date.now();
  log.info(`${tag}: claimed "${job.filename}" (${megabytes(job.file_size ?? 0)}, language ${job.language || 'auto'}, task ${job.task || 'transcribe'})`);

  // Aborted when the worker is stopping, or when the server says the job is no longer ours.
  const jobAbort = new AbortController();
  const onStop = () => jobAbort.abort(new StopError());
  stopper.signal.addEventListener('abort', onStop, { once: true });
  const heartbeat = new Heartbeat(api, job, cfg.heartbeatSeconds, (err) => jobAbort.abort(err));
  const temp = tempPathFor(cfg.tempDir, job);
  state.busy = true;
  state.tempFile = temp;

  try {
    heartbeat.start();
    const bytes = await api.downloadAudio(job, temp, { signal: jobAbort.signal });
    log.info(`${tag}: downloaded ${megabytes(bytes)} in ${elapsed(Date.now() - started)}`);

    const audio = normalize(await decodeAudio(temp, cfg.ffmpegPath, { signal: jobAbort.signal }));
    fs.rmSync(temp, { force: true });
    log.info(`${tag}: decoded ${clock(audio.length / SAMPLE_RATE)} of audio`);
    heartbeat.beat(); // let the server know the long part is starting

    const t0 = Date.now();
    const logProgress = progressLogger(`${tag}: `);
    const result = await transcribe(asr, audio, {
      language: job.language || null,
      task: job.task || 'transcribe',
      signal: jobAbort.signal,
      onProgress: (fraction, position, duration) => {
        heartbeat.progress = Math.min(99, Math.floor(fraction * 100));
        logProgress(fraction, position, duration);
      },
    });
    heartbeat.stop();

    await api.complete(job.id, {
      text: result.text,
      segments: result.segments.map(({ start, end, text }) => ({ start, end, text })),
      duration: result.duration,
      detected_language: result.detected_language,
    });
    log.info(`${tag}: completed (${result.segments.length} segments, ${clock(result.duration)} of audio, ` +
      `transcribed in ${elapsed(Date.now() - t0)} = ${speed(result.duration, Date.now() - t0)}, total ${elapsed(Date.now() - started)})`);
    return true;
  } catch (err) {
    heartbeat.stop();
    if (err instanceof JobLostError) {
      log.warn(`${tag}: ${err.message}; dropping it.`);
      return false;
    }
    const stopped = err instanceof StopError;
    const retry = !(err instanceof PermanentError);
    if (stopped) log.warn(`${tag}: stopped before finishing; handing it back to the queue`);
    else log.error(`${tag}: failed (${retry ? 'transient, will be retried' : 'permanent'}): ${describe(err)}`);
    if (!stopped && !(err instanceof PermanentError)) log.debug(err.stack ?? String(err));

    try {
      await api.fail(job.id, stopped ? 'Worker stopped before finishing the job' : err.message, retry);
      log.info(`${tag}: reported as failed (retry: ${retry})`);
    } catch (reportErr) {
      log.error(`${tag}: could not report the failure (${describe(reportErr)}); the server will reclaim it when the lease expires`);
    }
    return false;
  } finally {
    heartbeat.stop();
    stopper.signal.removeEventListener('abort', onStop);
    fs.rmSync(temp, { force: true });
    state.busy = false;
    state.tempFile = null;
  }
}

/** Extends the job lease and reports progress at least every HEARTBEAT_SECONDS (max 60, max lease/3). */
class Heartbeat {
  constructor(api, job, everySeconds, onLost) {
    const lease = Number(job.lease_seconds) || 900;
    this.everyMs = Math.max(5, Math.min(everySeconds, lease / 3)) * 1000;
    this.api = api;
    this.jobId = job.id;
    this.onLost = onLost;
    this.progress = 0;
    this.timer = null;
    this.busy = false;
  }

  start() {
    this.timer = setInterval(() => this.beat(), this.everyMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async beat() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.api.heartbeat(this.jobId, this.progress);
      log.debug(`Job ${this.jobId}: heartbeat sent (progress ${this.progress}%)`);
    } catch (err) {
      if (err instanceof JobLostError) {
        this.stop();
        this.onLost(err);
      } else if (!(err instanceof StopError)) {
        log.warn(`Job ${this.jobId}: heartbeat failed (${describe(err)}); will try again`);
      }
    } finally {
      this.busy = false;
    }
  }
}

main().then(
  (code) => exit(code ?? 0),
  (err) => {
    if (err instanceof StopError) {
      log.warn('Stopped.');
      return exit(130);
    }
    log.error(err instanceof PermanentError ? err.message : `Fatal: ${err.message}`);
    log.debug(err.stack ?? String(err));
    return exit(1);
  },
);
