import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'
import type { Plugin } from 'vite'

/**
 * 构建产物要能直接双击（file:// 协议）运行，需要两件事：
 *
 * 1) file:// 下浏览器会以 CORS 为由拒绝执行 <script type="module">，
 *    而单文件构建的产物本来就是 IIFE，不需要模块语义 —— 去掉 type="module"；
 * 2) Vite 会把 module script 提升到 <head>（module 脚本默认 defer，位置无所谓）。
 *    一旦变成经典脚本，它就是**同步执行**的：此时 <div id="app"> 还没被解析出来，
 *    Vue 会挂载失败 —— 双击打开就是白屏。所以必须把脚本移到 </body> 之前。
 */
function classicInlineScript(): Plugin {
  return {
    name: 'lan-direct-transfer:classic-inline-script',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = bundle['index.html']
      if (!html || html.type !== 'asset' || typeof html.source !== 'string') return

      let source = html.source
      source = source.replace(/<script\b[^>]*\btype=["']module["'][^>]*>/gi, '<script>')

      const scriptTag = source.match(/<script\b[^>]*>[\s\S]*?<\/script>/i)
      if (scriptTag && source.includes('</body>')) {
        // 注意：替换内容里可能含 $& / $' 等字符，必须用函数形式，避免被当成替换模式
        source = source.replace(scriptTag[0], () => '')
        source = source.replace('</body>', () => `${scriptTag[0]}\n</body>`)
      }

      if (/\btype=["']module["']/i.test(source)) {
        this.error('单文件产物中仍存在 module script，file:// 下将无法执行')
      }
      if (source.indexOf('<script') < source.indexOf('id="app"')) {
        this.error('内联脚本出现在挂载点之前，双击打开会白屏')
      }
      html.source = source
    }
  }
}

export default defineConfig({
  base: './',
  plugins: [vue(), viteSingleFile(), classicInlineScript()],
  build: {
    target: 'es2019',
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024,
    chunkSizeWarningLimit: 8192,
    modulePreload: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true
      }
    }
  },
  server: {
    host: true,
    port: 5173
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts']
  }
})
