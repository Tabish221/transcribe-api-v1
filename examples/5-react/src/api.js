// api.js - every call the React app makes. It only talks to OUR backend (/api/...),
// never to the Transcribe API directly, so the API key is never in the browser.

/** An error with the same fields as the API's {"error":{"code","message"}} body. */
export class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.name = 'ApiError';
    this.status = status; // HTTP status (0 = network problem)
    this.code = code; // e.g. "engine_unavailable"
    this.field = field; // e.g. "language" for validation errors
  }
}

const networkError = () =>
  new ApiError(0, 'network_error', 'Cannot reach the demo backend. Is "npm run dev" still running?');

/** Builds an ApiError from a parsed error body (or a missing one). */
function toApiError(status, body) {
  const e = body?.error;
  return new ApiError(status, e?.code || 'http_' + status, e?.message || `Request failed (HTTP ${status})`, e?.field);
}

async function getJson(url, signal) {
  let res;
  try {
    res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw networkError();
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw toApiError(res.status, body);
  return body;
}

/** Defaults from the backend: { defaultEngine, defaultLanguage, engines: {cloud, worker} | null, maxUploadMb }. */
export const getConfig = (signal) => getJson('/api/config', signal);

/** The transcription object: status, progress, text, segments ... */
export const getTranscription = (id, signal) => getJson(`/api/transcriptions/${encodeURIComponent(id)}`, signal);

/**
 * Uploads the file. Uses XMLHttpRequest (not fetch) because only XHR reports upload progress.
 * Resolves with the transcription object (status "queued", or "completed" for cloud + wait).
 */
export function uploadAudio(file, { engine, language }, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    form.append('engine', engine);
    form.append('language', language);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/transcribe');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.id) resolve(body);
      else reject(toApiError(xhr.status, body));
    };
    xhr.onerror = () => reject(networkError());
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

/** Downloads the .srt file. Uses fetch first, so an API error is shown nicely instead of as a broken file. */
export async function downloadSrt(id) {
  let res;
  try {
    res = await fetch(`/api/transcriptions/${encodeURIComponent(id)}/srt`);
  } catch {
    throw networkError();
  }
  if (!res.ok) throw toApiError(res.status, await res.json().catch(() => null));

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filenameFrom(res.headers.get('Content-Disposition')) || `${id}.srt`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** The demo's sample clip (../sample/clip.mp3, served by the backend) as a File, like a file the user picked. */
export async function getSampleFile() {
  let res;
  try {
    res = await fetch('/api/sample');
  } catch {
    throw networkError();
  }
  if (!res.ok) throw toApiError(res.status, await res.json().catch(() => null));
  return new File([await res.blob()], 'clip.mp3', { type: 'audio/mpeg' });
}

/**
 * API Tester: POST /api/tester/:action. `input` is a plain object (sent as JSON) or a FormData (upload).
 * Always resolves (never throws) with one "exchange" for the page:
 *   { action, at, source, request, response: { status, ok, headers, body }, duration_ms }
 * source = "api"     -> the backend called the Transcribe API; request/response are that call (key masked)
 * source = "backend" -> the demo backend answered by itself (bad input, API offline, ...)
 */
export async function callTester(action, input = {}, signal) {
  const isForm = input instanceof FormData;
  const url = `/api/tester/${action}`;
  const at = new Date();
  const started = performance.now();
  const backendRequest = {
    method: 'POST',
    url,
    headers: { 'Content-Type': isForm ? 'multipart/form-data' : 'application/json' },
    fields: isForm ? formFields(input) : input,
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: isForm ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: isForm ? input : JSON.stringify(input),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    const body = { error: { code: 'network_error', message: 'Cannot reach the demo backend. Is "npm run dev" still running?' } };
    return { action, at, source: 'backend', request: backendRequest, response: { status: 0, ok: false, headers: {}, body }, duration_ms: Math.round(performance.now() - started) };
  }

  const body = await res.json().catch(() => null);
  if (res.ok && body?.request && body?.response) return { action, at, source: 'api', ...body };

  // The backend itself refused (e.g. invalid id) or could not reach the API.
  return {
    action,
    at,
    source: 'backend',
    request: backendRequest,
    response: { status: res.status, ok: false, headers: { 'content-type': res.headers.get('content-type') }, body },
    duration_ms: Math.round(performance.now() - started),
  };
}

/** FormData -> plain object for display (files as "name (size)"). */
function formFields(form) {
  const out = {};
  for (const [name, value] of form.entries()) {
    out[name] = typeof value === 'string' ? value : `${value.name} (${Math.round(value.size / 1024)} KB)`;
  }
  return out;
}

/** Reads the file name from: attachment; filename="call.srt"; filename*=UTF-8''call.srt */
function filenameFrom(header) {
  if (!header) return null;
  const star = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through */
    }
  }
  return header.match(/filename="([^"]+)"/i)?.[1] ?? null;
}
