import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [pluginReact()],
  source: {
    entry: {
      // menubar 浮窗入口（加载 App.tsx，680x600）
      index: './src/menubar.tsx',
      // 设置窗口入口（加载 OptionsApp.tsx，options.html?tab= 直达）
      options: './src/options.tsx',
    },
  },
  output: {
    distPath: { root: 'dist', js: '', css: 'static/css' },
    filename: { js: '[name].js' },
  },
  resolve: {
    alias: {
      '@fund01/core': path.resolve(__dirname, '../../packages/core/src'),
      '@fund01/ui': path.resolve(__dirname, '../../packages/ui/src'),
    },
  },
  tools: {
    rspack: {
      module: {
        rules: [
          // `?raw` 后缀：以纯文本导入（如 docs/import-prompt.md?raw）
          { resourceQuery: /\?raw$/, type: 'asset/source' },
        ],
      },
    },
  },
  server: {
    // 与 tauri.conf.json 的 devUrl 保持一致
    port: 1420,
  },
  performance: {
    chunkSplit: { strategy: 'all-in-one' },
  },
  html: {
    template: ({ entryName }) =>
      entryName === 'options'
        ? './src/options.html'
        : './src/index.html',
    title: ({ entryName }) =>
      entryName === 'options' ? 'fund01 · 设置' : 'fund01 · 基金盯盘',
  },
})
