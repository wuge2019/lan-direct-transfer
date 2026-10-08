<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TransferView } from '../lib/types'
import { usePeer } from '../composables/usePeer'
import { useToast } from '../composables/useToast'

const props = defineProps<{ view: TransferView }>()
const { acceptTransfer, rejectTransfer, cancelTransfer } = usePeer()
const { showToast } = useToast()

/** 选择保存位置可能较慢，防止连点弹出多个对话框 */
const accepting = ref(false)

const cardClass = computed(() => ({
  'file-card': true,
  in: props.view.dir === 'in',
  out: props.view.dir === 'out',
  done: props.view.state === 'done',
  fail: props.view.isFailed
}))

const showActions = computed(
  () => props.view.canAccept || props.view.canReject || props.view.canCancel || props.view.canSave
)

async function onAccept(): Promise<void> {
  if (accepting.value) return
  accepting.value = true
  try {
    await acceptTransfer(props.view.id)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      showToast('已取消保存位置选择')
      return
    }
    showToast(`接收失败：${e instanceof Error ? e.message : String(e)}`, 'err')
  } finally {
    accepting.value = false
  }
}
</script>

<template>
  <div :class="cardClass" :data-id="view.id">
    <div class="fc-head">
      <span class="fc-icon">{{ view.dir === 'out' ? '📤' : '📥' }}</span>
      <span class="fc-name" :title="view.name">{{ view.name }}</span>
      <span class="fc-size">{{ view.sizeText }}</span>
    </div>

    <div class="fc-bar"><i :style="{ width: `${view.percent}%` }"></i></div>

    <div class="fc-foot">
      <span class="fc-state" :class="view.tone">{{ view.stateText }}</span>
      <span class="grow"></span>
      <span>{{ view.speedText }}</span>
    </div>

    <div v-if="showActions" class="fc-actions">
      <button v-if="view.canAccept" class="btn btn-primary small" :disabled="accepting" @click="onAccept">
        {{ accepting ? '等待选择…' : '接受并保存' }}
      </button>
      <button v-if="view.canReject" class="btn btn-ghost small" @click="rejectTransfer(view.id)">拒绝</button>
      <button v-if="view.canCancel" class="btn btn-ghost small" @click="cancelTransfer(view.id)">取消</button>
      <a v-if="view.canSave" class="btn btn-ghost small" :href="view.url" :download="view.name">保存 / 打开</a>
    </div>
  </div>
</template>
