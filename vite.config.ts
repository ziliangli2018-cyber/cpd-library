import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// GitHub Pages serves a static app. Relative assets work under any repository path.
export default defineConfig({
  base: './',
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [react()],
  build: { outDir: 'dist/client', emptyOutDir: true, sourcemap: false },
  server: { host: '127.0.0.1' },
});
