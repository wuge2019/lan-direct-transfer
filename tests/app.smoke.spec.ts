// @vitest-environment jsdom
/**
 * 界面冒烟测试：
 *  1) 用真实的 App.vue 在 jsdom 里挂载，验证模板与响应式状态能正常渲染；
 *  2) 如果已经执行过 `pnpm build`，则把 dist/index.html 里的内联脚本直接
 *     在 jsdom 里跑一遍，验证「单文件构建产物」本身也能正常启动。
 *     （没构建过时自动跳过，不影响 CI）
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { JSDOM } from 'jsdom'
import App from '../src/App.vue'
import { usePeer } from '../src/composables/usePeer'
import { useToast } from '../src/composables/useToast'
import type { TransferView } from '../src/lib/types'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distHtml = path.join(root, 'dist', 'index.html')

let mounted: VueApp | null = null

function mountApp(): HTMLElement {
  document.body.innerHTML = '<div id="app"></div>'
  const container = document.getElementById('app') as HTMLElement
  mounted = createApp(App)
  mounted.mount(container)
  return container
}

afterEach(() => {
  mounted?.unmount()
  mounted = null
  document.body.innerHTML = ''
  // 模块级单例状态是跨用例共享的，手动清理
  const { messages, transfers } = usePeer()
  messages.splice(0, messages.length)
  transfers.splice(0, transfers.length)
  const { toasts } = useToast()
  toasts.splice(0, toasts.length)
})

function makeTransferView(partial: Partial<TransferView>): TransferView {
  return {
    id: 'f-test',
    seq: 9999,
    dir: 'out',
    name: 'demo.bin',
    size: 1024,
    sizeText: '1.00 KB',
    state: 'done',
    percent: 100,
    stateText: '发送完成',
    tone: 'state-ok',
    isDone: true,
    isFailed: false,
    speedText: '',
    canCancel: false,
    canAccept: false,
    canReject: false,
    canSave: false,
    url: '',
    savePath: '',
    ...partial
  }
}

function dragEvent(type: string, types: string[], relatedTarget: EventTarget | null = document.body): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'dataTransfer', { value: { types, files: [] } })
  // 真实拖拽中 relatedTarget 为 null 表示指针已经离开窗口
  Object.defineProperty(ev, 'relatedTarget', { value: relatedTarget })
  return ev
}

describe('界面渲染（App.vue）', () => {
  it('首屏渲染出品牌、连接面板、会话面板与日志区', () => {
    const el = mountApp()
    const text = el.textContent || ''
    expect(text).toContain('局域网直连')
    expect(text).toContain('建立连接')
    expect(text).toContain('生成邀请码')
    expect(text).toContain('完成连接')
    expect(text).toContain('通信与文件传输')
    expect(text).toContain('还没有建立连接')
    expect(text).toContain('运行日志')
  })

  it('初始状态显示“未连接”，断开按钮不可点', () => {
    const el = mountApp()
    expect(el.querySelector('.status-box')?.textContent).toContain('未连接')
    const disconnect = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === '断开')
    expect(disconnect).toBeTruthy()
    expect((disconnect as HTMLButtonElement).disabled).toBe(true)
  })

  it('可以切换到“我是接收方”并看到生成应答码流程', async () => {
    const el = mountApp()
    const tabs = Array.from(el.querySelectorAll<HTMLButtonElement>('.tab'))
    expect(tabs).toHaveLength(2)
    tabs[1].click()
    await Promise.resolve()
    expect(tabs[1].classList.contains('active')).toBe(true)
    expect(el.textContent).toContain('粘贴对方的邀请码')
    expect(el.textContent).toContain('生成应答码')
  })

  it('未连接时点“发送”只会提示，不会抛错', async () => {
    const el = mountApp()
    const textarea = el.querySelector('.composer textarea') as HTMLTextAreaElement
    textarea.value = '你好'
    textarea.dispatchEvent(new Event('input'))
    const sendBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === '发送') as HTMLButtonElement
    sendBtn.click()
    await new Promise((r) => setTimeout(r, 20))
    expect(el.querySelector('.toasts')?.textContent).toContain('尚未建立连接')
  })

  it('空信令码时点“完成连接”会给出可读错误而不是崩溃', async () => {
    const el = mountApp()
    const buttons = Array.from(el.querySelectorAll('button'))
    const apply = buttons.find((b) => b.textContent === '完成连接') as HTMLButtonElement
    apply.click()
    await new Promise((r) => setTimeout(r, 30))
    expect(el.querySelector('.connect-hint')?.textContent).toContain('请先粘贴')
  })

  it('点“设置”能打开设置弹窗（含保存方式与 STUN 选项）', async () => {
    const el = mountApp()
    const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === '设置') as HTMLButtonElement
    btn.click()
    await nextTick()
    const dialog = el.querySelector('dialog.settings') as HTMLDialogElement
    expect(dialog.hasAttribute('open')).toBe(true)
    const text = dialog.textContent || ''
    expect(text).toContain('我的昵称')
    expect(text).toContain('接收文件的保存方式')
    expect(text).toContain('STUN')
    // 关闭
    const closeBtn = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === '关闭') as HTMLButtonElement
    closeBtn.click()
    await nextTick()
    expect(dialog.hasAttribute('open')).toBe(false)
  })

  it('拖拽遮罩在 dragleave 不带 types 时也能正确关闭（防止遮罩卡死）', async () => {
    const el = mountApp()
    const overlay = () => el.querySelector('.drop-overlay') as HTMLElement
    window.dispatchEvent(dragEvent('dragenter', ['Files']))
    await nextTick()
    expect(overlay().classList.contains('active')).toBe(true)
    // 部分浏览器在 dragleave 时 types 是空的
    window.dispatchEvent(dragEvent('dragleave', []))
    await nextTick()
    expect(overlay().classList.contains('active')).toBe(false)
  })

  it('拖拽遮罩在多层 dragenter 后需要同样次数的 dragleave 才关闭', async () => {
    const el = mountApp()
    const overlay = () => el.querySelector('.drop-overlay') as HTMLElement
    window.dispatchEvent(dragEvent('dragenter', ['Files']))
    window.dispatchEvent(dragEvent('dragenter', ['Files']))
    await nextTick()
    window.dispatchEvent(dragEvent('dragleave', ['Files'], document.body))
    await nextTick()
    expect(overlay().classList.contains('active')).toBe(true)
    window.dispatchEvent(dragEvent('dragleave', ['Files'], document.body))
    await nextTick()
    expect(overlay().classList.contains('active')).toBe(false)
  })

  it('指针直接离开窗口时（relatedTarget 为 null）遮罩立刻关闭', async () => {
    const el = mountApp()
    const overlay = () => el.querySelector('.drop-overlay') as HTMLElement
    window.dispatchEvent(dragEvent('dragenter', ['Files']))
    window.dispatchEvent(dragEvent('dragenter', ['Files']))
    await nextTick()
    window.dispatchEvent(dragEvent('dragleave', [], null))
    await nextTick()
    expect(overlay().classList.contains('active')).toBe(false)
  })

  it('输入法组词时按回车（keyCode 229）不会误发送', async () => {
    const el = mountApp()
    const ta = el.querySelector('.composer textarea') as HTMLTextAreaElement
    ta.value = '你好'
    ta.dispatchEvent(new Event('input'))
    await nextTick()
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(enter, 'keyCode', { value: 229 })
    Object.defineProperty(enter, 'isComposing', { value: false })
    ta.dispatchEvent(enter)
    await new Promise((r) => setTimeout(r, 30))
    expect(el.querySelector('.toasts')?.textContent || '').not.toContain('尚未建立连接')
    expect(ta.value).toBe('你好')
  })

  it('“清空”会清掉消息与已结束的文件卡片，但保留进行中的传输', async () => {
    const el = mountApp()
    const { messages, transfers } = usePeer()
    messages.push({ id: 'm1', seq: 1, kind: 'me', text: '你好', ts: Date.now() })
    transfers.push(makeTransferView({ id: 'done-1', seq: 2, state: 'done' }))
    transfers.push(makeTransferView({ id: 'live-1', seq: 3, state: 'sending', canCancel: true, isDone: false }))
    await nextTick()
    expect(el.querySelectorAll('.msg').length).toBe(1)
    expect(el.querySelectorAll('.file-card').length).toBe(2)

    const clearBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === '清空') as HTMLButtonElement
    clearBtn.click()
    await nextTick()
    expect(el.querySelectorAll('.msg').length).toBe(0)
    expect(el.querySelectorAll('.file-card').length).toBe(1)
    expect(transfers[0].id).toBe('live-1')
  })
})

const distExists = existsSync(distHtml)

describe.skipIf(!distExists)('单文件构建产物（dist/index.html）', () => {
  it('产物结构满足 file:// 双击运行的要求', () => {
    const html = readFileSync(distHtml, 'utf8')
    // 必须是普通脚本：file:// 下 module script 会被 CORS 拦掉
    expect(html).not.toMatch(/<script[^>]+type=["']module["']/i)
    // 不能有任何外部资源引用，否则双击打开时会 404
    expect(html).not.toMatch(/<script[^>]+\ssrc=/)
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/)
    // 关键回归点：经典脚本是同步执行的，必须在挂载点之后
    expect(html.indexOf('<script')).toBeGreaterThan(html.indexOf('id="app"'))
    expect(html.indexOf('<script')).toBeLessThan(html.indexOf('</body>'))
    const code = html.match(/<script>([\s\S]*?)<\/script>/)![1]
    expect(code.length).toBeGreaterThan(10000)
    // 动态 import / import.meta 在 file:// 下同样会被拦掉
    expect(code).not.toMatch(/\bimport\s*\(/)
    expect(code).not.toMatch(/\bimport\.meta\b/)
  })

  it('忠实解析产物（不预置挂载点）也能真正渲染出界面', async () => {
    // 用 JSDOM 按浏览器的方式解析并执行内联脚本：
    // 不能再像之前那样先手工塞入 <div id="app"> 再 new Function 执行，
    // 那样会掩盖「脚本跑在挂载点之前」这类真实缺陷。
    const html = readFileSync(distHtml, 'utf8')
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'file:///F:/WodeCode/P2PFileUp/dist/index.html'
    })
    // DOMContentLoaded 之后才挂载，等一拍
    await new Promise((r) => setTimeout(r, 80))

    const app = dom.window.document.getElementById('app')
    expect(app).toBeTruthy()
    expect(app!.querySelectorAll('*').length).toBeGreaterThan(20)
    const text = app!.textContent || ''
    expect(text).toContain('局域网直连')
    expect(text).toContain('生成邀请码')
    expect(text).toContain('未连接')

    dom.window.close()
  })
})
