import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    watch: {
      ignored: ['**/.codebase-memory/**']
    }
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: false
  }
});
