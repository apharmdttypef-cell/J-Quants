import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 権利日の計算を Lambda と同じ lambda/shared/trading-calendar.ts で行うため、frontend の外も読めるようにする。
  server: { fs: { allow: ['..'] } },
})
