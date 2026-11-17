import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = (globalThis as any).process?.env?.RAMPPULSE_DEV_BACKEND ?? 'http://127.0.0.1:18901';

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2020', sourcemap: false, chunkSizeWarningLimit: 900 },
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/healthz': backend,
      '/ws': { target: backend.replace('http', 'ws'), ws: true },
    },
  },
});
