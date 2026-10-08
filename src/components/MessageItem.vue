<script setup lang="ts">
import { computed } from 'vue'
import type { ChatMessage } from '../lib/types'
import { formatTime } from '../lib/utils'
import { usePeer } from '../composables/usePeer'

const props = defineProps<{ msg: ChatMessage }>()
const { peerName } = usePeer()

const meta = computed(() => {
  const time = formatTime(props.msg.ts)
  if (props.msg.kind === 'me') return `${time} · 我`
  if (props.msg.kind === 'peer') return `${time} · ${peerName.value || '对方'}`
  return time
})
</script>

<template>
  <div class="msg" :class="msg.kind">
    <div class="bubble">{{ msg.text }}</div>
    <div class="meta">{{ meta }}</div>
  </div>
</template>
