/**
 * How many date columns of a printed document fit on one page.
 *
 * A browser does not paginate a table horizontally: when the matrix is wider
 * than the paper, Chromium scales the page down to its floor and then CLIPS
 * the rest. The recipient's editor used to select every date column, so a
 * 27-column record produced an 1,835px table on a ~780px page and every page
 * was cut at the same mid-column point — the ten newest columns, including
 * the reading the summary flags, appeared on no page of the sheet a doctor
 * hands to a colleague (whole-change review, item 1).
 *
 * The budget is the printable width of a portrait page in CSS pixels, not the
 * `max-w-3xl` the document is previewed in: print drops that cap
 * (`print:max-w-none print:p-0`) and the paper decides. A4 is 794px at 96dpi
 * and Letter 816px, with no page margin in this stylesheet, so 780 keeps a
 * few pixels of slack for the narrower of the two.
 */
export const PRINT_PAGE_CONTENT_WIDTH = 780

/**
 * Keep the newest columns that fit, given the min-content width of each.
 *
 * `columnWidths[0]` is the biomarker-name column; the rest are date columns in
 * the document's own left-to-right (ascending date) order, which is what puts
 * the newest readings on the right and what makes "drop from the left" the
 * right way to shrink the sheet. At least one date column is always kept: an
 * empty document says nothing, and a reader can page through two sheets more
 * easily than they can read a blank one.
 */
export function fittingColumnCount(
  columnWidths: number[],
  budget: number = PRINT_PAGE_CONTENT_WIDTH,
): number {
  if (columnWidths.length <= 1) return 0
  const total = columnWidths.reduce((sum, w) => sum + w, 0)
  if (total <= budget) return columnWidths.length - 1
  let kept = 0
  let width = columnWidths[0]
  for (let i = columnWidths.length - 1; i >= 1; i--) {
    if (width + columnWidths[i] > budget) break
    width += columnWidths[i]
    kept++
  }
  return Math.max(1, kept)
}

/** Whether a rendered document is wider than the page it will be printed on. */
export function overflowsPage(
  columnWidths: number[],
  budget: number = PRINT_PAGE_CONTENT_WIDTH,
): boolean {
  if (columnWidths.length === 0) return false
  return columnWidths.reduce((sum, w) => sum + w, 0) > budget
}

/**
 * The min-content width of each column of a rendered document table.
 *
 * Measured from a hidden clone, not from the live table: on screen the table
 * is inside a container wide enough that `w-full` stretches it, so the live
 * widths say nothing about the paper. The clone is laid out in a 1px box,
 * where a table can only be as wide as its content requires — that width IS
 * the min-content, and it is what `@page` will have to hold.
 */
export function measureColumnWidths(table: HTMLTableElement): number[] {
  if (typeof document === 'undefined') return []
  const holder = document.createElement('div')
  holder.style.cssText =
    'position:absolute;left:-99999px;top:0;width:1px;visibility:hidden;'
  const clone = table.cloneNode(true) as HTMLTableElement
  // The document's font size is set on an ancestor, which a detached clone
  // does not inherit — without this every measurement would be off by the
  // reader's text-size setting.
  clone.style.fontSize = window.getComputedStyle(table).fontSize
  holder.appendChild(clone)
  document.body.appendChild(holder)
  try {
    return [...clone.querySelectorAll('thead th')].map(
      (th) => th.getBoundingClientRect().width,
    )
  } finally {
    holder.remove()
  }
}
