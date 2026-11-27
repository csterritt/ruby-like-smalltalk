export interface Entry {
  name: string;
  text: string;
}

export interface Snapshot {
  locals: Entry[];
  ivars: Entry[];
  classes: Entry[];
  methods: Entry[];
}

export function emptySnapshot(): Snapshot {
  return { locals: [], ivars: [], classes: [], methods: [] };
}

export function previewLines(src: string, n = 3): string[] {
  const lines = src.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length <= n) return lines;
  return [...lines.slice(0, n), "..."];
}
