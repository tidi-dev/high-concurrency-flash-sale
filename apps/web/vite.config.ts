import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the API runs separately on :3000. SSE (/api/stream) is proxied too.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
});
