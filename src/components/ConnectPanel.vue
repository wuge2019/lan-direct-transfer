<script setup lang="ts">
import { ref } from 'vue'
import { usePeer } from '../composables/usePeer'
import { useToast } from '../composables/useToast'
import { useLog } from '../composables/useLog'
import { copyText } from '../lib/utils'

const {
  inviteCode,
  answerOut,
  pairingHint,
  bcSupported,
  handshakeBusy,
  createInvite,
  createAnswerFromOffer,
  applyAnswerCode,
  startLocalPairing,
  disconnect
} = usePeer()
const { showToast } = useToast()
const { addLog } = useLog()

const tab = ref<'create' | 'join'>('create')
const offerInput = ref('')
const answerInput = ref('')
const hint = ref('')
const okHint = ref(false)

function setHint(text: string, ok = false): void {
  hint.value = text
  okHint.value = ok
}

/** 握手期间不允许切标签页，否则另一个标签页的按钮会作废正在生成的连接 */
function switchTab(next: 'create' | 'join'): void {
  if (handshakeBusy.value) {
    showToast('正在生成 / 应用信令码，请稍候再切换…', 'warn')
    return
  }
  tab.value = next
}

function fail(prefix: string, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e)
  setHint(`${prefix}：${message}`)
  showToast(`${prefix}：${message}`, 'err')
  addLog(`${prefix}：${message}`, 'error')
}

async function onGenerateInvite(): Promise<void> {
  okHint.value = false
  try {
    const code = await createInvite()
    setHint(`邀请码已生成（${code.length} 字符）。把它发给对方，然后把对方回传的应答码粘贴到第 2 步。`)
  } catch (e) {
    fail('生成邀请码失败', e)
  }
}

async function onApplyAnswer(): Promise<void> {
  okHint.value = false
  try {
    await applyAnswerCode(answerInput.value)
    setHint('应答码已应用，正在建立直连，请稍候…')
  } catch (e) {
    fail('连接失败', e)
  }
}

async function onGenerateAnswer(): Promise<void> {
  okHint.value = false
  try {
    const code = await createAnswerFromOffer(offerInput.value)
    setHint(`应答码已生成（${code.length} 字符）。把它发回给发起方，对方点“完成连接”后即建立直连。`)
  } catch (e) {
    fail('生成应答码失败', e)
  }
}

async function onLocalPairing(role: 'host' | 'guest'): Promise<void> {
  try {
    await startLocalPairing(role)
  } catch (e) {
    fail('本机配对失败', e)
  }
}

async function copyCode(text: string, okMessage: string): Promise<void> {
  if (!text) {
    showToast('还没有内容可复制', 'warn')
    return
  }
  try {
    await copyText(text)
    showToast(okMessage, 'ok')
  } catch {
    showToast('自动复制失败，请手动选中内容后按 Ctrl+C', 'warn')
  }
}

function onReset(): void {
  answerInput.value = ''
  offerInput.value = ''
  setHint('')
  disconnect()
}
</script>

<template>
  <section class="panel connect-panel">
    <div class="panel-head">
      <h2>建立连接</h2>
      <span class="pill">无服务器 · 局域网直连</span>
    </div>

    <div class="tabs" role="group" aria-label="连接角色">
      <button
        class="tab"
        :class="{ active: tab === 'create' }"
        :aria-pressed="tab === 'create'"
        @click="switchTab('create')"
      >我是发起方（A）</button>
      <button
        class="tab"
        :class="{ active: tab === 'join' }"
        :aria-pressed="tab === 'join'"
        @click="switchTab('join')"
      >我是接收方（B）</button>
    </div>

    <!-- 发起方 -->
    <div v-show="tab === 'create'">
      <ol class="steps">
        <li>
          <div class="step-head"><span class="step-no">1</span><span>生成邀请码</span></div>
          <p class="hint">点击下面按钮生成邀请码，再用任意方式发给对方（微信 / QQ / 邮件 / 共享文件夹都可以）。</p>
          <div class="row">
            <button class="btn btn-primary" :disabled="handshakeBusy" @click="onGenerateInvite">生成邀请码</button>
            <button
              class="btn btn-ghost"
              :disabled="!inviteCode"
              @click="copyCode(inviteCode, '邀请码已复制，发给对方即可')"
            >复制</button>
          </div>
          <textarea
            class="code-box"
            rows="4"
            readonly
            :value="inviteCode"
            aria-label="邀请码（生成后发给对方）"
            placeholder="尚未生成……"
          ></textarea>
        </li>
        <li>
          <div class="step-head"><span class="step-no">2</span><span>粘贴对方的应答码</span></div>
          <p class="hint">对方点“生成应答码”后，把他得到的应答码粘贴到下面。</p>
          <textarea
            v-model="answerInput"
            class="code-box"
            rows="4"
            aria-label="粘贴对方发来的应答码"
            placeholder="在此粘贴应答码（P2P1- 开头，可含换行）"
          ></textarea>
          <div class="row">
            <button class="btn btn-primary" :disabled="handshakeBusy" @click="onApplyAnswer">完成连接</button>
            <button class="btn btn-ghost" @click="onReset">重置</button>
          </div>
        </li>
      </ol>
    </div>

    <!-- 接收方 -->
    <div v-show="tab === 'join'">
      <ol class="steps">
        <li>
          <div class="step-head"><span class="step-no">1</span><span>粘贴对方的邀请码</span></div>
          <p class="hint">把发起方发来的邀请码粘贴到下面。</p>
          <textarea
            v-model="offerInput"
            class="code-box"
            rows="4"
            aria-label="粘贴对方发来的邀请码"
            placeholder="在此粘贴邀请码（P2P1- 开头，可含换行）"
          ></textarea>
          <div class="row">
            <button class="btn btn-primary" :disabled="handshakeBusy" @click="onGenerateAnswer">生成应答码</button>
            <button class="btn btn-ghost" @click="onReset">重置</button>
          </div>
        </li>
        <li>
          <div class="step-head"><span class="step-no">2</span><span>把应答码发回给对方</span></div>
          <p class="hint">对方粘贴并点“完成连接”后，双方即建立直连。</p>
          <div class="row">
            <button
              class="btn btn-ghost"
              :disabled="!answerOut"
              @click="copyCode(answerOut, '应答码已复制，发回给对方即可')"
            >复制</button>
          </div>
          <textarea
            class="code-box"
            rows="4"
            readonly
            :value="answerOut"
            aria-label="应答码（生成后发回给发起方）"
            placeholder="尚未生成……"
          ></textarea>
        </li>
      </ol>
    </div>

    <!-- 本机自测 -->
    <div class="local-pair">
      <div class="local-pair-head">
        <span class="tag">本机自测</span>
        <span class="hint">同一台电脑开两个标签页时，用它免复制粘贴自动配对。</span>
      </div>
      <div class="row">
        <button
          class="btn btn-ghost"
          :disabled="!bcSupported || handshakeBusy"
          @click="onLocalPairing('host')"
        >本机配对（主叫）</button>
        <button
          class="btn btn-ghost"
          :disabled="!bcSupported || handshakeBusy"
          @click="onLocalPairing('guest')"
        >本机配对（被叫）</button>
      </div>
      <p v-if="pairingHint" class="hint">{{ pairingHint }}</p>
    </div>

    <p class="connect-hint" :class="{ ok: okHint }">{{ hint }}</p>
  </section>
</template>
