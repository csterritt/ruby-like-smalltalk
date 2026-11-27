import { describe, expect, test } from "bun:test";
import {
  absRowsUpTo,
  advance,
  clampPos,
  isPaged,
  layout,
  nextPage,
  prevPage,
  retreat,
  rowDown,
  rowUp,
  runLines,
  type Geom,
  type Pos,
  type Segment,
} from "../src/pager";

// ---- Reference oracle: the old line-based pager (pre-wrap model) ----

type PagerRow =
  | { kind: "line"; index: number }
  | { kind: "bar"; id: "top" | "bottom" };

function oldIsPaged(L: number, N: number): boolean {
  return N >= 5 && L > N;
}

function clampStart(L: number, N: number, s: number): number {
  return oldIsPaged(L, N) ? Math.min(Math.max(s, 0), L - (N - 2)) : 0;
}

function pageRows(L: number, N: number, start: number): PagerRow[] {
  if (N <= 0) return [];
  if (!oldIsPaged(L, N)) {
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

function nextStart(L: number, N: number, s: number): number {
  s = clampStart(L, N, s);
  if (!oldIsPaged(L, N)) return 0;
  return Math.min(s === 0 ? N - 2 : s + N - 4, L - (N - 2));
}

function prevStart(L: number, N: number, s: number): number {
  s = clampStart(L, N, s);
  if (s <= N - 2) return 0;
  return Math.max(s - (N - 4), N - 2);
}

function lineDownStart(L: number, N: number, s: number): number {
  s = clampStart(L, N, s);
  return clampStart(L, N, s === 0 ? 3 : s + 1);
}

function lineUpStart(L: number, N: number, s: number): number {
  s = clampStart(L, N, s);
  return s <= 3 ? 0 : s - 1;
}

// ---- Helpers ----

function geomOf(heights: number[], N: number): Geom {
  return { L: heights.length, N, height: (i) => heights[i] };
}

function flat(heights: number[], N: number): Geom {
  return geomOf(new Array<number>(heights.length).fill(1), N);
}

// Expand a layout into per-row entries; bars count as one row each.
function expand(g: Geom, segs: Segment[]): Array<string> {
  const out: string[] = [];
  for (const seg of segs) {
    if (seg.kind === "bar") {
      out.push(`bar-${seg.id}`);
      continue;
    }
    let { line, row } = seg;
    let left = seg.rows;
    while (left > 0) {
      out.push(`L${line}r${row}`);
      left--;
      row++;
      if (row === g.height(line)) {
        line++;
        row = 0;
      }
    }
  }
  return out;
}

function expandLinesOnly(g: Geom, segs: Segment[]): string[] {
  // For equivalence with the old pager: collapse each rows segment into
  // the distinct lines it shows (h==1 => one row per line anyway).
  return expand(g, segs).map((e) => (e.startsWith("L") ? e.slice(0, e.indexOf("r")) : e));
}

function segRowsTotal(segs: Segment[]): number {
  // Total screen rows occupied (rows segments plus one row per bar).
  return segs.reduce((n, s) => n + (s.kind === "bar" ? 1 : s.rows), 0);
}

const P0: Pos = { line: 0, row: 0 };
const at = (line: number, row = 0): Pos => ({ line, row });

// ---- 1. Equivalence with the old pager when h == 1 ----

describe("h==1 equivalence with the old pager", () => {
  for (let N = 5; N <= 12; N++) {
    for (let L = 0; L <= 40; L++) {
      const g = flat(new Array<number>(L), N);
      const maxStart = oldIsPaged(L, N) ? L - (N - 2) : 0;
      for (let s = 0; s <= maxStart; s++) {
        test(`N=${N} L=${L} s=${s}`, () => {
          const oldRows = pageRows(L, N, s);
          const newRows = expandLinesOnly(g, layout(g, at(s)));
          const oldFlat = oldRows.map((r) =>
            r.kind === "line" ? `L${r.index}` : `bar-${r.id}`
          );
          expect(newRows).toEqual(oldFlat);

          const np = nextPage(g, at(s));
          expect(np).toEqual(at(nextStart(L, N, s)));

          const pp = prevPage(g, at(s));
          expect(pp).toEqual(at(prevStart(L, N, s)));

          const rd = rowDown(g, at(s));
          expect(rd).toEqual(at(lineDownStart(L, N, s)));

          const ru = rowUp(g, at(s));
          expect(ru).toEqual(at(lineUpStart(L, N, s)));

          expect(clampPos(g, at(s))).toEqual(at(clampStart(L, N, s)));
        });
      }
    }
  }

  test("isPaged matches for N < 5", () => {
    for (let N = 0; N < 5; N++) {
      for (let L = 0; L <= 30; L++) {
        expect(isPaged(flat(new Array<number>(L), N))).toBe(oldIsPaged(L, N));
      }
    }
  });
});

// ---- 2. Wrapped cases ----

describe("wrapped heights", () => {
  const heights = [2, 1, 3, 1, 1, 1, 1, 1, 1, 1, 1, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2];
  const N = 10;
  const g = geomOf(heights, N);
  const total = heights.reduce((a, b) => a + b, 0); // 31

  test("paged, pinCap/h0p/hLp", () => {
    expect(isPaged(g)).toBe(true);
    // pinCap = floor((10-3)/3) = 2; h0p = min(2,2) = 2; hLp = min(2,2) = 2
  });

  test("layout at pos 0", () => {
    const segs = layout(g, P0);
    // A = 10 - 1 - 2 = 7 rows of file top, bar, 2 rows of last line pin
    expect(segs).toEqual([
      { kind: "rows", line: 0, row: 0, rows: 7 },
      { kind: "bar", id: "bottom" },
      { kind: "rows", line: 23, row: 0, rows: 2 },
    ]);
    expect(expand(g, segs)).toEqual([
      "L0r0", "L0r1", "L1r0", "L2r0", "L2r1", "L2r2", "L3r0",
      "bar-bottom",
      "L23r0", "L23r1",
    ]);
    expect(segRowsTotal(segs)).toBe(N);
  });

  test("rowDown from 0 lands at absolute row h0p+2 = 4", () => {
    const p = rowDown(g, P0);
    // h0p+2 = 4 rows from start: L0r0,L0r1,L1r0,L2r0,L2r1 -> pos L2r1
    expect(p).toEqual(at(2, 1));
    expect(absRowsUpTo(g, p, 100)).toBe(4);
  });

  test("partial top line appears in layout (row > 0)", () => {
    const p = rowDown(g, P0); // {2,1}
    const segs = layout(g, p);
    // Both bars + both pins expected mid-file:
    // M = 10 - 2 - 2 - 2 = 4
    expect(segs).toEqual([
      { kind: "rows", line: 0, row: 0, rows: 2 },
      { kind: "bar", id: "top" },
      { kind: "rows", line: 2, row: 1, rows: 4 },
      { kind: "bar", id: "bottom" },
      { kind: "rows", line: 23, row: 0, rows: 2 },
    ]);
    expect(expand(g, segs)).toEqual([
      "L0r0", "L0r1",
      "bar-top",
      "L2r1", "L2r2", "L3r0", "L4r0",
      "bar-bottom",
      "L23r0", "L23r1",
    ]);
    expect(segRowsTotal(segs)).toBe(N);
  });

  test("repeated rowDown reaches maxPos and stops", () => {
    let p = P0;
    for (let i = 0; i < total + 10; i++) p = rowDown(g, p);
    // maxPos = retreat(end, N - h0p - 1 = 7): last pos showing last 7 rows
    // last 7 rows: L22r0, L23r0, L23r1 is only 3... walk: rows from end:
    // L23(2), L22(1), L21(1), L20(1), L19(1), L18(1) = 7 rows -> start L18r0? no:
    // 7 rows back from end: L23r1,L23r0,L22r0,L21r0,L20r0,L19r0,L18r0 -> p = L18r0
    expect(p).toEqual(at(18, 0));
    expect(rowDown(g, p)).toEqual(at(18, 0));
    const segs = layout(g, p);
    // boundary branch: rows from p to end = 7 <= N - h0p - 1 = 7
    expect(segs).toEqual([
      { kind: "rows", line: 0, row: 0, rows: 2 },
      { kind: "bar", id: "top" },
      { kind: "rows", line: 18, row: 0, rows: 7 },
    ]);
    expect(segRowsTotal(segs)).toBe(N);
  });

  test("repeated rowUp from maxPos returns to 0", () => {
    let p = at(18, 0);
    for (let i = 0; i < total + 10; i++) p = rowUp(g, p);
    expect(p).toEqual(P0);
  });

  test("nextPage then prevPage from 0 returns to 0", () => {
    let p = nextPage(g, P0);
    // A = 7 rows forward from 0 -> L3r0? rows: L0(2),L1(1),L2(3) = 6, +1 -> L3r0 is 7th row index... abs 7 -> L4r0? walk: advance 7: L0r0->after2 L1, after1 L2 (3), after3 L3 (6), take1 -> L3r1? wait
    // advance({0,0},7): L0 h2 take2 (k5) -> L1; take1 (k4) -> L2; L2 h3 take3 (k1) -> L3; L3 h1 take1 -> L4 row0. p={4,0}
    expect(p).toEqual(at(4, 0));
    p = prevPage(g, p);
    expect(p).toEqual(P0);
  });

  test("giant line 0 capped to pinCap rows", () => {
    const hg = geomOf([50, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], N);
    expect(isPaged(hg)).toBe(true);
    // at p>0, top pin shows pinCap = 2 rows of line 0
    const p = rowDown(hg, P0); // advance(0, h0p+2 = 4) -> {0,4}
    expect(p).toEqual(at(0, 4));
    const segs = layout(hg, p);
    expect(segs[0]).toEqual({ kind: "rows", line: 0, row: 0, rows: 2 });
    expect(segs[1]).toEqual({ kind: "bar", id: "top" });
    expect(segRowsTotal(segs)).toBe(N);
  });

  test("not paged when total rows <= N", () => {
    const small = geomOf([2, 1, 3, 1], 10); // total 7 <= 10
    expect(isPaged(small)).toBe(false);
    expect(layout(small, at(2, 1))).toEqual([
      { kind: "rows", line: 0, row: 0, rows: 7 },
    ]);
    expect(clampPos(small, at(2, 1))).toEqual(P0);
  });

  test("advance/retreat round-trip", () => {
    for (let k = 0; k <= total; k++) {
      const p = advance(g, P0, k);
      expect(retreat(g, p, k)).toEqual(P0);
    }
    expect(advance(g, P0, total + 5)).toEqual(at(23, 1)); // clamps to last row
    expect(retreat(g, at(g.L, 0), 1)).toEqual(at(23, 1)); // end pos
  });
});

// ---- 3. Property check ----

describe("property: rowDown monotonic, screen rows sum to N", () => {
  function* rng(seed: number) {
    let x = seed >>> 0 || 1;
    while (true) {
      x ^= x << 13; x >>>= 0;
      x ^= x >> 17;
      x ^= x << 5; x >>>= 0;
      yield x;
    }
  }

  test("random heights", () => {
    const rand = rng(0xC0FFEE);
    for (let t = 0; t < 300; t++) {
      const N = 5 + (rand.next().value % 11); // 5..15
      const L = 1 + (rand.next().value % 60); // 1..60
      const heights = Array.from({ length: L }, () => 1 + (rand.next().value % 5));
      const g = geomOf(heights, N);
      if (!isPaged(g)) continue;

      let p = P0;
      for (let guard = 0; guard < 10000; guard++) {
        const q = rowDown(g, p);
        const segs = layout(g, p);
        expect(segRowsTotal(segs)).toBe(N);
        if (q.line === p.line && q.row === p.row) break;
        // strictly forward
        expect(q.line > p.line || (q.line === p.line && q.row > p.row)).toBe(true);
        p = q;
      }
      // rowUp all the way back
      for (let guard = 0; guard < 10000; guard++) {
        const q = rowUp(g, p);
        if (q.line === p.line && q.row === p.row) break;
        p = q;
      }
      expect(p).toEqual(P0);
    }
  });
});
