// Client for the server's worker API (SPEC section 8), with retries for transient failures.

import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, JobLostError, PermanentError, StopError, isTransient } from './errors.js';
import { log } from './log.js';

const USER_AGENT = `TranscribeWorker/1.0 (node ${process.version})`;

/** Resolves after `ms`, or rejects with the abort reason (StopError by default) as soon as `signal` aborts. */
export function sleep(ms, signal) {
  const reason = () => (signal.reason instanceof Error ? signal.reason : new StopError());
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(reason());
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    const stop = () => { done(); reject(reason()); };
    const timer = setTimeout(() => { done(); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

export class WorkerApi {
  /** stopSignal aborts claim/download when the worker shuts down; complete/fail ignore it on purpose. */
  constructor({ apiBase, token, workerName }, stopSignal) {
    this.base = new URL(apiBase.replace(/\/+$/, '') + '/');
    this.token = token;
    this.workerName = workerName;
    this.stopSignal = stopSignal;
  }

  url(route) {
    return new URL(route.replace(/^\/+/, ''), this.base);
  }

  /** The token is only ever sent to the API_BASE origin. */
  headers(url, extra = {}) {
    const h = { 'User-Agent': USER_AGENT, Accept: 'application/json', ...extra };
    if (url.origin === this.base.origin) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  /**
   * One JSON request with retries on network errors / 5xx / 429.
   * Returns parsed JSON, or null for 204. Throws HttpError for other statuses.
   */
  async request(method, route, { body, retries = 0, timeoutMs = 30000, stoppable = true } = {}) {
    const url = this.url(route);
    for (let attempt = 0; ; attempt++) {
      try {
        const signals = [AbortSignal.timeout(timeoutMs)];
        if (stoppable && this.stopSignal) signals.push(this.stopSignal);
        const res = await fetch(url, {
          method,
          headers: this.headers(url, body ? { 'Content-Type': 'application/json' } : {}),
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.any(signals),
        });
        return await readJson(res);
      } catch (err) {
        if (stoppable && this.stopSignal?.aborted) throw new StopError();
        if (!isTransient(err) || attempt >= retries) throw err;
        const wait = backoff(attempt);
        log.warn(`${method} ${url.pathname} failed (${describe(err)}); retry ${attempt + 1}/${retries} in ${Math.round(wait / 1000)} s`);
        await sleep(wait, stoppable ? this.stopSignal : undefined);
      }
    }
  }

  /** Quick unauthenticated reachability check: GET /api/v1/health. */
  health() {
    return this.request('GET', 'api/v1/health', { timeoutMs: 15000 });
  }

  /** Returns the claimed job, or null when the queue is empty (204). */
  async claim() {
    const data = await this.request('POST', 'api/worker/claim', { body: { worker: this.workerName } });
    if (!data) return null;
    if (!data.job?.id) throw new HttpError(200, 'bad_response', 'Claim response has no job (check API_BASE)');
    return data.job;
  }

  /** Stream the job's audio to `dest`, retrying transient failures. 404 means the job is gone. */
  async downloadAudio(job, dest, { signal } = {}) {
    const url = this.audioUrl(job);
    for (let attempt = 0, retries = 4; ; attempt++) {
      try {
        const res = await fetch(url, {
          headers: this.headers(url, { Accept: '*/*' }),
          signal: AbortSignal.any([signal ?? this.stopSignal, AbortSignal.timeout(30 * 60 * 1000)].filter(Boolean)),
        });
        if (!res.ok) await readJson(res); // throws HttpError with the server's message
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
        return fs.statSync(dest).size;
      } catch (err) {
        fs.rmSync(dest, { force: true });
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new StopError();
        if (err instanceof HttpError && (err.status === 404 || err.status === 409)) throw new JobLostError(`Audio not available (${err.message})`);
        if (!isTransient(err) || attempt >= retries) throw err;
        const wait = backoff(attempt);
        log.warn(`Audio download failed (${describe(err)}); retry ${attempt + 1}/${retries} in ${Math.round(wait / 1000)} s`);
        await sleep(wait, signal ?? this.stopSignal);
      }
    }
  }

  /** audio_url may be absolute, root-relative or relative to API_BASE (SPEC 8). */
  audioUrl(job) {
    const raw = job.audio_url || `api/worker/jobs/${encodeURIComponent(job.id)}/audio`;
    if (/^https?:\/\//i.test(raw)) return new URL(raw);
    if (raw.startsWith('/')) {
      return raw.startsWith(this.base.pathname) ? new URL(raw, this.base.origin) : this.url(raw);
    }
    return this.url(raw);
  }

  async heartbeat(jobId, progress) {
    return this.jobCall(jobId, 'heartbeat', { progress }, { retries: 0, timeoutMs: 20000 });
  }

  /** Results are precious: retry for a few minutes and keep going even while shutting down. */
  async complete(jobId, result) {
    try {
      return await this.jobCall(jobId, 'complete', result, { retries: 6, timeoutMs: 120000, stoppable: false });
    } catch (err) {
      // The server refused the payload itself (validation, too large): redoing the job will not help.
      if (err instanceof HttpError && [400, 413, 415, 422].includes(err.status)) {
        throw new PermanentError(`Server rejected the result (HTTP ${err.status}): ${err.message}`);
      }
      throw err;
    }
  }

  async fail(jobId, error, retry) {
    return this.jobCall(jobId, 'fail', { error: String(error).slice(0, 1000), retry }, { retries: 3, stoppable: false });
  }

  /**
   * Hand a job back without failing it (graceful stop, broken local setup): retry + release puts it back in
   * the queue and returns the claim's attempt. Quick on purpose: on Windows a closed console window
   * leaves only about 10 s.
   */
  async release(jobId, reason) {
    return this.jobCall(jobId, 'fail', { error: reason, retry: true, release: true }, { retries: 1, timeoutMs: 3000, stoppable: false });
  }

  async jobCall(jobId, action, body, options) {
    try {
      return await this.request('POST', `api/worker/jobs/${encodeURIComponent(jobId)}/${action}`, { body, ...options });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 409)) {
        throw new JobLostError(`Job ${jobId} is no longer assigned to this worker (${err.message})`);
      }
      throw err;
    }
  }
}

/** Parse a JSON response; non-2xx becomes HttpError carrying the SPEC error code/message. */
async function readJson(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new HttpError(res.status, e.code ?? 'http_error', e.message ?? `HTTP ${res.status} ${res.statusText}`.trim());
  }
  if (data === null || typeof data !== 'object') {
    throw new HttpError(res.status, 'bad_response', 'Server did not return JSON (check API_BASE)');
  }
  return data;
}

/** Exponential backoff: 2 s, 4 s, 8 s ... capped at 60 s. */
function backoff(attempt) {
  return Math.min(60000, 2000 * 2 ** attempt);
}

export function describe(err) {
  if (err instanceof HttpError) return `HTTP ${err.status} ${err.code}: ${err.message}`;
  const cause = err?.cause?.code ?? err?.cause?.message;
  return cause ? `${err.message}: ${cause}` : err?.message ?? String(err);
}
