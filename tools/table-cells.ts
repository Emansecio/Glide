export type TableCellSpec = { text: string; colspan: number; rowspan: number };

export type RowspanSlot = { text: string; rowsLeft: number } | null;

/** Expand one table row honoring colspan and rowspan carry-over into subsequent rows. */
export function expandTableRowCells(
  cells: TableCellSpec[],
  carry: RowspanSlot[],
): { row: string[]; nextCarry: RowspanSlot[] } {
  const row: string[] = [];
  let col = 0;
  const nextCarry: RowspanSlot[] = [...carry];

  const ensureCarry = (idx: number) => {
    while (nextCarry.length <= idx) nextCarry.push(null);
  };

  const consumeCarry = () => {
    while (col < nextCarry.length && nextCarry[col]) {
      const slot = nextCarry[col]!;
      row.push(slot.text);
      nextCarry[col] = slot.rowsLeft <= 1 ? null : { text: slot.text, rowsLeft: slot.rowsLeft - 1 };
      col += 1;
    }
  };

  for (const cell of cells) {
    consumeCarry();
    const colspan = Math.max(1, cell.colspan);
    const rowspan = Math.max(1, cell.rowspan);
    for (let i = 0; i < colspan; i += 1) {
      row.push(cell.text);
      ensureCarry(col + i);
      if (rowspan > 1) {
        nextCarry[col + i] = { text: cell.text, rowsLeft: rowspan - 1 };
      }
    }
    col += colspan;
  }
  consumeCarry();
  return { row, nextCarry };
}
