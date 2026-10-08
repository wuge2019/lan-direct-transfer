<script setup lang="ts">
import { useLog } from '../composables/useLog'

const { logText } = useLog()
</script>

<template>
  <section class="panel log-panel">
    <details>
      <summary>运行日志（排查问题用）</summary>
      <pre>{{ logText }}</pre>
    </details>
  </section>
</template>
