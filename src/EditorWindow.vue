<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { FONT_FAMILY, FONT_SIZE } from "./fonts";
import {
  EDITOR_INIT,
  EDITOR_READY,
  EDITOR_RESULT,
  EDITOR_SAVE,
  type EditorInit,
  type EditorResult,
} from "./editor";

const label = new URLSearchParams(location.search).get("editor") ?? "";
const text = ref("");
const error = ref<string | null>(null);
const saving = ref(false);
const ready = ref(false);
const textarea = ref<HTMLTextAreaElement | null>(null);

let unlistens: UnlistenFn[] = [];

onMounted(async () => {
  const root = document.documentElement;
  root.style.setProperty("--app-font-family", FONT_FAMILY);
  root.style.setProperty("--app-font-size", FONT_SIZE);

  const self = getCurrentWebviewWindow();
  unlistens.push(
    await self.listen<EditorInit>(EDITOR_INIT, (e) => {
      text.value = e.payload.code;
      ready.value = true;
      textarea.value?.focus();
    }),
  );
  unlistens.push(
    await self.listen<EditorResult>(EDITOR_RESULT, (e) => {
      saving.value = false;
      if (e.payload.ok) {
        void getCurrentWindow().close();
      } else {
        error.value = e.payload.error;
      }
    }),
  );
  await emitTo("main", EDITOR_READY, { label });
});

onUnmounted(() => {
  unlistens.forEach((u) => u());
});

function cancel() {
  void getCurrentWindow().close();
}

function save() {
  if (!ready.value || saving.value) return;
  saving.value = true;
  error.value = null;
  void emitTo("main", EDITOR_SAVE, { label, code: text.value });
}

async function onKey(e: KeyboardEvent) {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const el = e.target as HTMLTextAreaElement;
  const s = el.selectionStart ?? 0;
  const t = el.selectionEnd ?? s;
  text.value = text.value.slice(0, s) + "  " + text.value.slice(t);
  await nextTick();
  el.selectionStart = el.selectionEnd = s + 2;
}
</script>

<template>
  <div class="editor-root">
    <div class="editor-bar">
      <button class="editor-button" @click="cancel">Cancel</button>
      <button class="editor-button" :disabled="!ready || saving" @click="save">
        Save
      </button>
    </div>
    <div v-if="error" class="editor-error" @click="error = null">{{ error }}</div>
    <textarea
      ref="textarea"
      v-model="text"
      class="editor-text"
      spellcheck="false"
      autocomplete="off"
      @keydown="onKey"
    ></textarea>
  </div>
</template>

<style>
html,
body,
#app {
  margin: 0;
  height: 100%;
  overflow: hidden;
}

body {
  font-family: var(--app-font-family, "Maple Mono NF"), monospace;
  font-size: var(--app-font-size, 14pt);
  color: #0f0f0f;
  background-color: #f6f6f6;
}

@media (prefers-color-scheme: dark) {
  body {
    color: #f6f6f6;
    background-color: #2f2f2f;
  }
}
</style>

<style scoped>
.editor-root {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.editor-bar {
  flex: none;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 8px;
  border-bottom: 1px solid #888;
}
.editor-button {
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  padding: 4px 8px;
  cursor: pointer;
}
.editor-button:hover {
  opacity: 0.7;
}
.editor-button:disabled {
  opacity: 0.4;
  cursor: default;
}
.editor-error {
  flex: none;
  cursor: pointer;
  color: #c0392b;
  white-space: pre-wrap;
  padding: 4px 8px;
  border-bottom: 1px solid #888;
}
.editor-text {
  flex: 1;
  min-height: 0;
  resize: none;
  border: none;
  outline: none;
  padding: 4px 8px;
  font: inherit;
  color: inherit;
  background: transparent;
  white-space: pre;
}
@media (prefers-color-scheme: dark) {
  .editor-bar,
  .editor-error {
    border-bottom-color: #777;
  }
  .editor-error {
    color: #ff7b72;
  }
}
</style>
