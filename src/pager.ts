export type PagerRow =
  | { kind: "line"; index: number }
  | { kind: "bar"; id: "top" | "bottom" };

export function isPaged(L: number, N: number): boolean {
  return N >= 5 && L > N;
}

export function clampStart(L: number, N: number, s: number): number {
  return isPaged(L, N) ? Math.min(Math.max(s, 0), L - (N - 2)) : 0;
}

export function pageRows(L: number, N: number, start: number): PagerRow[] {
  if (N <= 0) return [];
  if (!isPaged(L, N)) {
    return Array.from({ length: L }, (_, i) => ({ kind: "line", index: i }));
  }
  const s = clampStart(L, N, start);
  const rows: PagerRow[] = [];
  let R = N;
  if (s > 0) {
    rows.push({ kind: "line", index: 0 });
    rows.push({ kind: "bar", id: "top" });
    R = N - 2;
  }
  if (L - s <= R) {
    for (let i = s; i < L; i++) rows.push({ kind: "line", index: i });
  } else {
    for (let i = s; i <= s + R - 3; i++) rows.push({ kind: "line", index: i });
    rows.push({ kind: "bar", id: "bottom" });
    rows.push({ kind: "line", index: L - 1 });
  }
  return rows;
}

export function nextStart(L: number, N: number, s: number): number {
  s = clampStart(L, N, s);
  if (!isPaged(L, N)) return 0;
  return Math.min(s === 0 ? N - 2 : s + N - 4, L - (N - 2));
}

export function prevStart(L: number, N: number, s: number): number {
  s = clampStart(L, N, s);
  if (s <= N - 2) return 0;
  return Math.max(s - (N - 4), N - 2);
}

export function lineDownStart(L: number, N: number, s: number): number {
  s = clampStart(L, N, s);
  return clampStart(L, N, s === 0 ? 3 : s + 1);
}

export function lineUpStart(L: number, N: number, s: number): number {
  s = clampStart(L, N, s);
  return s <= 3 ? 0 : s - 1;
}
