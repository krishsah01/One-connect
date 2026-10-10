// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const daemon = process.env.ACC_DAEMON_URL ?? 'http://127.0.0.1:7317';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: daemon, changeOrigin: true },
      '/auth': { target: daemon, changeOrigin: true },
      '/ws': { target: daemon.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
});
