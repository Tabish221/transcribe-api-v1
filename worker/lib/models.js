// Facts about Whisper checkpoints and language codes. No heavy imports, so tests can load it directly.

import { PermanentError } from './errors.js';

// Whisper's tokenizer uses a few codes that differ from ISO-639-1 (the API's codes): Javanese is <|jw|>.
const ISO_TO_WHISPER = { jv: 'jw' };
const WHISPER_TO_ISO = Object.fromEntries(Object.entries(ISO_TO_WHISPER).map(([iso, w]) => [w, iso]));

/** ISO-639-1 code from the server -> the code of the model's language token. */
export function whisperLanguage(code) {
  return code ? (ISO_TO_WHISPER[code] ?? code) : code;
}

/** Language token code from the model -> ISO-639-1 code for the server. */
export function isoLanguage(code) {
  return code ? (WHISPER_TO_ISO[code] ?? code) : code;
}

/**
 * Whether a checkpoint can do task=translate. The large-v3 "turbo" models were not trained for it
 * (openai/whisper: they return the original language), and English-only "*.en" models have no tasks.
 */
export function canTranslate(modelId) {
  const id = String(modelId ?? '').toLowerCase();
  return !/turbo/.test(id) && !/\.en$/.test(id);
}

/**
 * The model id that handles a job: MODEL, or TRANSLATE_MODEL for translations MODEL cannot do.
 * Throws PermanentError when no configured model can translate (instead of returning untranslated text).
 */
export function modelIdFor(task, { model, translateModel }) {
  if (task !== 'translate' || canTranslate(model)) return model;
  if (translateModel && canTranslate(translateModel)) return translateModel;
  throw new PermanentError(`This worker's model (${model}) cannot translate. Set TRANSLATE_MODEL in the worker's .env `
    + '(e.g. onnx-community/whisper-small) or use the cloud engine for translations.');
}
