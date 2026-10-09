import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    /*
     * Patch 124. After writing the build, Vite gzips every chunk at once only
     * to PRINT their compressed sizes in the terminal. On Windows, with ~200
     * lazy-loaded page chunks and little free memory, zlib fails there with
     * "[vite:reporter] insufficient memory" and the whole build is reported
     * as failed - although nothing was wrong with it. The report is
     * cosmetic; the files written to dist/ are the same without it.
     */
    reportCompressedSize: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/storage'],
          charts: ['recharts'],
          sheets: ['xlsx'],
        },
      },
    },
  },
});
