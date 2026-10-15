/**
 * Reads ../.env (KEY=VALUE per line, # starts a comment).
 * A real environment variable with the same name wins over the file.
 *
 *   import { setting } from './env.mjs';
 *   const key = setting('TRANSCRIBE_API_KEY');
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
const values = {};

if (existsSync(ENV_FILE)) {
  for (const raw of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

export function setting(name, fallback = '') {
  return process.env[name] || values[name] || fallback;
}

/** Like setting(), but stops the program with a clear message when the value is missing. */
export function requireSetting(name) {
  const value = setting(name);
  if (!value) {
    console.error(`ERROR: ${name} is missing. Add it to ${ENV_FILE}`);
    process.exit(1);
  }
  return value;
}
