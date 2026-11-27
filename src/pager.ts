export interface Pos {
  line: number;
  row: number; // wrapped row within `line`
}

export interface Geom {
  L: number; // line count
  N: number; // pane rows
  height: (line: number) => number; // screen rows of a line, >= 1
}

export type Segment =
  | { kind: "rows"; line: number; row: number; rows: number }
  | { kind: "bar"; id: "top" | "bottom" };

function pinCap(N: number): number {
  return Math.max(1, Math.floor((N - 3) / 3));
}

function h0p(g: Geom): number {
  return Math.min(g.height(0), pinCap(g.N));
}

function hLp(g: Geom): number {
  return Math.min(g.height(g.L - 1), pinCap(g.N));
}

// Rows shown at pos 0 (before the bottom bar and last-line pin).
function A(g: Geom): number {
  return g.N - 1 - hLp(g);
}

// Middle rows when both bars and both pins show.
function M(g: Geom): number {
  return g.N - h0p(g) - 2 - hLp(g);
}

function cmpPos(a: Pos, b: Pos): number {
  return a.line - b.line || a.row - b.row;
}

export function isPaged(g: Geom): boolean {
  if (g.N < 5) return false;
  let total = 0;
  for (let i = 0; i < g.L; i++) {
    total += g.height(i);
    if (total > g.N) return true;
  }
  return false;
}

export function advance(g: Geom, p: Pos, k: number): Pos {
  if (g.L <= 0) return { line: 0, row: 0 };
  let { line, row } = p;
  while (k > 0 && line < g.L - 1) {
    const take = Math.min(k, g.height(line) - row);
    row += take;
    k -= take;
    if (row === g.height(line)) {
      line++;
      row = 0;
    }
  }
  if (line === g.L - 1 && k > 0) {
    row = Math.min(row + k, g.height(line) - 1);
  }
  return { line, row };
}

export function retreat(g: Geom, p: Pos, k: number): Pos {
  if (g.L <= 0) return { line: 0, row: 0 };
  let { line, row } = p;
  if (line >= g.L) {
    line = g.L - 1;
    row = g.height(line);
  }
  while (k > 0 && !(line === 0 && row === 0)) {
    if (row === 0) {
      line--;
      row = g.height(line);
    }
    const take = Math.min(k, row);
    row -= take;
    k -= take;
  }
  return { line, row };
}

// Rows before p, counted from the start of the file, capped at limit + 1.
export function absRowsUpTo(g: Geom, p: Pos, limit: number): number {
  let total = 0;
  for (let i = 0; i < p.line && i < g.L; i++) {
    total += g.height(i);
    if (total > limit) return limit + 1;
  }
  if (p.line < g.L) total += p.row;
  return Math.min(total, limit + 1);
}

// Rows from p to the end of the file, capped at limit + 1.
function rowsToEnd(g: Geom, p: Pos, limit: number): number {
  let total = 0;
  for (let i = p.line; i < g.L; i++) {
    total += g.height(i) - (i === p.line ? p.row : 0);
    if (total > limit) return limit + 1;
  }
  return Math.min(total, limit + 1);
}

// Earliest position from which the rest of the file fits under the top
// pin plus top bar.
function maxPos(g: Geom): Pos {
  return retreat(g, { line: g.L, row: 0 }, g.N - h0p(g) - 1);
}

export function clampPos(g: Geom, p: Pos): Pos {
  if (!isPaged(g)) return { line: 0, row: 0 };
  const line = Math.min(Math.max(p.line, 0), g.L - 1);
  const row = Math.min(Math.max(p.row, 0), g.height(line) - 1);
  const mp = maxPos(g);
  if (cmpPos({ line, row }, mp) > 0) return mp;
  return { line, row };
}

export function layout(g: Geom, pos: Pos): Segment[] {
  if (!isPaged(g)) {
    let total = 0;
    for (let i = 0; i < g.L; i++) total += g.height(i);
    return [{ kind: "rows", line: 0, row: 0, rows: total }];
  }
  const p = clampPos(g, pos);
  if (p.line === 0 && p.row === 0) {
    return [
      { kind: "rows", line: 0, row: 0, rows: A(g) },
      { kind: "bar", id: "bottom" },
      { kind: "rows", line: g.L - 1, row: 0, rows: hLp(g) },
    ];
  }
  const limit = g.N - h0p(g) - 1;
  const remaining = rowsToEnd(g, p, limit);
  if (remaining <= limit) {
    return [
      { kind: "rows", line: 0, row: 0, rows: h0p(g) },
      { kind: "bar", id: "top" },
      { kind: "rows", line: p.line, row: p.row, rows: remaining },
    ];
  }
  return [
    { kind: "rows", line: 0, row: 0, rows: h0p(g) },
    { kind: "bar", id: "top" },
    { kind: "rows", line: p.line, row: p.row, rows: M(g) },
    { kind: "bar", id: "bottom" },
    { kind: "rows", line: g.L - 1, row: 0, rows: hLp(g) },
  ];
}

export function nextPage(g: Geom, p: Pos): Pos {
  const q =
    p.line === 0 && p.row === 0 ? advance(g, p, A(g)) : advance(g, p, M(g));
  return clampPos(g, q);
}

export function prevPage(g: Geom, p: Pos): Pos {
  if (absRowsUpTo(g, p, A(g)) <= A(g)) return { line: 0, row: 0 };
  const a = retreat(g, p, M(g));
  const b = advance(g, { line: 0, row: 0 }, A(g));
  return cmpPos(a, b) > 0 ? a : b;
}

export function rowDown(g: Geom, p: Pos): Pos {
  const q =
    p.line === 0 && p.row === 0 ? advance(g, p, h0p(g) + 2) : advance(g, p, 1);
  return clampPos(g, q);
}

export function rowUp(g: Geom, p: Pos): Pos {
  if (absRowsUpTo(g, p, h0p(g) + 2) <= h0p(g) + 2) return { line: 0, row: 0 };
  return retreat(g, p, 1);
}

// Line indices that a rows segment touches.
export function runLines(g: Geom, seg: { line: number; row: number; rows: number }): number[] {
  const lines: number[] = [];
  let { line, row } = seg;
  let left = seg.rows;
  while (left > 0 && line < g.L) {
    lines.push(line);
    left -= Math.min(left, g.height(line) - row);
    line++;
    row = 0;
  }
  return lines;
}
