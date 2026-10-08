import { stripVTControlCharacters } from "node:util";

export interface Column<T> {
  header: string;
  get: (row: T) => string;
  max?: number;
}

const GAP = "  ";

function visibleLength(text: string): number {
  return stripVTControlCharacters(text).length;
}

function fit(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  const plain = stripVTControlCharacters(text);
  return width <= 1 ? "…" : `${plain.slice(0, width - 1)}…`;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

export function renderTable<T>(columns: Array<Column<T>>, rows: T[], width: number): string {
  const cells = rows.map((row) => columns.map((column) => column.get(row).replace(/\s*\n\s*/g, " ")));
  const widths = columns.map((column, index) => Math.min(
    Math.max(column.header.length, ...cells.map((row) => visibleLength(row[index]!))),
    column.max ?? Number.POSITIVE_INFINITY,
  ));
  const lastIndex = widths.length - 1;
  const fixed = widths.slice(0, -1).reduce((sum, w) => sum + w + GAP.length, 0);
  widths[lastIndex] = Math.max(1, Math.min(widths[lastIndex]!, width - fixed));
  const line = (values: string[]) => values
    .map((value, index) => {
      const cell = fit(value, widths[index]!);
      return index === lastIndex ? cell : pad(cell, widths[index]!);
    })
    .join(GAP)
    .trimEnd();
  return [line(columns.map((column) => column.header)), ...cells.map(line)].join("\n");
}
