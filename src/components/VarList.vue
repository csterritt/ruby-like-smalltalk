<script setup lang="ts">
import { ref } from "vue";
import type { Entry } from "../snapshot";

defineProps<{ entries: Entry[] }>();

const charMeasure = ref<HTMLElement | null>(null);

function onKey(e: KeyboardEvent) {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const el = e.currentTarget as HTMLElement;
  const charW = charMeasure.value?.getBoundingClientRect().width || 8;
  el.scrollLeft += e.key === "ArrowRight" ? charW : -charW;
}
</script>

<template>
  <div class="var-list">
    <span ref="charMeasure" class="char-measure" aria-hidden="true">0</span>
    <div
      v-for="entry in entries"
      :key="entry.name"
      class="var-row"
      tabindex="0"
      @keydown="onKey"
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
  outline: none;
  background-color: rgba(128, 128, 128, 0.2);
}
</style>
