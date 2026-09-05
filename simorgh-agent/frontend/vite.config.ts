// vite.config. ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Base path for deployment under /chatbot/ sub-path
  base: '/chatbot/',
  define: {
    'process.env': {} // این خط مشکل process is not defined رو حل می‌کنه
  },
  resolve: {
    alias: {
      // ioredis رو کاملاً از باندل فرانت‌اند حذف می‌کنیم
      ioredis: path.resolve(__dirname, './src/mock/ioredis.ts')
    }
  },
  build: {
    rollupOptions: {
      // Only keep redis as external since ioredis is now properly mocked
      external: ['redis']
    }
  },
  // Strip console.* and debugger calls from the production bundle.
  // The codebase has ~100 console.log statements (mostly in useChat /
  // useProjects) that fire on every chat switch / SSE chunk —
  // operators reported the page felt sluggish on mid-range Android
  // devices because the DevTools console kept building up. esbuild
  // drops them only when building for prod; `vite dev` keeps full
  // logs for debugging.
  esbuild: command === 'build' ? { drop: ['console', 'debugger'] } : {},
}));