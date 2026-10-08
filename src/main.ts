import { createApp } from 'vue'
import App from './App.vue'
import './styles/main.css'
import { loadSettings } from './composables/useSettings'

loadSettings()

function mountApp(): void {
  createApp(App).mount('#app')
}

/**
 * 生产构建会把脚本内联进单个 HTML 文件。这里再做一层保险：
 * 只有挂载点已经存在时才立即挂载，否则等 DOM 解析完成，
 * 这样即使脚本被放在 <head>（或被浏览器以其它顺序执行）也不会白屏。
 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountApp, { once: true })
} else {
  mountApp()
}
