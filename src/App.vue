<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { layoutColumns } from "./columns";
import {
  clampPos,
  isPaged,
  layout,
  nextPage,
  prevPage,
  rowDown,
  rowUp,
  runLines,
  type Geom,
  type Pos,
} from "./pager";
import FileName from "./components/FileName.vue";
import GearIcon from "./components/GearIcon.vue";

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
  isDir: boolean;
}

type FileDisplaySeg =
  | { kind: "rows"; row: number; rows: number; lines: { index: number; text: string }[] }
  | { kind: "bar"; id: "top" | "bottom" };

const fileView = ref<{ path: string; fileId: number; lineCount: number } | null>(null);
const fileOverlay = ref<HTMLElement | null>(null);
const filePos = ref<Pos>({ line: 0, row: 0 });
const paneRows = ref(0);
const fileRowH = ref(0);
const filePaged = ref(false);
const fileSegs = ref<FileDisplaySeg[]>([]);
const lineWrap = ref(false);
const lineDigits = computed(() => String(fileView.value?.lineCount ?? 1).length);
const lineTexts = new Map<number, string>();
const lineHeights = new Map<number, number>();
const BAR_TEXT = "● ".repeat(1000);
let fileRowsRequest = 0;
let wheelLines = 0;
let wheelSteps = 0;
let fileOpChain: Promise<void> = Promise.resolve();

function queueFileOp(op: () => Promise<void>) {
  fileOpChain = fileOpChain.then(op).catch((error) => {
    console.error("file op failed:", error);
  });
}

function fileGeom(view: { lineCount: number }): Geom {
  return {
    L: view.lineCount,
    N: paneRows.value,
    height: (line: number) => {
      if (!lineWrap.value) return 1;
      const h = lineHeights.get(line);
      if (h === undefined) throw new Error(`missing height for line ${line}`);
      return h;
    },
  };
}

// Line indices the pager may touch: bounded walks from the start, the
// end, and the current position.
function fileWindow(view: { lineCount: number }): number[] {
  const L = view.lineCount;
  const N = paneRows.value;
  const p = filePos.value.line;
  const indices: number[] = [];
  const push = (a: number, b: number) => {
    for (let i = Math.max(0, a); i < Math.min(L, b); i++) indices.push(i);
  };
  push(0, N + 2);
  push(L - N - 2, L);
  push(p - N - 2, p + 2 * N + 2);
  return indices;
}

function measureLineHeights(indices: number[]) {
  const overlay = fileOverlay.value;
  const measure = rowMeasure.value;
  if (!overlay || !measure || indices.length === 0) return;
  const cs = getComputedStyle(overlay);
  const width =
    overlay.clientWidth -
    parseFloat(cs.paddingLeft) -
    parseFloat(cs.paddingRight);
  const rowH = measure.getBoundingClientRect().height;
  if (width <= 0 || rowH <= 0) return;

  const host = document.createElement("div");
  host.className = "file-content";
  host.style.position = "absolute";
  host.style.visibility = "hidden";
  host.style.pointerEvents = "none";
  host.style.top = "0";
  host.style.left = "0";
  host.style.width = `${width}px`;
  const digits = String(fileView.value?.lineCount ?? 0).length;
  try {
    for (const i of indices) {
      const row = document.createElement("div");
      row.className = "file-line";
      const num = document.createElement("div");
      num.className = "line-num";
      num.style.width = `${digits}ch`;
      num.textContent = String(i + 1);
      const text = document.createElement("div");
      text.className = "file-row line-text";
      text.textContent = lineTexts.get(i) || " ";
      row.appendChild(num);
      row.appendChild(text);
      host.appendChild(row);
    }
    overlay.appendChild(host);
    let k = 0;
    for (const child of Array.from(host.children) as HTMLElement[]) {
      const h = Math.max(1, Math.round(child.getBoundingClientRect().height / rowH));
      lineHeights.set(indices[k++], h);
    }
  } finally {
    host.remove();
  }
}

async function ensureLines(view: { fileId: number; lineCount: number }, indices: number[]) {
  const want = [...new Set(indices)].filter((i) => i >= 0 && i < view.lineCount);
  const needText = want.filter((i) => !lineTexts.has(i)).sort((a, b) => a - b);
  if (needText.length > 0) {
    const lines = await invoke<string[]>("read_text_lines", {
      fileId: view.fileId,
      indices: needText,
    });
    if (fileView.value?.fileId !== view.fileId) return;
    needText.forEach((i, k) => lineTexts.set(i, lines[k] ?? ""));
  }
  if (lineWrap.value) {
    measureLineHeights(want.filter((i) => !lineHeights.has(i)));
  }
}

