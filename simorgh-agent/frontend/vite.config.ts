// vite.config. ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vitejs.dev/config/
export default defineConfig({
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
  }
});