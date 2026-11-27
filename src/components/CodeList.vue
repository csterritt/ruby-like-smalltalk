<script setup lang="ts">
import { previewLines, type PaneEntry } from "../snapshot";

defineProps<{ entries: PaneEntry[] }>();
const emit = defineEmits<{
  restore: [PaneEntry];
  menu: [PaneEntry, MouseEvent];
}>();

function onDblClick(entry: PaneEntry) {
  if (!entry.stale) return;
  window.getSelection()?.removeAllRanges();
  emit("restore", entry);
}
</script>

<template>
  <div class="code-list">
    <div
      v-for="entry in entries"
      :key="entry.name"
      class="code-entry"
      :class="{ stale: entry.stale }"
      @dblclick="onDblClick(entry)"
      @contextmenu.prevent="emit('menu', entry, $event)"
    >
      <div
        v-for="(line, i) in previewLines(entry.text)"
        :key="i"
        class="code-line"
      >{{ line || " " }}</div>
    </div>
  </div>
</template>

<style scoped>
.code-entry + .code-entry {
  margin-top: 6px;
}
.code-line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre;
  min-height: 1em;
}
.code-entry.stale {
  background-color: #d4d4d4;
}
@media (prefers-color-scheme: dark) {
  .code-entry.stale {
    background-color: #4a4a4a;
  }
}
</style>
