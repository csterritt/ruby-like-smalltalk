<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

const props = defineProps<{
  name: string;
  path: string;
  open?: (path: string) => Promise<void>;
}>();

const POPUP_MS = 2000;
const popup = ref<{
  x: number;
  y: number;
  message: string;
  kind: "info" | "error";
} | null>(null);
let popupTimer: ReturnType<typeof setTimeout> | undefined;

function hidePopup() {
  clearTimeout(popupTimer);
  popup.value = null;
}

function showPopup(rect: DOMRect, message: string, kind: "info" | "error") {
  hidePopup();
  popup.value = {
    x: rect.left + rect.width / 2,
    y: rect.top,
    message,
    kind,
  };
  popupTimer = setTimeout(hidePopup, POPUP_MS);
}

function onClick(e: MouseEvent) {
  if (e.button !== 0) return;
  navigator.clipboard
    .writeText(props.path)
    .catch((err) => console.error("copy path failed:", err));
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showPopup(rect, "Path Copied!", "info");
}

async function onDblClick(e: MouseEvent) {
  if (e.button !== 0 || !props.open) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  try {
    await props.open(props.path);
  } catch (err) {
    showPopup(rect, String(err), "error");
  }
}

onBeforeUnmount(hidePopup);
</script>

<template>
  <span class="file-name" @click="onClick" @dblclick="onDblClick">{{ name }}</span>
  <Teleport to="body">
    <div
      v-if="popup"
      class="path-copied"
      :class="{ error: popup.kind === 'error' }"
      role="status"
      :style="{ left: `${popup.x}px`, top: `${popup.y}px` }"
    >
      {{ popup.message }}
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

.path-copied.error {
  color: #fff;
  background-color: #b3261e;
}

@media (prefers-color-scheme: dark) {
  .path-copied {
    color: #0f0f0f;
    background-color: #f6f6f6;
  }

  .path-copied.error {
    color: #fff;
    background-color: #b3261e;
  }
}
</style>
