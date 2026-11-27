export interface Entry {
  name: string;
  text: string;
  code?: string;
}

export interface Snapshot {
  locals: Entry[];
  ivars: Entry[];
  classes: Entry[];
  methods: Entry[];
}

export interface PaneEntry extends Entry {
  stale: boolean;
}

export interface Panes {
  locals: PaneEntry[];
  ivars: PaneEntry[];
  classes: PaneEntry[];
  methods: PaneEntry[];
}

export function emptyPanes(): Panes {
  return { locals: [], ivars: [], classes: [], methods: [] };
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

export function mergePanes(prev: Panes, snap: Snapshot): Panes {
  return {
    locals: mergeArea(prev.locals, snap.locals),
    ivars: mergeArea(prev.ivars, snap.ivars),
    classes: mergeArea(prev.classes, snap.classes),
    methods: mergeArea(prev.methods, snap.methods),
  };
}

export function staleAll(prev: Panes): Panes {
  return {
    locals: prev.locals.map((e) => ({ ...e, stale: true })),
    ivars: prev.ivars.map((e) => ({ ...e, stale: true })),
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
