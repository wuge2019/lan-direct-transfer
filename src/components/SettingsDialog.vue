<script setup lang="ts">
import { ref, watch } from 'vue'
import { useSettings } from '../composables/useSettings'
import { useDiscovery } from '../composables/useDiscovery'

const {
  settings,
  dialogOpen,
  dirHandle,
  dirStatus,
  supportsFileSystemAccess,
  supportsDirectoryPicker,
  saveSettings,
  closeSettings,
  chooseDirectory,
  clearDirectory
} = useSettings()
const { rename, refresh } = useDiscovery()

const dialogEl = ref<HTMLDialogElement | null>(null)

watch(dialogOpen, (open) => {
  const el = dialogEl.value
  if (!el) return
  // 极少数环境（如 jsdom、老浏览器）没有 showModal/close，做一次兜底
  const canModal = typeof el.showModal === 'function'
  const canClose = typeof el.close === 'function'
  if (open) {
    if (!el.open) {
      if (canModal) el.showModal()
      else el.setAttribute('open', '')
    }
  } else if (el.open) {
    if (canClose) el.close()
    else el.removeAttribute('open')
  }
})

function onSave(): void {
  saveSettings()
  rename(settings.name)
  // 服务地址可能改了，重新探测一次（没改也会很快重连）
  void refresh()
  closeSettings()
}
</script>

<template>
  <dialog ref="dialogEl" class="settings" @close="closeSettings">
    <div class="settings-body">
      <h3>设置</h3>

      <label class="field">
        <span>我的昵称</span>
        <input v-model="settings.name" type="text" maxlength="24" placeholder="例如：小明" />
      </label>

      <label class="field">
        <span>发现服务地址（留空 = 使用当前站点）</span>
        <input
          v-model="settings.serverUrl"
          type="text"
          placeholder="例如：192.168.1.5:8080；单文件版填这里才能自动发现用户"
        />
      </label>

      <label class="field">
        <span>接收文件的保存方式</span>
        <select v-model="settings.saveMode">
          <option value="ask" :disabled="!supportsFileSystemAccess()">
            每个文件都询问保存位置（推荐，支持大文件流式写盘）
          </option>
          <option value="dir">保存到我选定的文件夹（需先选择文件夹）</option>
          <option value="download">浏览器下载（内存接收，兼容性最好，超大文件慎用）</option>
        </select>
      </label>

      <div class="field">
        <span>固定保存文件夹</span>
        <div class="row">
          <button type="button" class="btn btn-ghost" :disabled="!supportsDirectoryPicker()" @click="chooseDirectory">
            选择文件夹
          </button>
          <button type="button" class="btn btn-ghost" :disabled="!dirHandle" @click="clearDirectory">清除</button>
        </div>
        <p class="hint">{{ dirStatus }}</p>
      </div>

      <label class="field checkbox">
        <input v-model="settings.autoAccept" type="checkbox" />
        <span>自动接受对方发来的文件（仅在使用“浏览器下载”或已选定文件夹时生效）</span>
      </label>

      <label class="field checkbox">
        <input v-model="settings.stun" type="checkbox" />
        <span>使用公网 STUN 服务器穿透（跨网段 / 复杂网络时可用，需要联网）</span>
      </label>

      <label class="field">
        <span>STUN 地址</span>
        <input v-model="settings.stunUrl" type="text" placeholder="stun:stun.l.google.com:19302" />
      </label>

      <p class="hint">
        提示：由 <code>pnpm lan</code>（server/index.mjs）托管的页面会自动发现局域网内的其他用户，
        点选即可请求连接，对方同意后建立直连。文件与聊天内容始终走点对点，不经过服务器。
      </p>

      <div class="settings-foot">
        <button type="button" class="btn btn-ghost" @click="closeSettings">关闭</button>
        <button type="button" class="btn btn-primary" @click="onSave">保存</button>
      </div>
    </div>
  </dialog>
</template>
