import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER = process.env.WORKFLOW_SERVER_URL ?? 'http://localhost:5678';
const PORT = Number(process.env.EDITOR_PORT ?? 8080);

/**
 * The server checks that the Origin of mutating requests matches its BASE_URL (CSRF rule). In
 * development the editor runs on its own port, so requests that come from the dev server's own
 * origin are presented to the API as same-origin. Requests from any other origin pass unchanged.
 */
const proxyTarget = {
  target: SERVER,
  changeOrigin: true,
  configure(proxy: {
    on(
      event: 'proxyReq',
      cb: (req: { getHeader(n: string): unknown; setHeader(n: string, v: string): void }) => void,
    ): void;
  }) {
    proxy.on('proxyReq', (req) => {
      const origin = req.getHeader('origin');
      if (origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`)
        req.setHeader('origin', SERVER);
    });
  },
};

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // the demo build is served from arbitrary paths, so its assets are referenced relatively
  base: mode === 'demo' ? './' : '/',
  server: {
    port: PORT,
    proxy: {
      '/rest': proxyTarget,
      '/api': proxyTarget,
      '/webhook': proxyTarget,
      '/webhook-test': proxyTarget,
      '/webhook-waiting': proxyTarget,
    },
  },
  build: {
    outDir: mode === 'demo' ? 'dist/demo' : 'dist',
    sourcemap: mode !== 'demo',
    chunkSizeWarningLimit: 1600,
  },
}));
