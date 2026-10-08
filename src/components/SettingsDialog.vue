<script setup lang="ts">
import { ref, watch } from 'vue'
import { useSettings } from '../composables/useSettings'

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
        提示：默认不配置任何外部服务器，双方在同一局域网内即可直连；文件通过 DataChannel 点对点传输，
        不落地到任何第三方。
      </p>

      <div class="settings-foot">
        <button type="button" class="btn btn-ghost" @click="closeSettings">关闭</button>
        <button type="button" class="btn btn-primary" @click="onSave">保存</button>
      </div>
    </div>
  </dialog>
</template>
