import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'
import { getBuildDefines } from '../../scripts/build-info.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [pluginReact()],
  source: {
    // 构建戳：注入 git short SHA / 构建时间 / 分支 / dirty（见 scripts/build-info.mjs 与 packages/ui/src/buildInfo.ts）
    define: getBuildDefines(),
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
    // 把仓库根 lingyired/（作者其他项目的图标）复制到 dist/lingyired/，
    // 供 OptionsApp 「关于 - 作者的其他项目」卡片引用（./lingyired/<id>.png）。
    // 路径用绝对路径避免依赖 cwd（tauri build 时 cwd 是 apps/tauri/）。
    copy: [
      {
        from: path.resolve(__dirname, '../../lingyired'),
        to: 'lingyired',
      },
    ],
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
      entryName === 'options' ? 'Fund01 · 设置' : 'Fund01 · 基金盯盘',
  },
})
