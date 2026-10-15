// Error types that decide how a failed job is reported to the server.

/** Retrying will not help (undecodable audio, unsupported language...). Reported with retry:false. */
export class PermanentError extends Error {
  name = 'PermanentError';
}

/**
 * This PC cannot run any job (e.g. ffmpeg cannot be started). Not the job's fault: the job is handed
 * back without using up an attempt and the worker stops instead of failing the whole queue.
 */
export class WorkerFault extends Error {
  name = 'WorkerFault';
}

/** The server no longer has this job assigned to us (404/409): drop it silently. */
export class JobLostError extends Error {
  name = 'JobLostError';
}

/** The worker is shutting down (Ctrl+C). The job is handed back (retry:true, release:true). */
export class StopError extends Error {
  name = 'StopError';
  constructor(message = 'Worker stopped before finishing the job') {
    super(message);
  }
}

/** Non-2xx answer from the server. `transient` = worth retrying (5xx, 429, 408). */
export class HttpError extends Error {
  name = 'HttpError';
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.transient = status >= 500 || status === 429 || status === 408;
  }
}

const NETWORK_CODES = /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR)/;

/** Network-level problems (DNS, refused, reset, timeout) and transient HTTP statuses. */
export function isTransient(err) {
  if (err instanceof HttpError) return err.transient;
  if (err?.name === 'TimeoutError') return true;
  const code = err?.code ?? err?.cause?.code;
  if (typeof code === 'string' && NETWORK_CODES.test(code)) return true;
  return err instanceof TypeError && /fetch failed|terminated|network/i.test(err.message);
}
