import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server on 5173 sends /api to the API on 3000 (started together by `npm run dev`).
// `--mode demo` builds a self-contained preview (no server; sample data in the page) into web/dist-demo.
export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  return {
    root: import.meta.dirname,
    plugins: [react()],
    base: demo ? './' : '/',
    define: { 'import.meta.env.VITE_DEMO': JSON.stringify(demo ? '1' : '') },
    server: {
      port: 5173,
      strictPort: true,
      host: process.env.HOST ?? '127.0.0.1',
      proxy: { '/api': `http://127.0.0.1:${process.env.PORT ?? 3000}` },
      fs: { allow: ['..'] },
    },
    build: {
      outDir: demo ? 'dist-demo' : 'dist',
      emptyOutDir: true,
      rolldownOptions: demo ? { output: { codeSplitting: false } } : undefined,
    },
  };
});