async function renderFile() {
  const view = fileView.value;
  const request = ++fileRowsRequest;
  if (!view || view.lineCount <= 0 || paneRows.value <= 0) {
    fileSegs.value = [];
    filePaged.value = false;
    return;
  }
  try {
    await ensureLines(view, fileWindow(view));
    if (request !== fileRowsRequest || fileView.value?.fileId !== view.fileId) return;
    const g = fileGeom(view);
    filePos.value = clampPos(g, filePos.value);
    const paged = isPaged(g);
    if (!paged) {
      await ensureLines(view, Array.from({ length: view.lineCount }, (_, i) => i));
      if (request !== fileRowsRequest || fileView.value?.fileId !== view.fileId) return;
    }
    filePaged.value = paged;
    fileSegs.value = layout(g, filePos.value).map((seg) =>
      seg.kind === "bar"
        ? seg
        : {
            kind: "rows",
            row: seg.row,
            rows: seg.rows,
            lines: runLines(g, seg).map((i) => ({
              index: i,
              text: lineTexts.get(i) ?? "",
            })),
          }
    );
  } catch (error) {
    if (request === fileRowsRequest) {
      console.error("render file failed:", error);
    }
  }
}

function navigate(step: (g: Geom, p: Pos) => Pos) {
  queueFileOp(async () => {
    const view = fileView.value;
    if (!view || view.lineCount <= 0 || paneRows.value <= 0) return;
    await ensureLines(view, fileWindow(view));
    if (fileView.value?.fileId !== view.fileId) return;
    const g = fileGeom(view);
    const next = step(g, clampPos(g, filePos.value));
    if (next.line !== filePos.value.line || next.row !== filePos.value.row) {
      filePos.value = next;
    }
    await renderFile();
  });
}

function toggleLineWrap() {
  menuOpen.value = false;
  queueFileOp(async () => {
    lineWrap.value = !lineWrap.value;
    lineHeights.clear();
    filePos.value = { line: filePos.value.line, row: 0 };
    await renderFile();
  });
}

async function openFile(path: string) {
  const opened = await invoke<{ fileId: number; lineCount: number }>("open_text_file", { path });
  fileRowsRequest++;
  fileSegs.value = [];
  filePaged.value = false;
  fileView.value = { path, ...opened };
  filePos.value = { line: 0, row: 0 };
  wheelLines = 0;
  wheelSteps = 0;
  lineTexts.clear();
  lineHeights.clear();
  closeDir();
  await nextTick();
  await document.fonts.ready;
  computeFileRows();
}

function computeFileRows() {
  const body = dirBody.value;
  const overlay = fileOverlay.value;
  const measure = rowMeasure.value;
  if (!body || !overlay || !measure) return;
  const cs = getComputedStyle(overlay);
  const avail =
    body.clientHeight -
    parseFloat(cs.paddingTop) -
    parseFloat(cs.paddingBottom) -
    parseFloat(cs.borderTopWidth) -
    parseFloat(cs.borderBottomWidth);
  const rowH = measure.getBoundingClientRect().height;
  fileRowH.value = rowH;
  paneRows.value = rowH > 0 ? Math.floor(avail / rowH) : 0;
  lineHeights.clear();
  if (fileView.value) queueFileOp(() => renderFile());
}

function closeFile() {
  const view = fileView.value;
  fileRowsRequest++;
  fileSegs.value = [];
  filePaged.value = false;
  fileView.value = null;
  wheelLines = 0;
  wheelSteps = 0;
  lineTexts.clear();
  lineHeights.clear();
  if (view) {
    void invoke("close_text_file", { fileId: view.fileId }).catch((error) => {
      console.error("close file failed:", error);
    });
  }
}

function displayName(entry: DirEntry) {
  return entry.isDir ? entry.name + "/" : entry.name;
}

const middlePane = ref<HTMLElement | null>(null);
const dirBody = ref<HTMLElement | null>(null);
const rowMeasure = ref<HTMLElement | null>(null);
const dirHeader = ref<HTMLElement | null>(null);
const dropdown = ref<HTMLElement | null>(null);
const gridEl = ref<HTMLElement | null>(null);
const gapEl = ref<HTMLElement | null>(null);
const gearButton = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menuOpen = ref(false);

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
    entries.value.map(displayName),
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

async function showEntries(list: DirEntry[]) {
  list.sort(
    (a, b) =>
      Number(b.name === "..") - Number(a.name === "..") ||
      a.name.localeCompare(b.name)
  );
  loading.value = false;
  if (list.length === 0) {
    entries.value = list;
    return;
  }
  measuring.value = true;
  entries.value = list;
  await measureEntries();
}

