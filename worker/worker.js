// Transcribe API PC worker.
// Server mode: claims "worker" jobs from the server, transcribes them locally with Whisper and posts
// the result back (SPEC sections 8 and 11). Local mode (--file): runs the same pipeline on one file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { USAGE, WORKER_DIR, parseCli, loadConfig, serverConfigProblems } from './lib/config.js';
import { configureLog, log, clock, elapsed, megabytes } from './lib/log.js';
import { SAMPLE_RATE, checkFfmpeg, decodeAudio, normalize } from './lib/audio.js';
import { loadModel, transcribe } from './lib/whisper.js';
import { canTranslate, modelIdFor } from './lib/models.js';
import { WorkerApi, sleep, describe } from './lib/api.js';
import { HttpError, JobLostError, PermanentError, StopError, WorkerFault } from './lib/errors.js';

/** After this many jobs in a row fail on this PC (not because of the audio), the worker stops. */
const MAX_FAILED_JOBS = 3;

// ---------------------------------------------------------------------------------------------
// Shutdown. Server mode: the job in progress is handed back to the queue at once (the running 30 s
// window cannot be interrupted), then the worker exits after the current step, or as soon as the hand-back
// is sent when Windows is closing the console window (it kills the process ~10 s later).
// Local mode: the current step finishes, then the worker exits. A second Ctrl+C exits immediately.

const stopper = new AbortController();
const state = { busy: false, tempFile: null, models: [], current: null };

/**
 * Release the models and let Node exit on its own. Calling process.exit() while ONNX Runtime still has
 * native callbacks pending aborts on Windows (libuv assertion, exit code 0xC0000409), so a hard exit is
 * only the fallback if something keeps the process alive.
 */
async function exit(code) {
  const models = state.models.splice(0);
  await Promise.all(models.map((m) => m.dispose().catch(() => {})));
  process.exitCode = code;
  setTimeout(() => process.exit(code), 3000).unref();
}

