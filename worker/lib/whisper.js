// Whisper via transformers.js: model loading, language detection and seek-based 30 s windows.

import zlib from 'node:zlib';
import { env, pipeline, Tensor, LogLevel } from '@huggingface/transformers';
import { SAMPLE_RATE } from './audio.js';
import { PermanentError, StopError } from './errors.js';
import { log, elapsed, megabytes } from './log.js';

const WINDOW = 30;            // seconds of audio Whisper hears at once
const EDGE = WINDOW - 1;      // a segment ending after this is treated as cut by the window edge
const MAX_NEW_TOKENS = 224;   // per window, as openai-whisper (half the 448-token decoder context)
const TEMPERATURES = [0, 0.2, 0.4, 0.6, 0.8, 1.0]; // openai-whisper fallback schedule
const MAX_COMPRESSION = 2.4;  // zlib ratio above this means the text is a repetition loop

/** Load (and on first use download) the model into CACHE_DIR. Returns the ASR pipeline. */
export async function loadModel({ model, device, dtype, cacheDir }) {
  env.cacheDir = cacheDir;
  env.logLevel = LogLevel.ERROR; // keep ONNX Runtime / library chatter out of the console

  const started = Date.now();
  const shown = new Map(); // file -> last logged 10 % step (only files that really download)
  const asr = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype,
    progress_callback: (p) => {
      if (p.status !== 'progress' || !(p.total > 5e6)) return; // only report the big model files
      if (!shown.has(p.file) && p.progress >= 100) return;    // served from cache, nothing to report
      const step = Math.floor(p.progress / 10) * 10;
      if (step > (shown.get(p.file) ?? -10)) {
        shown.set(p.file, step);
        log.info(`Downloading ${p.file}: ${step}% of ${megabytes(p.total)}`);
      }
    },
  });
  log.info(`Model ${model} ready on ${device} (${typeof dtype === 'string' ? dtype : JSON.stringify(dtype)}) in ${elapsed(Date.now() - started)}`);
  return asr;
}

const isMultilingual = (asr) => asr.model.generation_config?.is_multilingual !== false;

/**
 * Detect the spoken language from the first 30 s: one encoder pass plus one decoder step after
 * <|startoftranscript|>, then pick the most likely language token (what openai-whisper does).
 * Returns an ISO code such as "en", or null if the model has no language tokens.
 */
export async function detectLanguage(asr, audio) {
  const gc = asr.model.generation_config;
  const languages = Object.entries(gc?.lang_to_id ?? {});
  if (!languages.length) return null;

  const { input_features } = await asr.processor(audio.subarray(0, WINDOW * SAMPLE_RATE));
  const decoder_input_ids = new Tensor('int64', [BigInt(gc.decoder_start_token_id)], [1, 1]);
  const { logits } = await asr.model({ input_features, decoder_input_ids });
  const data = (logits.type === 'float32' ? logits : logits.to('float32')).data;
  const row = data.subarray(data.length - logits.dims.at(-1)); // scores for the next token

  let best = null;
  for (const [token, id] of languages) if (!best || row[id] > row[best[1]]) best = [token, id];
  return best[0].slice(2, -2); // "<|en|>" -> "en"
}

/**
 * Transcribe 16 kHz mono samples with the browser app's seek-based windows: each 30 s window starts
 * where the last COMPLETE segment ended, so a segment cut by the window edge is heard again in full
 * by the next window instead of being split or lost.
 *
 * options: language (code or null = detect), task, signal (abort between windows),
 *          onProgress(fraction 0..1, offsetSeconds, durationSeconds)
 * Returns { text, segments: [{id, start, end, text}], duration, detected_language }.
 */
