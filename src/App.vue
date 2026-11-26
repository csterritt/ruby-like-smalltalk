<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { layoutColumns } from "./columns";
import FileName from "./components/FileName.vue";

const LINE_WIDTH = 1;
const FONT_FAMILY = '"Maple Mono NF"';
const FONT_SIZE = "14pt";

const container = ref<HTMLElement | null>(null);
const leftFraction = ref(0.2);
const rightFraction = ref(0.2);

type Side = "left" | "right";

function startDrag(side: Side, event: PointerEvent) {
  const el = container.value;
  if (!el) return;
  const handle = event.currentTarget as HTMLElement;
  handle.setPointerCapture(event.pointerId);

  const width = el.getBoundingClientRect().width;
  const startX = event.clientX;
  const startLeft = leftFraction.value * width;
  const startRight = rightFraction.value * width;

  const onMove = (e: PointerEvent) => {
    const dx = e.clientX - startX;
    if (side === "left") {
      const max = width - startRight - 2 * LINE_WIDTH;
      leftFraction.value = Math.min(Math.max(startLeft + dx, 0), max) / width;
    } else {
      const max = width - leftFraction.value * width - 2 * LINE_WIDTH;
      rightFraction.value = Math.min(Math.max(startRight - dx, 0), max) / width;
    }
  };
  const onUp = (e: PointerEvent) => {
    handle.releasePointerCapture(e.pointerId);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("dragging");
  };

  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
  document.body.classList.add("dragging");
}

const cwd = ref("");
const dirOpen = ref(false);
const dirError = ref<string | null>(null);
const loading = ref(false);
const measuring = ref(false);
const entries = ref<DirEntry[]>([]);
const rows = ref(0);
const colWidths = ref<number[]>([]);
const columnGap = ref(0);

interface DirEntry {
  name: string;
  path: string;
}

const middlePane = ref<HTMLElement | null>(null);
const dirHeader = ref<HTMLElement | null>(null);
const dropdown = ref<HTMLElement | null>(null);
const gridEl = ref<HTMLElement | null>(null);
const gapEl = ref<HTMLElement | null>(null);

let cachedWidths: number[] = [];

function recomputeLayout() {
  const el = dropdown.value;
  if (!el || entries.value.length === 0) {
    rows.value = 0;
    colWidths.value = [];
    return;
  }
  const style = getComputedStyle(el);
  const hPad =
    parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const available = el.clientWidth - hPad;
  const gap = gapEl.value
    ? Math.ceil(gapEl.value.getBoundingClientRect().width)
    : 0;
  const layout = layoutColumns(
    entries.value.map((e) => e.name),
    cachedWidths,
    available,
    gap
  );
  rows.value = layout.rows;
  colWidths.value = layout.colWidths;
  columnGap.value = gap;
}

async function measureEntries() {
  await document.fonts.ready;
  await nextTick();
  const el = gridEl.value;
  if (!el) return;
  cachedWidths = Array.from(el.querySelectorAll(".file-name")).map(
    (item) => Math.ceil(item.getBoundingClientRect().width) + 1
  );
  measuring.value = false;
  recomputeLayout();
}

async function openDir() {
  dirOpen.value = true;
  dirError.value = null;
  loading.value = true;
  entries.value = [];
  let names: DirEntry[];
  try {
    names = await invoke<DirEntry[]>("list_dir", { path: cwd.value });
  } catch (e) {
    dirError.value = String(e);
    loading.value = false;
    return;
  }
  names.sort((a, b) => a.name.localeCompare(b.name));
  loading.value = false;
  if (names.length === 0) {
    entries.value = names;
    return;
  }
  measuring.value = true;
  entries.value = names;
  await measureEntries();
}

function closeDir() {
  dirOpen.value = false;
}

function toggleDir() {
  if (dirOpen.value) closeDir();
  else openDir();
}

function onDocPointerDown(e: PointerEvent) {
  if (!dirOpen.value) return;
  const target = e.target as Node;
  if (dropdown.value?.contains(target) || dirHeader.value?.contains(target)) {
    return;
  }
  closeDir();
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") closeDir();
}

