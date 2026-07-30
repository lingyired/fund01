import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
) as { version: string }

export default defineConfig({
  plugins: [pluginReact()],
  source: {
    entry: {
      background: './src/background/index.ts',
      popup: './src/popup/index.tsx',
    },
  },
  output: {
    distPath: { root: 'dist' },
    filename: { js: '[name].js' },
  },
  resolve: {
    alias: {
      '@fund01/core': path.resolve(__dirname, '../../packages/core/src'),
      '@fund01/services': path.resolve(__dirname, '../../packages/services/src'),
      '@fund01/ui': path.resolve(__dirname, '../../packages/ui/src'),
    },
  },
  performance: {
    chunkSplit: { strategy: 'all-in-one' },
  },
  html: {
    template: './src/popup/index.html',
    title: `wzk-fund · 基金盯盘 v${pkg.version}`,
  },
})
