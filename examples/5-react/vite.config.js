// Vite config: React plugin + a proxy so the browser only talks to OUR backend.
//
//   browser  ->  http://localhost:5173/api/...  ->  (proxy)  ->  http://127.0.0.1:3001/api/...  (server.mjs)
//
// The browser never sees the Transcribe API key. PORT / VITE_PORT change the ports (dev.mjs passes them).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backendPort = process.env.PORT || 3001;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT || 5173),
    strictPort: true, // fail clearly if the port is busy (instead of silently using another one)
    open: process.env.OPEN_BROWSER === '1', // start.bat sets this, so the browser opens when Vite is ready
    proxy: {
      '/api': `http://127.0.0.1:${backendPort}`,
    },
  },
});
