import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Build time in Japan time, formatted like "25:1:11.15:52" (YY:M:D.HH:mm).
 * Cloudflare Pages builds in UTC, so the time zone is fixed explicitly.
 */
function buildVersion(date = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      year: '2-digit',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).map((part) => [part.type, part.value]),
  )
  return `${parts.year}:${parts.month}:${parts.day}.${parts.hour}:${parts.minute}`
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion()),
  },
})