function requestStop(reason, { urgent = false } = {}) {
  if (stopper.signal.aborted) {
    log.warn('Forced exit.');
    process.exit(130);
  }
  stopper.abort(new StopError());
  if (!state.busy) {
    log.info(`${reason}: stopping.`);
    exit(0); // idle or still loading the model: nothing to hand back
  } else if (state.current) {
    log.warn(`${reason}: handing job ${state.current.id} back to the queue`);
    const released = releaseJob(state.current, 'Worker stopped before finishing the job');
    if (urgent) released.finally(() => process.exit(130));
    else log.warn('Stopping after the current step (press Ctrl+C again to force quit)');
  } else {
    log.warn(`${reason}: stopping after the current step (press Ctrl+C again to force quit)`);
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  const urgent = sig === 'SIGHUP' || sig === 'SIGBREAK'; // console window closing / Ctrl+Break
  process.on(sig, () => requestStop(sig === 'SIGINT' ? 'Ctrl+C' : sig, { urgent }));
}
// Windows cannot deliver signals to child processes, so process managers send this IPC message instead.
process.on('message', (msg) => { if (msg === 'shutdown') requestStop('Shutdown requested'); });
process.channel?.unref();
// Last-resort cleanup, also on a forced exit.
process.on('exit', () => { if (state.tempFile) fs.rmSync(state.tempFile, { force: true }); });

/** Hands a claimed job back to the queue once (retry + release: the attempt is not used up). */
function releaseJob(current, reason) {
  current.release ??= current.api.release(current.id, reason).then(
    () => log.info(`Job ${current.id}: handed back to the queue`),
    (err) => {
      if (err instanceof JobLostError) return; // already gone (deleted or re-claimed)
      log.error(`Job ${current.id}: could not hand it back (${describe(err)}); the server re-queues it when the lease expires`);
    },
  );
  return current.release;
}

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

/** Load a model; if a GPU device (dml/cuda) does not work on this PC, fall back to the CPU. */
async function loadModelWithFallback(cfg, model = cfg.model) {
  log.info(`Loading ${model} (device ${cfg.device}, dtype ${dtypeLabel(cfg.dtype)}, cache ${cfg.cacheDir})`);
  let asr;
  try {
    asr = await loadModel({ ...cfg, model });
  } catch (err) {
    if (cfg.device === 'cpu') throw err;
    log.warn(`DEVICE=${cfg.device} failed (${err.message.split('\n')[0]}); falling back to cpu`);
    asr = await loadModel({ ...cfg, model, device: 'cpu' });
  }
  state.models.push(asr);
  return asr;
}

/**
 * The pipeline for a task. MODEL handles everything it can; translations go to TRANSLATE_MODEL (loaded on
 * first use) when MODEL cannot translate, because large-v3-turbo silently returns the source language.
 */
async function modelFor(task, cfg, models) {
  const id = modelIdFor(task, cfg); // PermanentError when nothing configured can translate
  if (id === cfg.model) return models.main;
  models.translate ??= loadModelWithFallback(cfg, id).catch((err) => {
    models.translate = null; // try again for the next job
    throw err;
  });
  return models.translate;
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
  const ffmpegProblem = checkFfmpeg(cfg.ffmpegPath);
  if (ffmpegProblem) throw new WorkerFault(ffmpegProblem);

  const models = { main: await loadModelWithFallback(cfg) };
  const asr = await modelFor(task, cfg, models);
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
  // Without a working ffmpeg every job would fail: refuse to start instead of failing the queue.
  const ffmpegProblem = checkFfmpeg(cfg.ffmpegPath);
  if (ffmpegProblem) {
    log.error(ffmpegProblem);
    return 1;
  }
  const api = new WorkerApi(cfg, stopper.signal);
  log.info(`Worker "${cfg.workerName}" for ${cfg.apiBase} (token set, ${cfg.token.length} chars)`);
  if (api.base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(api.base.hostname)) {
    log.warn('API_BASE uses plain http: the worker token and audio travel unencrypted. Use https.');
  }
  if (!canTranslate(cfg.model)) {
    log.info(cfg.translateModel
      ? `Translations (task=translate) use ${cfg.translateModel}, loaded on first use`
      : `${cfg.model} cannot translate: task=translate jobs will fail (set TRANSLATE_MODEL to handle them)`);
  }
  prepareTempDir(cfg.tempDir);
  await checkServer(api);
  const models = { main: await loadModelWithFallback(cfg), translate: null };

  let connected = false;
  let failures = 0;   // claim errors in a row
  let failedJobs = 0; // jobs in a row that failed on this PC (transient errors)
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
    const outcome = await processJob(api, models, cfg, job);
    if (stopper.signal.aborted) break;
    if (outcome === 'fault') {
      log.error('This PC cannot run jobs right now (see above). The job was handed back; fix the problem and start the worker again.');
      return 1;
    }
    if (once) return outcome === 'completed' ? 0 : 1;
    if (outcome === 'completed') failedJobs = 0;
    if (outcome !== 'retry') continue;

    // A failure that was not the audio's fault: back off, and stop before one broken PC uses up the
    // attempts of every queued job.
    failedJobs++;
    if (failedJobs >= MAX_FAILED_JOBS) {
      log.error(`${failedJobs} jobs in a row failed on this PC, so the problem is probably here, not in the audio. `
        + 'Stopping so the queue is not used up; check the errors above and start the worker again.');
      return 1;
    }
    const wait = Math.min(300, cfg.pollSeconds * 2 ** failedJobs);
    log.warn(`Pausing ${wait} s before the next job`);
    await sleep(wait * 1000, stopper.signal).catch(() => {});
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

/** Error text for the server: local paths (user name, folders) are replaced by "<local>". */
function publicMessage(message, cfg) {
  const paths = [cfg.ffmpegPath, cfg.tempDir, cfg.cacheDir, WORKER_DIR, os.homedir()]
    .filter((p) => typeof p === 'string' && p.length > 3)
    .flatMap((p) => [p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')])
    .sort((a, b) => b.length - a.length); // longest first: ffmpeg's path is inside WORKER_DIR
  let text = String(message);
  for (const p of paths) text = text.split(p).join('<local>');
  return text;
}

/**
 * Download -> decode -> normalise -> transcribe -> complete.
 * Returns 'completed', 'permanent' (bad audio etc., reported with retry:false), 'retry' (failed on this PC,
 * reported with retry:true), 'fault' (this PC cannot run jobs; handed back), 'stopped' or 'lost'.
 */
async function processJob(api, models, cfg, job) {
  const tag = `Job ${job.id}`;
  const started = Date.now();
  const task = job.task || 'transcribe';
  log.info(`${tag}: claimed "${job.filename}" (${megabytes(job.file_size ?? 0)}, language ${job.language || 'auto'}, task ${task})`);

  // Aborted when the worker is stopping, or when the server says the job is no longer ours.
  const jobAbort = new AbortController();
  const onStop = () => jobAbort.abort(new StopError());
  stopper.signal.addEventListener('abort', onStop, { once: true });
  const heartbeat = new Heartbeat(api, job, cfg.heartbeatSeconds, (err) => jobAbort.abort(err));
  const temp = tempPathFor(cfg.tempDir, job);
  const current = { id: job.id, api, release: null };
  state.busy = true;
  state.tempFile = temp;
  state.current = current;

  try {
    heartbeat.start();
    const asr = await modelFor(task, cfg, models);
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
      task,
      signal: jobAbort.signal,
      onProgress: (fraction, position, duration) => {
        heartbeat.progress = Math.min(99, Math.floor(fraction * 100));
        logProgress(fraction, position, duration);
      },
    });
    heartbeat.stop();
    if (current.release) throw new StopError(); // handed back while the last window ran

    await api.complete(job.id, {
      text: result.text,
      segments: result.segments.map(({ start, end, text }) => ({ start, end, text })),
      duration: result.duration,
      detected_language: result.detected_language,
    });
    log.info(`${tag}: completed (${result.segments.length} segments, ${clock(result.duration)} of audio, ` +
      `transcribed in ${elapsed(Date.now() - t0)} = ${speed(result.duration, Date.now() - t0)}, total ${elapsed(Date.now() - started)})`);
    return 'completed';
  } catch (err) {
    heartbeat.stop();
    if (err instanceof StopError || current.release) {
      log.warn(`${tag}: stopped before finishing`);
      await releaseJob(current, 'Worker stopped before finishing the job');
      return 'stopped';
    }
    if (err instanceof JobLostError) {
      log.warn(`${tag}: ${err.message}; dropping it.`);
      return 'lost';
    }
    if (err instanceof WorkerFault) {
      log.error(`${tag}: ${err.message}`);
      await releaseJob(current, 'The worker could not run the job on its computer');
      return 'fault';
    }
    const retry = !(err instanceof PermanentError);
    log.error(`${tag}: failed (${retry ? 'transient, will be retried' : 'permanent'}): ${describe(err)}`);
    if (retry) log.debug(err.stack ?? String(err));

    try {
      await api.fail(job.id, publicMessage(err.message, cfg), retry);
      log.info(`${tag}: reported as failed (retry: ${retry})`);
    } catch (reportErr) {
      log.error(`${tag}: could not report the failure (${describe(reportErr)}); the server will reclaim it when the lease expires`);
    }
    return retry ? 'retry' : 'permanent';
  } finally {
    heartbeat.stop();
    stopper.signal.removeEventListener('abort', onStop);
    fs.rmSync(temp, { force: true });
    state.busy = false;
    state.tempFile = null;
    state.current = null;
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
    log.error(err instanceof PermanentError || err instanceof WorkerFault ? err.message : `Fatal: ${err.message}`);
    log.debug(err.stack ?? String(err));
    return exit(1);
  },
);
