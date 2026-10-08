<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import MessageItem from './MessageItem.vue'
import FileCard from './FileCard.vue'
import { usePeer } from '../composables/usePeer'
import type { ChatMessage, TransferView } from '../lib/types'

const { messages, transfers, sendChat, sendFiles, peerName } = usePeer()

const chatInput = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const messagesEl = ref<HTMLElement | null>(null)
const tip = ref('可同时选择多个文件，将按顺序逐个传输。')

type TimelineItem =
  | { type: 'msg'; seq: number; msg: ChatMessage }
  | { type: 'file'; seq: number; view: TransferView }

/** 把消息与文件卡片按发生顺序合成一条时间线 */
const timeline = computed<TimelineItem[]>(() => {
  const items: TimelineItem[] = [
    ...messages.map((msg) => ({ type: 'msg' as const, seq: msg.seq, msg })),
    ...transfers.map((view) => ({ type: 'file' as const, seq: view.seq, view }))
  ]
  return items.sort((a, b) => a.seq - b.seq)
})

const isEmpty = computed(() => timeline.value.length === 0)

function nearBottom(): boolean {
  const el = messagesEl.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 140
}

function scrollToBottom(force = false): void {
  const el = messagesEl.value
  if (!el) return
  if (force || nearBottom()) el.scrollTop = el.scrollHeight
}

watch(
  () => timeline.value.length,
  () => {
    void nextTick(() => scrollToBottom())
  }
)

function autoGrow(): void {
  const el = textareaEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`
}

function onSend(): void {
  if (sendChat(chatInput.value)) {
    chatInput.value = ''
    void nextTick(autoGrow)
  }
}

function onKeydown(e: KeyboardEvent): void {
  // keyCode 229 表示输入法正在组词，此时回车是在确认候选词，不能当发送
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault()
    onSend()
  }
}

function onPickFiles(): void {
  fileInput.value?.click()
}

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement
  if (input.files && input.files.length) {
    sendFiles(input.files)
    tip.value = `已加入 ${input.files.length} 个文件，将按顺序传输。`
    window.setTimeout(() => (tip.value = '可同时选择多个文件，将按顺序逐个传输。'), 6000)
  }
  input.value = ''
}

function onPaste(e: ClipboardEvent): void {
  const files = e.clipboardData?.files
  if (files && files.length) {
    e.preventDefault()
    sendFiles(files)
  }
}
</script>

<template>
  <section class="panel session-panel">
    <div class="panel-head">
      <h2>通信与文件传输</h2>
      <span class="pill">对方：{{ peerName || '未连接' }}</span>
    </div>

    <div ref="messagesEl" class="messages">
      <div v-if="isEmpty" class="empty-state">
        <div class="empty-icon">⇅</div>
        <p>还没有建立连接。</p>
        <p class="hint">
          连接成功后，这里可以实时聊天、拖入文件即时传送（点对点直传，不经过任何服务器）。
        </p>
      </div>

      <template v-for="item in timeline" :key="item.seq">
        <MessageItem v-if="item.type === 'msg'" :msg="item.msg" />
        <FileCard v-else :view="item.view" />
      </template>
    </div>

    <div class="composer">
      <div class="composer-row">
        <button class="btn btn-ghost icon-btn" title="选择文件发送" @click="onPickFiles">📎 文件</button>
        <input ref="fileInput" type="file" multiple hidden @change="onFileChange" />
        <textarea
          ref="textareaEl"
          v-model="chatInput"
          rows="1"
          placeholder="输入消息，回车发送（Shift+回车换行）；也可以把文件直接拖到窗口任意位置"
          @keydown="onKeydown"
          @input="autoGrow"
          @paste="onPaste"
        ></textarea>
        <button class="btn btn-primary" @click="onSend">发送</button>
      </div>
      <div class="composer-tip">{{ tip }}</div>
    </div>
  </section>
</template>
