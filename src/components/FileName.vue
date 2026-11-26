<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

const props = defineProps<{ name: string; path: string }>();

const POPUP_MS = 2000;
const popup = ref<{ x: number; y: number } | null>(null);
let popupTimer: ReturnType<typeof setTimeout> | undefined;

function hidePopup() {
  clearTimeout(popupTimer);
  popup.value = null;
}

function onClick(e: MouseEvent) {
  if (e.button !== 0) return;
  navigator.clipboard
    .writeText(props.path)
    .catch((err) => console.error("copy path failed:", err));
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  hidePopup();
  popup.value = { x: rect.left + rect.width / 2, y: rect.top };
  popupTimer = setTimeout(hidePopup, POPUP_MS);
}

onBeforeUnmount(hidePopup);
</script>

<template>
  <span class="file-name" @click="onClick">{{ name }}</span>
  <Teleport to="body">
    <div
      v-if="popup"
      class="path-copied"
      role="status"
      :style="{ left: `${popup.x}px`, top: `${popup.y}px` }"
    >
      Path Copied!
    </div>
  </Teleport>
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

.path-copied {
  position: fixed;
  transform: translate(-50%, calc(-100% - 4px));
  z-index: 10;
  padding: 2px 8px;
  white-space: nowrap;
  font-size: 0.85em;
  color: #f6f6f6;
  background-color: #333;
  border-radius: 4px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  pointer-events: none;
}

@media (prefers-color-scheme: dark) {
  .path-copied {
    color: #0f0f0f;
    background-color: #f6f6f6;
  }
}
</style>
