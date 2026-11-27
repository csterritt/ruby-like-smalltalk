<script setup lang="ts">
import {
  nextTick,
  onBeforeUnmount,
  onBeforeUpdate,
  onMounted,
  onUpdated,
  reactive,
  ref,
  watch,
} from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ConsoleModel,
  initialState,
  selectedLines,
  type Backend,
  type Item,
  type RubyEvent,
  type SubmitResult,
} from "../console";
import type { PaneEntry, Panes } from "../snapshot";

const props = defineProps<{ suspended: boolean }>();
const emit = defineEmits<{ panes: [Panes]; "edit-lines": [string] }>();

const backend: Backend = {
  check: (code) => invoke<boolean>("ruby_check", { code }),
  eval: (code) => invoke<number>("ruby_eval", { code }),
  stdin: (text) => invoke<void>("ruby_stdin", { text }),
  interrupt: () => invoke<"idle" | "interrupt" | "kill">("ruby_interrupt"),
};

const state = reactive(initialState());
const model = new ConsoleModel(backend, state);

watch(
  () => state.panes,
  (p) => emit("panes", p),
);

const rootEl = ref<HTMLDivElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
const busyLong = ref(false);
let busyTimer: ReturnType<typeof setTimeout> | undefined;


watch(
  () => state.mode,
  (mode) => {
    if (mode === "busy") {
      busyTimer = setTimeout(() => {
        busyLong.value = true;
      }, 500);
    } else {
      clearTimeout(busyTimer);
      busyTimer = undefined;
      busyLong.value = false;
    }
  },
);

const sel = ref<{ anchor: number; focus: number } | null>(null);
const selMenu = ref<{ x: number; y: number; text: string } | null>(null);
const selMenuEl = ref<HTMLElement | null>(null);
let selDragging = false;

function isSelected(i: number): boolean {
  const s = sel.value;
  return s !== null && i >= Math.min(s.anchor, s.focus) && i <= Math.max(s.anchor, s.focus);
}

function clearSel() {
  sel.value = null;
  selMenu.value = null;
  selDragging = false;
}

function onItemMouseDown(i: number, e: MouseEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  sel.value = { anchor: i, focus: i };
  selDragging = true;
  selMenu.value = null;
}

function onDocMouseMove(e: MouseEvent) {
  if (!selDragging || !sel.value) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const row = el?.closest?.("[data-item]") as HTMLElement | null;
  if (!row) return;
  const idx = Number(row.dataset.item);
  if (Number.isInteger(idx)) sel.value = { ...sel.value, focus: idx };
}

async function onDocMouseUp(e: MouseEvent) {
  if (!selDragging) return;
  selDragging = false;
  const s = sel.value;
  if (!s) return;
  const text = selectedLines(state.items, s.anchor, s.focus);
  if (!text) {
    sel.value = null;
    return;
  }
  selMenu.value = { x: e.clientX, y: e.clientY, text };
  await nextTick();
  const el = selMenuEl.value;
  const m = selMenu.value;
  if (!el || !m) return;
  const r = el.getBoundingClientRect();
  selMenu.value = {
    ...m,
    x: Math.max(0, Math.min(m.x, window.innerWidth - r.width)),
    y: Math.max(0, Math.min(m.y, window.innerHeight - r.height)),
  };
}

function onDocPointerDown(e: PointerEvent) {
  if (selMenu.value && !selMenuEl.value?.contains(e.target as Node)) {
    clearSel();
  }
}

function onDocKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") clearSel();
}

function copySel() {
  const m = selMenu.value;
  clearSel();
  if (!m) return;
  writeText(m.text).catch((err) => console.error("copy lines failed:", err));
}

function editSel() {
  const m = selMenu.value;
  clearSel();
  if (!m) return;
  emit("edit-lines", m.text);
}

const caret = { start: -1, end: -1, line: "" };

function trackCaret() {
  const el = inputEl.value;
  if (!el) return;
  caret.start = el.selectionStart ?? -1;
  caret.end = el.selectionEnd ?? caret.start;
  caret.line = el.value;
}

async function insertText(text: string): Promise<SubmitResult> {
  const same = caret.line === state.line && caret.start >= 0;
  const s = same ? caret.start : state.line.length;
  const e = same ? caret.end : s;
  const r = await model.insertAtPrompt(text, s, e);
  focus();
  if (r.ok && !text.includes("\n")) {
    await nextTick();
    const pos = s + text.length;
    inputEl.value?.setSelectionRange(pos, pos);
  }
  return r;
}