async function openDir() {
  closeFile();
  dirOpen.value = true;
  dirError.value = null;
  loading.value = true;
  entries.value = [];
  let list: DirEntry[];
  try {
    list = await invoke<DirEntry[]>("list_dir", { path: cwd.value });
  } catch (e) {
    dirError.value = String(e);
    loading.value = false;
    return;
  }
  await showEntries(list);
}

async function enterDir(path: string) {
  const list = await invoke<DirEntry[]>("list_dir", { path });
  cwd.value = path;
  dirError.value = null;
  if (dropdown.value) dropdown.value.scrollTop = 0;
  await showEntries(list);
}

function openEntry(entry: DirEntry) {
  return entry.isDir ? enterDir(entry.path) : openFile(entry.path);
}

function closeDir() {
  dirOpen.value = false;
}

function toggleDir() {
  if (dirOpen.value) closeDir();
  else openDir();
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}

async function chooseDirectory() {
  menuOpen.value = false;
  try {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: cwd.value,
    });
    if (typeof picked === "string") {
      cwd.value = picked;
      closeFile();
      if (dirOpen.value) await openDir();
    }
  } catch (e) {
    console.error("open directory failed:", e);
  }
}

function onDocPointerDown(e: PointerEvent) {
  const target = e.target as Node;
  if (
    menuOpen.value &&
    !menuEl.value?.contains(target) &&
    !gearButton.value?.contains(target)
  ) {
    menuOpen.value = false;
  }
  if (
    fileView.value &&
    !fileOverlay.value?.contains(target) &&
    !dirHeader.value?.contains(target)
  ) {
    closeFile();
  }
  if (!dirOpen.value) return;
  if (dropdown.value?.contains(target) || dirHeader.value?.contains(target)) {
    return;
  }
  closeDir();
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    closeDir();
    closeFile();
    menuOpen.value = false;
    return;
  }
  if (fileView.value && (e.key === "PageDown" || e.key === "PageUp")) {
    e.preventDefault();
    const down = e.key === "PageDown";
    navigate((g, p) => (down ? nextPage(g, p) : prevPage(g, p)));
  }
  if (fileView.value && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    const down = e.key === "ArrowDown";
    navigate((g, p) => (down ? rowDown(g, p) : rowUp(g, p)));
  }
}

function onFileWheel(e: WheelEvent) {
  if (!fileView.value || !filePaged.value) return;
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  e.preventDefault();

  let delta: number;
  if (e.deltaMode === 1) {
    delta = e.deltaY;
  } else if (e.deltaMode === 2) {
    delta = e.deltaY * (paneRows.value - 4);
  } else {
    const rowHeight = rowMeasure.value?.getBoundingClientRect().height;
    delta = e.deltaY / (rowHeight && rowHeight > 0 ? rowHeight : 20);
  }
  wheelLines += delta;
  let steps = Math.trunc(wheelLines);
  if (steps === 0) return;
  wheelLines -= steps;
  steps = Math.max(-paneRows.value, Math.min(paneRows.value, steps));
  wheelSteps += steps;

  queueFileOp(async () => {
    const view = fileView.value;
    const total = Math.max(-paneRows.value, Math.min(paneRows.value, wheelSteps));
    wheelSteps = 0;
    if (!view || total === 0 || paneRows.value <= 0) return;
    await ensureLines(view, fileWindow(view));
    if (fileView.value?.fileId !== view.fileId) return;
    const g = fileGeom(view);
    let p = clampPos(g, filePos.value);
    for (let i = 0; i < Math.abs(total); i++) {
      p = total > 0 ? rowDown(g, p) : rowUp(g, p);
    }
    filePos.value = p;
    await renderFile();
  });
}

const gridStyle = computed(() => ({
  gridTemplateColumns: colWidths.value
    .map((w) => `${w}px`)
    .join(" "),
  gridTemplateRows: `repeat(${rows.value}, auto)`,
  columnGap: `${columnGap.value}px`,
}));

let resizeObserver: ResizeObserver | null = null;
let unlistenMenuOpen: (() => void) | null = null;

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

  unlistenMenuOpen = await listen("menu-open", () => chooseDirectory());

  if (middlePane.value) {
    resizeObserver = new ResizeObserver(() => {
      if (dirOpen.value) recomputeLayout();
      if (fileView.value) computeFileRows();
    });
    resizeObserver.observe(middlePane.value);
  }
});

onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocPointerDown);
  document.removeEventListener("keydown", onKeyDown);
  resizeObserver?.disconnect();
  unlistenMenuOpen?.();
});
</script>

