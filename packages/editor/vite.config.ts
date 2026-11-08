import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER = process.env.WORKFLOW_SERVER_URL ?? 'http://localhost:5678';
const PORT = Number(process.env.EDITOR_PORT ?? 8080);
// the origin the server accepts as its own: its BASE_URL (`make start` sets it to this dev server)
const SERVER_ORIGIN = new URL(process.env.BASE_URL ?? SERVER).origin;

/**
 * The server checks that the Origin of mutating requests matches its BASE_URL (CSRF rule). In
 * development the editor runs on its own port, so requests that come from the dev server's own
 * origin are presented to the API with the server's BASE_URL origin. Requests from any other
 * origin pass unchanged.
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
        req.setHeader('origin', SERVER_ORIGIN);
    });
  },
};

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // the demo build is served from arbitrary paths, so its assets are referenced relatively
  base: mode === 'demo' ? './' : '/',
  server: {
    port: PORT,
    // the server's BASE_URL and the Origin rewrite name this port, so never move to another one
    strictPort: true,
    // Vite's own CORS layer answers every preflight before the proxy runs, so the server never sees the
    // hosted chat page's preflight (Origin null) and never grants it; off, Vite sends no CORS headers itself
    cors: false,
    proxy: {
      '/rest': proxyTarget,
      '/api': proxyTarget,
      '/webhook': proxyTarget,
      '/webhook-test': proxyTarget,
      '/webhook-waiting': proxyTarget,
      // the hosted chat page loads the widget (chat.js, chat.css) from the server
      '/chat-widget': proxyTarget,
      // regex keys: a plain '/form' prefix would also send the SPA route /form-auth to the server
      '^/form/': proxyTarget,
      '^/form-test/': proxyTarget,
      '^/form-waiting/': proxyTarget,
    },
  },
  build: {
    outDir: mode === 'demo' ? 'dist/demo' : 'dist',
    sourcemap: mode !== 'demo',
    chunkSizeWarningLimit: 1600,
  },
}));
