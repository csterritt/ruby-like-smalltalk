export interface ColumnLayout {
  rows: number;
  colWidths: number[];
}

export function layoutColumns(
  names: string[],
  widths: number[],
  available: number,
  gap: number
): ColumnLayout {
  const n = names.length;
  if (n === 0) return { rows: 0, colWidths: [] };

  for (let rows = 1; rows <= n; rows++) {
    const cols = Math.ceil(n / rows);
    if ((cols - 1) * rows >= n) continue; // empty trailing column
    const colWidths = new Array<number>(cols).fill(0);
    for (let i = 0; i < n; i++) {
      const c = Math.floor(i / rows);
      if (widths[i] > colWidths[c]) colWidths[c] = widths[i];
    }
    const total = colWidths.reduce((a, b) => a + b, 0) + gap * (cols - 1);
    if (total <= available) return { rows, colWidths };
  }

  // Nothing fits: single column.
  let widest = 0;
  for (const w of widths) if (w > widest) widest = w;
  return { rows: n, colWidths: [widest] };
}
