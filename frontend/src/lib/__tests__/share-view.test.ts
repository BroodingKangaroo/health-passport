import { describe, expect, it } from 'vitest'

import { parseSharedView, sharedViewHref } from '@/lib/share'

describe('parseSharedView', () => {
  it('defaults to the summary', () => {
    expect(parseSharedView(undefined)).toBe('summary')
    expect(parseSharedView(null)).toBe('summary')
    expect(parseSharedView('')).toBe('summary')
  })

  it('accepts the full record', () => {
    expect(parseSharedView('full')).toBe('full')
  })

  it('treats anything unrecognised as the default instead of failing', () => {
    // A hand-edited or stale URL must render something, and the summary is the
    // safe answer: it is the view that stands on its own.
    expect(parseSharedView('FULL')).toBe('summary')
    expect(parseSharedView('nonsense')).toBe('summary')
    // A repeated parameter arrives as an array; the first wins, like the
    // `lang` handling on the same route.
    expect(parseSharedView(['full', 'summary'])).toBe('full')
    expect(parseSharedView(['summary', 'full'])).toBe('summary')
  })
})

describe('sharedViewHref', () => {
  it('writes the view explicitly so a copied URL says what it opens', () => {
    expect(sharedViewHref('hp_tok', 'summary')).toBe('/s/hp_tok?view=summary')
    expect(sharedViewHref('hp_tok', 'full')).toBe('/s/hp_tok?view=full')
  })

  it('keeps the language when both are set', () => {
    expect(sharedViewHref('hp_tok', 'full', 'ru')).toBe('/s/hp_tok?lang=ru&view=full')
    // A null/absent language leaves no empty parameter behind.
    expect(sharedViewHref('hp_tok', 'summary', null)).toBe('/s/hp_tok?view=summary')
  })
})
