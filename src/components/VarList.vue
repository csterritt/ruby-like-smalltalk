<script setup lang="ts">
import { ref } from "vue";
import type { PaneEntry } from "../snapshot";

defineProps<{ entries: PaneEntry[] }>();
const emit = defineEmits<{
  restore: [PaneEntry];
  menu: [PaneEntry, MouseEvent];
}>();

const charMeasure = ref<HTMLElement | null>(null);

function onKey(e: KeyboardEvent) {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const el = e.currentTarget as HTMLElement;
  const charW = charMeasure.value?.getBoundingClientRect().width || 8;
  el.scrollLeft += e.key === "ArrowRight" ? charW : -charW;
}

function onDblClick(entry: PaneEntry) {
  if (!entry.stale) return;
  window.getSelection()?.removeAllRanges();
  emit("restore", entry);
}
</script>

<template>
  <div class="var-list">
    <span ref="charMeasure" class="char-measure" aria-hidden="true">0</span>
    <div
      v-for="entry in entries"
      :key="entry.name"
      class="var-row"
      :class="{ stale: entry.stale }"
      tabindex="0"
      @keydown="onKey"
      @dblclick="onDblClick(entry)"
      @contextmenu.prevent="emit('menu', entry, $event)"
    >{{ entry.name }} = {{ entry.text }}</div>
  </div>
</template>

<style scoped>
.var-list {
  position: relative;
}
.char-measure {
  position: absolute;
  visibility: hidden;
  white-space: pre;
  pointer-events: none;
}
.var-row {
  white-space: pre;
  overflow-x: auto;
  scrollbar-width: none;
  min-height: 1em;
}
.var-row::-webkit-scrollbar {
  display: none;
}
.var-row:focus {
  outline: 1px solid #888;
  outline-offset: -1px;
}
.var-row.stale {
  background-color: #d4d4d4;
}
@media (prefers-color-scheme: dark) {
  .var-row.stale {
    background-color: #4a4a4a;
  }
}
</style>
