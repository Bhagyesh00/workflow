import { defineConfig } from 'vite';

// Library build of the embeddable widget: one IIFE script (global `WorkflowChat`) and one stylesheet,
// served by the server at /chat-widget/chat.js and /chat-widget/chat.css. File names carry no hash:
// the route caches them for one hour with an ETag.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['iife'],
      name: 'WorkflowChat',
      fileName: () => 'chat.js',
      cssFileName: 'chat',
    },
  },
});