const gridStyle = computed(() => ({
  gridTemplateColumns: colWidths.value
    .map((w) => `${w}px`)
    .join(" "),
  gridTemplateRows: `repeat(${rows.value}, auto)`,
  columnGap: `${columnGap.value}px`,
}));

let resizeObserver: ResizeObserver | null = null;

onMounted(async () => {
  const root = document.documentElement;
  root.style.setProperty("--app-font-family", FONT_FAMILY);
  root.style.setProperty("--app-font-size", FONT_SIZE);

  try {
    cwd.value = await invoke<string>("current_dir");
  } catch (e) {
    cwd.value = String(e);
  }

  document.addEventListener("pointerdown", onDocPointerDown);
  document.addEventListener("keydown", onKeyDown);

  if (middlePane.value) {
    resizeObserver = new ResizeObserver(() => {
      if (dirOpen.value) recomputeLayout();
    });
    resizeObserver.observe(middlePane.value);
  }
});

onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocPointerDown);
  document.removeEventListener("keydown", onKeyDown);
  resizeObserver?.disconnect();
});
</script>

<template>
  <div ref="container" class="panes">
    <section class="pane" :style="{ width: `${leftFraction * 100}%` }"></section>
    <div class="divider">
      <div class="handle" @pointerdown.prevent="startDrag('left', $event)"></div>
    </div>
    <section ref="middlePane" class="pane middle">
      <div ref="dirHeader" class="dir-header" @click="toggleDir">{{ cwd }}</div>
      <div class="dir-body">
        <div v-if="dirOpen" ref="dropdown" class="dir-dropdown">
          <span ref="gapEl" class="gap-measure" aria-hidden="true">{{ "  " }}</span>
          <div v-if="dirError" class="dir-message">{{ dirError }}</div>
          <div v-else-if="!loading && entries.length === 0" class="dir-message">(empty)</div>
          <div
            v-else-if="!loading"
            ref="gridEl"
            class="dir-grid"
            :class="{ measuring }"
            :style="gridStyle"
          >
            <FileName
              v-for="entry in entries"
              :key="entry.path"
              :name="entry.name"
              :path="entry.path"
            />
          </div>
        </div>
      </div>
    </section>
    <div class="divider">
      <div class="handle" @pointerdown.prevent="startDrag('right', $event)"></div>
    </div>
    <section class="pane" :style="{ width: `${rightFraction * 100}%` }"></section>
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

body.dragging {
  cursor: col-resize;
  user-select: none;
}

.panes {
  display: flex;
  height: 100%;
}

.pane {
  flex: none;
  min-width: 0;
  overflow: auto;
}

.pane.middle {
  flex: 1;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}

.dir-header {
  flex: none;
  padding: 0 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-bottom: 1px solid #888;
  cursor: pointer;
}

.dir-body {
  flex: 1;
  position: relative;
  min-height: 0;
}

.dir-dropdown {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  max-height: 100%;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 4px 8px;
  background-color: #f6f6f6;
  border-bottom: 1px solid #888;
  z-index: 2;
}

.dir-grid {
  display: grid;
  grid-auto-flow: column;
  justify-items: start;
}

.dir-grid.measuring {
  display: flex;
  flex-wrap: nowrap;
  visibility: hidden;
}

.dir-grid.measuring > * {
  flex: none;
}

.gap-measure {
  position: absolute;
  visibility: hidden;
  white-space: pre;
  pointer-events: none;
}

.divider {
  position: relative;
  flex: none;
  width: 1px;
  background-color: #888;
}

.handle {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 6px;
  height: 40px;
  transform: translate(-50%, -50%);
  background-color: #888;
  border-radius: 3px;
  cursor: col-resize;
  z-index: 1;
  touch-action: none;
}

.handle:hover {
  background-color: #555;
}

@media (prefers-color-scheme: dark) {
  body {
    color: #f6f6f6;
    background-color: #2f2f2f;
  }

  .dir-header,
  .dir-dropdown {
    border-bottom-color: #777;
  }

  .dir-dropdown {
    background-color: #2f2f2f;
  }

  .divider,
  .handle {
    background-color: #777;
  }

  .handle:hover {
    background-color: #aaa;
  }
}
</style>