let unlisten: UnlistenFn | undefined;
const queue: RubyEvent[] = [];
let rafId = 0;

function pump() {
  rafId = 0;
  const batch = queue.splice(0, queue.length);
  for (const ev of batch) model.onEvent(ev);
}

onMounted(async () => {
  document.addEventListener("mousemove", onDocMouseMove);
  document.addEventListener("mouseup", onDocMouseUp);
  document.addEventListener("pointerdown", onDocPointerDown);
  document.addEventListener("keydown", onDocKeyDown);
  unlisten = await listen<RubyEvent>("ruby-event", (e) => {
    queue.push(e.payload);
    if (!rafId) rafId = requestAnimationFrame(pump);
  });
  const status = await invoke<{ ready: boolean; version?: string; error?: string }>(
    "ruby_status",
  );
  if (status.ready && state.mode === "starting") {
    model.onEvent({ type: "started", generation: 1, version: status.version ?? "" });
  } else if (!status.ready) {
    model.onEvent({ type: "unavailable", message: status.error ?? "unknown error" });
  }
  focus();
});

onBeforeUnmount(() => {
  document.removeEventListener("mousemove", onDocMouseMove);
  document.removeEventListener("mouseup", onDocMouseUp);
  document.removeEventListener("pointerdown", onDocPointerDown);
  document.removeEventListener("keydown", onDocKeyDown);
  unlisten?.();
  if (rafId) cancelAnimationFrame(rafId);
  clearTimeout(busyTimer);
});

watch(
  () => props.suspended,
  (s) => {
    if (!s) focus();
  },
);

let wasAtBottom = true;
onBeforeUpdate(() => {
  const el = rootEl.value;
  wasAtBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight <= 30;
});
onUpdated(() => {
  const el = rootEl.value;
  if (el && wasAtBottom) el.scrollTop = el.scrollHeight;
});

function focus() {
  inputEl.value?.focus();
}

function onPaneClick() {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  focus();
}

function onInput(e: Event) {
  model.setLine((e.target as HTMLInputElement).value);
}

async function onKey(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    void model.enter();
    return;
  }
  if (e.ctrlKey && !e.metaKey && (e.key === "c" || e.key === "C")) {
    e.preventDefault();
    void model.ctrlC();
    return;
  }
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    if (props.suspended) return; // let the document handler scroll the file
    e.preventDefault();
    if (e.key === "ArrowUp") model.historyPrev();
    else model.historyNext();
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    const el = e.target as HTMLInputElement;
    const { selectionStart: s = 0, selectionEnd: t = 0, value } = el;
    const next = value.slice(0, s ?? 0) + "  " + value.slice(t ?? 0);
    model.setLine(next);
    await nextTick();
    el.selectionStart = el.selectionEnd = (s ?? 0) + 2;
  }
}

function onPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData("text") ?? "";
  if (!text.includes("\n") && !text.includes("\r")) return;
  e.preventDefault();
  const el = e.target as HTMLInputElement;
  const s = el.selectionStart ?? el.value.length;
  const t = el.selectionEnd ?? el.value.length;
  void model.paste(el.value.slice(0, s), text, el.value.slice(t));
}

function itemText(item: Item): string {
  return "text" in item ? item.text : "";
}

function noticeTone(item: Item): string {
  return "tone" in item ? item.tone : "info";
}

const BT_MAX = 8;

defineExpose({
  ctrlC: () => model.ctrlC(),
  focus,
  restore: (e: PaneEntry) => model.restore(e),
  remove: (area: keyof Panes, e: PaneEntry) => model.remove(area, e),
  submit: (code: string) => model.submit(code),
  insert: (text: string) => insertText(text),
});
</script>

