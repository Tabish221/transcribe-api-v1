// Audio decoding (ffmpeg-static -> 16 kHz mono float32) and loudness normalisation.

import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PermanentError, StopError, WorkerFault } from './errors.js';

export const SAMPLE_RATE = 16000; // what Whisper expects

/**
 * Start-up check that ffmpeg can actually run (ffmpeg-static exports a path even when its download
 * failed, and null on unsupported platforms). Returns a problem description, or null when it works.
 */
export function checkFfmpeg(ffmpegPath) {
  if (!ffmpegPath) return 'ffmpeg was not found (ffmpeg-static has no binary for this platform): install ffmpeg and set FFMPEG_PATH';
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-version'], { stdio: 'ignore', windowsHide: true, timeout: 30000 });
  if (r.error) return `ffmpeg cannot be started from "${ffmpegPath}" (${r.error.code ?? r.error.message}): run "npm install" again or fix FFMPEG_PATH`;
  if (r.status !== 0) return `"${ffmpegPath} -version" failed (exit ${r.status}): run "npm install" again or fix FFMPEG_PATH`;
  return null;
}

/**
 * Decode any file ffmpeg understands into 16 kHz mono float samples, streamed from ffmpeg's stdout.
 * Undecodable input throws PermanentError; an aborted signal kills ffmpeg and throws StopError;
 * an ffmpeg that cannot be started at all throws WorkerFault (a problem of this PC, not of the job).
 */
export function decodeAudio(file, ffmpegPath, { signal } = {}) {
  if (!ffmpegPath) return Promise.reject(new WorkerFault('ffmpeg binary not found (reinstall ffmpeg-static or set FFMPEG_PATH)'));
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file,
    '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'];

  return new Promise((resolve, reject) => {
    // detached: ffmpeg must not receive the console's Ctrl+C itself (it would exit with an error
    // and the job would look undecodable); the worker stops it through `signal` instead.
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true, signal });
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    proc.stdout.on('data', (chunk) => { chunks.push(chunk); bytes += chunk.length; });
    proc.stderr.on('data', (chunk) => { if (stderr.length < 8000) stderr += chunk; });

    proc.on('error', (err) => {
      if (err.name === 'AbortError') reject(signal?.reason instanceof Error ? signal.reason : new StopError());
      else if (['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].includes(err.code)) reject(new WorkerFault(`ffmpeg cannot be started (${err.code})`));
      else reject(new Error(`Could not run ffmpeg: ${err.message}`));
    });
    proc.on('close', (code, killedBy) => {
      if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new StopError());
      if (code === null) return reject(new Error(`ffmpeg was terminated (${killedBy})`)); // not the file's fault
      // Keep the error short and free of local paths before it is sent to the server.
      const detail = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
      const clean = detail.split(file).join(path.basename(file)).slice(0, 300);
      const exit = code > 0x7fffffff ? code - 0x100000000 : code; // Windows reports e.g. -22 as 4294967274
      if (code !== 0) return reject(new PermanentError(`Audio could not be decoded (ffmpeg exit ${exit}): ${clean || 'unknown error'}`));
      if (bytes < 4 * SAMPLE_RATE * 0.1) return reject(new PermanentError('Audio could not be decoded: no audio samples found'));
      resolve(toFloat32(Buffer.concat(chunks, bytes)));
    });
  });
}

/** View a little-endian f32 byte buffer as Float32Array (copying only if it is not 4-byte aligned). */
function toFloat32(buf) {
  const count = Math.floor(buf.length / 4);
  if (buf.byteOffset % 4 === 0) return new Float32Array(buf.buffer, buf.byteOffset, count);
  const out = new Float32Array(count);
  new Uint8Array(out.buffer).set(buf.subarray(0, count * 4));
  return out;
}

/**
 * Boost quiet speech (same as browser-app/transcriber.html): peak-normalise, then scale each 5 s
 * block toward a target loudness, capped so background noise is not blown up. Works in place.
 */
export function normalize(x) {
  const BLOCK = 5 * SAMPLE_RATE, TARGET = 0.1, MAX_GAIN = 8;
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak > 0) for (let i = 0; i < x.length; i++) x[i] /= peak;
  for (let start = 0; start < x.length; start += BLOCK) {
    const end = Math.min(x.length, start + BLOCK);
    let sum = 0;
    for (let i = start; i < end; i++) sum += x[i] * x[i];
    const rms = Math.sqrt(sum / (end - start));
    if (rms < 0.005) continue; // silence, leave it alone
    const gain = Math.min(MAX_GAIN, TARGET / rms);
    if (gain <= 1) continue;
    for (let i = start; i < end; i++) x[i] = Math.max(-1, Math.min(1, x[i] * gain));
  }
  return x;
}
