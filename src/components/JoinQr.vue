<script setup lang="ts">
import { computed } from 'vue'
import qrcode from 'qrcode-generator'

const props = defineProps<{ url: string }>()

const dataUrl = computed(() => {
  const value = String(props.url || '').trim()
  if (!value) return ''
  try {
    const qr = qrcode(0, 'M')
    qr.addData(value)
    qr.make()
    return qr.createDataURL(4, 8)
  } catch {
    return ''
  }
})
</script>

<template>
  <div class="qr-box">
    <img v-if="dataUrl" class="qr-image" :src="dataUrl" :alt="`加入地址二维码：${url}`" />
    <p v-else class="hint">地址过长，无法生成二维码，请直接复制下面的链接。</p>
    <p class="qr-url">{{ url }}</p>
  </div>
</template>
