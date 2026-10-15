// dev.mjs - "npm run dev": starts the backend (server.mjs) and Vite together.
// Ctrl+C (or closing the window) stops both. If one of them stops, the other is stopped too.
//
// Ports: backend 3001, Vite 5173. To use other ports:  set PORT=3002 & set VITE_PORT=5174 & npm run dev
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VITE = path.join(HERE, 'node_modules', 'vite', 'bin', 'vite.js');
const PORT = process.env.PORT || '3001';
const VITE_PORT = process.env.VITE_PORT || '5173';

const children = [];
let stopping = false;

function start(name, args) {
  // process.execPath = the same node.exe; no shell, so it works the same on Windows, macOS and Linux.
  const child = spawn(process.execPath, args, {
    cwd: HERE,
    stdio: 'inherit',
    env: { ...process.env, DEMO_DEV: '1', PORT, VITE_PORT },
  });
  child.on('exit', (code) => {
    if (!stopping) {
      console.log(`\n[dev] ${name} stopped${code ? ` (exit code ${code})` : ''}. Stopping everything.`);
      stopAll(code || 0);
    }
  });
  children.push(child);
}

function stopAll(exitCode) {
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  // dev.mjs ends by itself when both children are gone; this is only a safety net.
  setTimeout(() => process.exit(), 3000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => stopAll(0));
}
process.on('exit', () => {
  for (const child of children) if (child.exitCode === null) child.kill();
});

if (!fs.existsSync(VITE)) {
  console.error('[dev] Vite is not installed yet. Run "npm install" first (start.bat does it for you).');
  process.exit(1);
}

console.log(`[dev] Starting the backend (http://127.0.0.1:${PORT}) and Vite (http://localhost:${VITE_PORT}) ...`);
console.log('[dev] Press Ctrl+C to stop both.');
start('backend', ['server.mjs']);
start('vite', [VITE]);
