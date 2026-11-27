<script setup lang="ts">
import { previewLines, type Entry } from "../snapshot";

defineProps<{ entries: Entry[] }>();
</script>

<template>
  <div class="code-list">
    <div v-for="entry in entries" :key="entry.name" class="code-entry">
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
</style>
