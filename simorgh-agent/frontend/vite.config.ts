// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    'process.env': {} // این خط مشکل process is not defined رو حل می‌کنه
  },
  resolve: {
    alias: {
      // ioredis رو کاملاً از باندل فرانت‌اند حذف می‌کنیم
      ioredis: '/src/mock/ioredis.ts'
    }
  },
  build: {
    rollupOptions: {
      // اختیاری: اگر هنوز لود می‌شد، اینم اضافه کن
      external: ['ioredis', 'redis']
    }
  }
});