<script setup lang="ts">
import { useToast } from '../composables/useToast'

const { toasts } = useToast()
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <div v-for="item in toasts" :key="item.id" class="toast" :class="item.type">{{ item.text }}</div>
  </div>
</template>
