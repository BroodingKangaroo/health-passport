import { describe, expect, it } from 'vitest'

import {
  fittingColumnCount,
  overflowsPage,
  PRINT_PAGE_CONTENT_WIDTH,
} from '@/components/share/print-fit'

/**
 * Item 1 of the whole-change review: the recipient's document printed four
 * pages that all cut at the same mid-column point, so the newest ten columns —
 * including the reading the summary flags — were on no page at all.
 *
 * These pin the arithmetic that decides what the page can hold. The numbers
 * are the ones measured from the real record: a 27-column document is 1,835px
 * wide against a ~780px page, and the name column measured 156px.
 */
describe('fittingColumnCount', () => {
  const NAME = 156
  /** 26 date columns, the real record's width, oldest first. */
  const dateWidths = [
    75, 55, 43, 85, 85, 85, 45, 43, 85, 42, 77, 77, 77, 77, 41, 34, 75, 77,
    41, 99, 45, 42, 45, 99, 85, 45,
  ]

  it('keeps every date column when the whole table fits', () => {
    expect(fittingColumnCount([NAME, 100, 100])).toBe(2)
  })

  it('drops the OLDEST columns, keeping the newest readings', () => {
    const widths = [NAME, ...dateWidths]
    const keep = fittingColumnCount(widths)
    // Every kept column fits, and adding the next-oldest one would not.
    const keptTotal =
      NAME + dateWidths.slice(-keep).reduce((a, b) => a + b, 0)
    const nextOldest = dateWidths[dateWidths.length - keep - 1]
    expect(keep).toBeGreaterThan(0)
    expect(keptTotal).toBeLessThanOrEqual(PRINT_PAGE_CONTENT_WIDTH)
    expect(keptTotal + nextOldest).toBeGreaterThan(PRINT_PAGE_CONTENT_WIDTH)
  })

  it('always keeps at least one date column', () => {
    // A page cannot hold even one column: an empty document would say less
    // than a cut one, and the editor warns about the overflow separately.
    expect(fittingColumnCount([700, 200, 200])).toBe(1)
  })

  it('has nothing to keep when there are no date columns', () => {
    expect(fittingColumnCount([NAME])).toBe(0)
    expect(fittingColumnCount([])).toBe(0)
  })
})

describe('overflowsPage', () => {
  it('is false for a document the page can hold', () => {
    expect(overflowsPage([156, 100, 100])).toBe(false)
  })

  it('is true once the columns exceed the printable width', () => {
    expect(overflowsPage([156, ...Array(27).fill(75)])).toBe(true)
  })

  it('treats an unrendered table as fitting', () => {
    expect(overflowsPage([])).toBe(false)
  })
})
