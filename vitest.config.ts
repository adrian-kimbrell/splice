import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte({ hot: false })],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    benchmark: {
      include: ['src/benches/**/*.bench.ts'],
      outputFile: './bench-results/latest.json',
      reporters: ['default', 'verbose'],
    },
  },
})