export async function transcribe(asr, audio, { language = null, task = 'transcribe', signal, onProgress } = {}) {
  const duration = audio.length / SAMPLE_RATE;
  const opts = { return_timestamps: true, max_new_tokens: MAX_NEW_TOKENS };
  let lang = language ? String(language).toLowerCase() : null;

  if (isMultilingual(asr)) {
    if (lang && lang.length <= 3 && asr.model.generation_config.lang_to_id?.[`<|${lang}|>`] === undefined) {
      throw new PermanentError(`Language "${lang}" is not supported by this model`);
    }
    if (!lang) {
      const t0 = Date.now();
      lang = (await detectLanguage(asr, audio)) ?? 'en';
      log.info(`Detected language: ${lang} (${elapsed(Date.now() - t0)})`);
    }
    opts.language = lang;
    opts.task = task === 'translate' ? 'translate' : 'transcribe';
  } else {
    // English-only checkpoints (*.en) reject language/task options.
    if (task === 'translate') log.warn('English-only model: task "translate" ignored');
    lang = 'en';
  }

  const segments = [];
  const add = (start, end, text) => {
    text = text.trim();
    if (!text) return;
    start = Math.min(start, duration);
    end = Math.min(Math.max(end, start), duration);
    segments.push({ id: segments.length, start: round2(start), end: round2(end), text });
  };

  let off = 0;
  let guard = Math.ceil(duration) + 10; // every pass advances at least 1 s, so this is never reached normally
  while (off < duration - 0.5) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new StopError();
    if (--guard < 0) throw new Error('Transcription stopped making progress');

    const last = off + WINDOW >= duration;
    const window = audio.subarray(Math.floor(off * SAMPLE_RATE), Math.floor((off + WINDOW) * SAMPLE_RATE));
    let result;
    try {
      result = await decodeWindow(asr, window, opts, off);
    } catch (err) {
      if (/language/i.test(err.message)) throw new PermanentError(err.message);
      throw err;
    }

    const chunks = result.chunks ?? [];
    let next = null; // end of the last complete segment (absolute seconds)
    let cutAt = chunks.length;
    for (let i = 0; i < chunks.length; i++) {
      const [a, b] = chunks[i].timestamp;
      if (!last && (b == null || b > EDGE)) { cutAt = i; break; } // cut by the window edge: redo next window
      add(off + (a ?? 0), off + (b ?? WINDOW), chunks[i].text);
      next = off + (b ?? WINDOW);
    }

    if (last) {
      off = duration;
    } else if (next !== null && next > off + 1) {
      off = next;
    } else {
      // No usable segment end (silence, or one segment longer than the window): move on by
      // almost a full window, keeping the cut text rather than dropping it.
      for (const c of chunks.slice(cutAt)) {
        if ((c.timestamp[0] ?? 0) < EDGE) add(off + (c.timestamp[0] ?? 0), off + Math.min(c.timestamp[1] ?? WINDOW, WINDOW), c.text);
      }
      off += EDGE;
    }
    onProgress?.(Math.min(off, duration) / duration, Math.min(off, duration), duration);
  }

  return {
    text: segments.map((s) => s.text).join(' '),
    segments,
    duration: round2(duration),
    detected_language: lang,
  };
}

/**
 * Decode one window greedily. If the text is a repetition loop ("going to be going to be ..."),
 * decode again with sampling at rising temperatures, like openai-whisper's fallback, and keep
 * the first acceptable result (or the least repetitive one).
 */
async function decodeWindow(asr, samples, opts, offset) {
  let best = null;
  for (const temperature of TEMPERATURES) {
    const result = await asr(samples, temperature ? { ...opts, do_sample: true, temperature } : opts);
    const ratio = compressionRatio(result.text ?? '');
    if (ratio <= MAX_COMPRESSION) return result;
    log.debug(`Window at ${offset.toFixed(1)} s looks repetitive (ratio ${ratio.toFixed(2)} at temperature ${temperature}), retrying`);
    if (!best || ratio < best.ratio) best = { result, ratio };
  }
  log.warn(`Window at ${offset.toFixed(1)} s stayed repetitive after ${TEMPERATURES.length} attempts; keeping the best one`);
  return best.result;
}

function compressionRatio(text) {
  const bytes = Buffer.from(text.trim(), 'utf8');
  return bytes.length ? bytes.length / zlib.deflateSync(bytes).length : 0;
}

const round2 = (n) => Math.round(n * 100) / 100;
