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
      // MV3 Service Worker：纯 JS 入口（会自动生成一个 background.html，由 copy-manifest 清掉）
      background: './src/background/index.ts',
      popup: './src/popup/index.tsx',
      // 原生 options 设置页：独立入口，open_in_tab 全屏呈现
      options: './src/options/index.tsx',
    },
  },
  output: {
    distPath: { root: 'dist', js: '', css: 'static/css' },
    // MV3 Service Worker 不能被 chunk 分割，必须单文件
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
    // 每个入口用各自的 HTML 模板（popup 固定 680x600，options 全屏）
    template: ({ entryName }) =>
      entryName === 'options'
        ? './src/options/index.html'
        : './src/popup/index.html',
    title: ({ entryName }) =>
      entryName === 'options'
        ? 'fund01 · 设置'
        : `fund01 · 基金盯盘 v${pkg.version}`,
  },
})
