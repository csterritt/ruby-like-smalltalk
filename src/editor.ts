import type { PaneEntry, Panes } from "./snapshot";

export const EDITOR_READY = "editor-ready";
export const EDITOR_INIT = "editor-init";
export const EDITOR_SAVE = "editor-save";
export const EDITOR_RESULT = "editor-result";

export interface EditorReady {
  label: string;
}

export interface EditorInit {
  name: string;
  area?: keyof Panes;
  mode: "define" | "prompt";
  code: string;
}

export interface EditorSave {
  label: string;
  code: string;
}

export type EditorResult = { ok: true } | { ok: false; error: string };

export function editorText(area: keyof Panes, entry: PaneEntry): string {
  if (entry.code) return entry.code;
  if (area === "locals" || area === "ivars") return `${entry.name} = ${entry.text}`;
  return entry.text;
}