<template>
  <div ref="rootEl" class="ruby-console" @click="onPaneClick">
    <div class="items">
      <template v-for="(item, i) in state.items" :key="i">
        <div
          v-if="item.kind === 'input'"
          class="row input"
          :data-item="i"
          @mousedown="onItemMouseDown(i, $event)"
        >
          <span class="prompt">{{ item.prompt }}</span><span
            class="text"
            :class="{ selected: isSelected(i) }"
            >{{ item.text }}</span
          ><span v-if="item.cancelled" class="cancelled">^C</span>
        </div>
        <div v-else-if="item.kind === 'stdin'" class="row stdin">{{ item.text }}</div>
        <div v-else-if="item.kind === 'stdout'" class="row stdout">{{ item.text }}</div>
        <div v-else-if="item.kind === 'stderr'" class="row stderr">{{ item.text }}</div>
        <div v-else-if="item.kind === 'value'" class="row value">=> {{ item.text }}</div>
        <div v-else-if="item.kind === 'error'" class="row error">
          <template v-if="item.syntax">
            <div v-for="(l, j) in item.message.split('\n')" :key="j">{{ l }}</div>
          </template>
          <div v-else>
            <span class="err-cls">{{ item.cls }}</span
            ><template v-if="item.message">: {{ item.message }}</template>
          </div>
          <div
            v-for="(f, j) in item.backtrace.slice(0, BT_MAX)"
            :key="`bt${j}`"
            class="bt"
          >
            {{ "  from " + f }}
          </div>
          <div v-if="item.backtrace.length > BT_MAX" class="bt">
            {{ "  … " + (item.backtrace.length - BT_MAX) + " more" }}
          </div>
        </div>
        <div v-else class="row notice" :class="noticeTone(item)">{{ itemText(item) }}</div>
      </template>
    </div>
    <div class="entry">
      <div v-for="(l, i) in state.pending" :key="`p${i}`" class="row input">
        <span class="prompt">{{ i === 0 ? "rb> " : "..> " }}</span>{{ l }}
      </div>
      <div class="input-row">
        <span class="prompt">{{ model.prompt }}</span>
        <input
          ref="inputEl"
          :value="state.line"
          @input="onInput"
          @keydown="onKey"
          @keyup="trackCaret"
          @click="trackCaret"
          @select="trackCaret"
          @blur="trackCaret"
          @paste="onPaste"
          spellcheck="false"
          autocomplete="off"
        />
      </div>
      <div v-if="busyLong" class="row running">running… Ctrl-C to interrupt</div>
    </div>
  </div>
  <Teleport to="body">
    <div
      v-if="selMenu"
      ref="selMenuEl"
      class="sel-menu"
      :style="{ left: `${selMenu.x}px`, top: `${selMenu.y}px` }"
    >
      <div class="sel-item" role="menuitem" @click="copySel">Copy</div>
      <div class="sel-item" role="menuitem" @click="editSel">Edit</div>
    </div>
  </Teleport>
</template>

<style scoped>
.ruby-console {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  padding: 4px 8px;
  font-family: var(--app-font-family, "Maple Mono NF"), monospace;
  font-size: var(--app-font-size, 14pt);
  z-index: 0;
  cursor: text;
}
.row {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-height: 1em;
}
.prompt {
  color: #777;
  user-select: none;
}
.stdin {
  font-style: italic;
  color: #777;
}
.stderr {
  color: #b45309;
}
.value {
  color: #2f6f3e;
}
.error {
  color: #c0392b;
}
.error .err-cls {
  font-weight: bold;
}
.error .bt {
  color: #777;
}
.notice.warn {
  color: #b7791f;
}
.notice.info {
  color: #777;
}
.input .cancelled {
  color: #777;
}
.input .text.selected {
  background-color: rgba(56, 132, 255, 0.3);
}
.sel-menu {
  position: fixed;
  z-index: 4;
  padding: 4px;
  background-color: #f6f6f6;
  border: 1px solid #888;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  font-family: var(--app-font-family, "Maple Mono NF"), monospace;
  font-size: var(--app-font-size, 14pt);
  color: #0f0f0f;
}
.sel-item {
  padding: 2px 12px;
  white-space: nowrap;
  cursor: pointer;
}
.sel-item:hover {
  background-color: rgba(128, 128, 128, 0.2);
}
.entry .input-row {
  display: flex;
}
.entry input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  color: inherit;
  padding: 0;
}
.running {
  color: #777;
}
@media (prefers-color-scheme: dark) {
  .input .text.selected {
    background-color: rgba(56, 132, 255, 0.4);
  }
  .sel-menu {
    background-color: #2f2f2f;
    border-color: #777;
    color: #f6f6f6;
  }
  .stderr {
    color: #f0a040;
  }
  .value {
    color: #8fd19e;
  }
  .error {
    color: #ff7b72;
  }
  .notice.warn {
    color: #e3b341;
  }
  .prompt,
  .stdin,
  .notice.info,
  .error .bt,
  .running,
  .input .cancelled {
    color: #999;
  }
}
</style>
