import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dedicated port: avoid colliding with other local Vite apps (e.g. py-polymarket on 5173).
// strictPort=true fails loud instead of silently attaching to the wrong project.
const WMB_RENDERER_PORT = 27391;

export default defineConfig({
  root: 'src/renderer',
  clearScreen: false,
  build: { outDir: '../../.vite/renderer/main_window' },
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: WMB_RENDERER_PORT,
    strictPort: true
  }
});
