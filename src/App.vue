<script setup lang="ts">
import { ref } from "vue";

const LINE_WIDTH = 1;

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
</script>

<template>
  <div ref="container" class="panes">
    <section class="pane" :style="{ width: `${leftFraction * 100}%` }"></section>
    <div class="divider">
      <div class="handle" @pointerdown.prevent="startDrag('left', $event)"></div>
    </div>
    <section class="pane middle"></section>
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
  font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
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

  .divider,
  .handle {
    background-color: #777;
  }

  .handle:hover {
    background-color: #aaa;
  }
}
</style>
