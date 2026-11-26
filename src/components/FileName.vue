<script setup lang="ts">
const props = defineProps<{ name: string; path: string }>();

function onClick(e: MouseEvent) {
  if (e.button !== 0) return;
  navigator.clipboard
    .writeText(props.path)
    .catch((err) => console.error("copy path failed:", err));
}
</script>

<template>
  <span class="file-name" @click="onClick">{{ name }}</span>
</template>

<style scoped>
.file-name {
  display: inline-block;
  white-space: pre;
  cursor: pointer;
}

.file-name:hover {
  background-color: rgba(128, 128, 128, 0.2);
}
</style>
