export interface Entry {
  name: string;
  text: string;
  code?: string;
}

export interface Snapshot {
  requires?: Entry[];
  locals: Entry[];
  ivars: Entry[];
  classes: Entry[];
  methods: Entry[];
}

export interface PaneEntry extends Entry {
  stale: boolean;
}

export interface Panes {
  requires: PaneEntry[];
  vars: PaneEntry[];
  classes: PaneEntry[];
  methods: PaneEntry[];
}

export function emptyPanes(): Panes {
  return { requires: [], vars: [], classes: [], methods: [] };
}

function mergeArea(prev: PaneEntry[], snap: Entry[]): PaneEntry[] {
  const byName = new Map(snap.map((e) => [e.name, e]));
  const out: PaneEntry[] = prev.map((p) => {
    const s = byName.get(p.name);
    return s ? { ...s, stale: false } : { ...p, stale: true };
  });
  const prevNames = new Set(prev.map((p) => p.name));
  for (const e of snap) {
    if (!prevNames.has(e.name)) out.push({ ...e, stale: false });
  }
  return out;
}

function addRequires(prev: PaneEntry[], incoming: Entry[]): PaneEntry[] {
  const out = prev.map((p) => ({ ...p }));
  const byName = new Map(out.map((p, i) => [p.name, i]));
  for (const e of incoming) {
    const idx = byName.get(e.name);
    if (idx !== undefined) {
      out[idx] = { ...e, stale: false };
    } else {
      byName.set(e.name, out.length);
      out.push({ ...e, stale: false });
    }
  }
  return out;
}

export function mergePanes(prev: Panes, snap: Snapshot): Panes {
  return {
    requires: addRequires(prev.requires, snap.requires ?? []),
    vars: mergeArea(prev.vars, [...snap.locals, ...snap.ivars]),
    classes: mergeArea(prev.classes, snap.classes),
    methods: mergeArea(prev.methods, snap.methods),
  };
}

export function staleAll(prev: Panes): Panes {
  return {
    requires: prev.requires.map((e) => ({ ...e, stale: true })),
    vars: prev.vars.map((e) => ({ ...e, stale: true })),
    classes: prev.classes.map((e) => ({ ...e, stale: true })),
    methods: prev.methods.map((e) => ({ ...e, stale: true })),
  };
}

export function previewLines(src: string, n = 3): string[] {
  const lines = src.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length <= n) return lines;
  return [...lines.slice(0, n), "..."];
}
