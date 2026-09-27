import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2023',
  },
  test: {
    root: '.',
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
  },
});
