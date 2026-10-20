/**
 * Fixed-width table rendering.
 *
 * Columns are sized to their widest cell so the output stays aligned when it
 * is pasted into a terminal or a markdown table.
 */

export interface Table {
  headers: string[]
  rows: string[][]
}

function visibleWidth(cell: string): number {
  // Count characters, not bytes: a box-drawing or emoji cell should not skew
  // the column. Combining marks are counted as zero.
  let width = 0
  for (const char of cell) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x0300 && code <= 0x036f) continue
    width += 1
  }
  return width
}

function pad(cell: string, width: number): string {
  const fill = Math.max(0, width - visibleWidth(cell))
  return cell + " ".repeat(fill)
}

/** Renders a table with a header rule. Empty rows still print the header. */
export function renderTable(table: Table): string {
  const widths = table.headers.map((header, column) =>
    Math.max(visibleWidth(header), ...table.rows.map((row) => visibleWidth(row[column] ?? ""))),
  )

  const line = (cells: string[]): string =>
    cells.map((cell, column) => pad(cell ?? "", widths[column]!)).join("  ").trimEnd()

  const out = [line(table.headers), widths.map((width) => "-".repeat(width)).join("  ")]
  for (const row of table.rows) out.push(line(row))
  return out.join("\n")
}