<template>
  <div ref="container" class="panes">
    <section class="pane" :style="{ width: `${leftFraction * 100}%` }"></section>
    <div class="divider">
      <div class="handle" @pointerdown.prevent="startDrag('left', $event)"></div>
    </div>
    <section ref="middlePane" class="pane middle">
      <div ref="dirHeader" class="dir-header">
        <span class="dir-path" @click="toggleDir">{{ cwd }}</span>
        <button
          ref="gearButton"
          class="gear-button"
          aria-label="Settings"
          @click="toggleMenu"
        >
          <GearIcon />
        </button>
        <div v-if="menuOpen" ref="menuEl" class="dir-menu">
          <div class="menu-item" role="menuitem" @click="chooseDirectory">
            Open...
          </div>
          <div class="menu-item" role="menuitem" @click="toggleLineWrap">
            Line wrap is {{ lineWrap ? "on" : "off" }}
          </div>
        </div>
      </div>
      <div ref="dirBody" class="dir-body">
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
              :name="displayName(entry)"
              :path="entry.path"
              :open="() => openEntry(entry)"
            />
          </div>
        </div>
        <div
          v-if="fileView"
          ref="fileOverlay"
          class="dir-dropdown file-view"
          :class="{ paged: filePaged, wrap: lineWrap }"
          @wheel="onFileWheel"
        >
          <div ref="rowMeasure" class="file-row row-measure" aria-hidden="true">{{ " " }}</div>
          <div v-if="fileView.lineCount === 0" class="dir-message">(empty)</div>
          <div v-else class="file-content">
            <template
              v-for="(seg, si) in fileSegs"
              :key="seg.kind === 'bar' ? `bar-${seg.id}` : `seg-${si}`"
            >
              <div
                v-if="seg.kind === 'rows'"
                class="rows-clip"
                :style="{ height: `${seg.rows * fileRowH}px` }"
              >
                <div :style="{ marginTop: `${-seg.row * fileRowH}px` }">
                  <div
                    v-for="line in seg.lines"
                    :key="line.index"
                    class="file-line"
                  >
                    <div
                      class="line-num"
                      :style="{ width: `${lineDigits}ch` }"
                    >{{ line.index + 1 }}</div>
                    <div class="file-row line-text">{{ line.text || " " }}</div>
                  </div>
                </div>
              </div>
              <div v-else class="file-row file-bar" aria-hidden="true">{{ BAR_TEXT }}</div>
            </template>
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
  position: relative;
  display: flex;
  align-items: center;
  padding: 0 8px;
  border-bottom: 1px solid #888;
}

.dir-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.gear-button {
  flex: none;
  display: flex;
  align-items: center;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  padding: 0 2px;
  cursor: pointer;
}

.gear-button:hover {
  opacity: 0.7;
}

.dir-menu {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 3;
  padding: 4px;
  background-color: #f6f6f6;
  border: 1px solid #888;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}

.menu-item {
  padding: 2px 12px;
  white-space: nowrap;
  cursor: pointer;
}

.menu-item:hover {
  background-color: rgba(128, 128, 128, 0.2);
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

.file-view {
  overflow-x: auto;
}

.file-view.paged {
  overflow-y: hidden;
}

.file-content {
  width: max-content;
  min-width: 100%;
}

.file-view.wrap {
  overflow-x: hidden;
}

.file-view.wrap .file-content {
  width: 100%;
  min-width: 0;
}

.file-view.wrap .file-content .file-row {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.file-view.wrap .file-content .file-row.file-bar {
  white-space: pre;
}

.rows-clip {
  display: flow-root;
  overflow: clip;
}

.file-line {
  display: flex;
  align-items: stretch;
}

.line-num {
  flex: none;
  box-sizing: content-box;
  text-align: right;
  padding-right: 0.5ch;
  border-right: 1px solid #0f0f0f;
  white-space: pre;
  user-select: none;
  position: sticky;
  left: 0;
  z-index: 1;
  background-color: #f6f6f6;
  box-shadow: -8px 0 0 #f6f6f6;
}

.line-text {
  flex: 1;
  min-width: 0;
  padding-left: 0.5ch;
}

.file-row {
  white-space: pre;
}

.row-measure {
  position: absolute;
  visibility: hidden;
  pointer-events: none;
}

.file-bar {
  width: 0;
  min-width: 100%;
  overflow: hidden;
  color: #f6f6f6;
  background-color: #0f0f0f;
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

  .dir-menu {
    background-color: #2f2f2f;
    border-color: #777;
  }

  .file-bar {
    color: #2f2f2f;
    background-color: #f6f6f6;
  }

  .line-num {
    background-color: #2f2f2f;
    box-shadow: -8px 0 0 #2f2f2f;
    border-right-color: #f6f6f6;
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
