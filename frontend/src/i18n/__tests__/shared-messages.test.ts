import { describe, expect, it } from 'vitest'

import { messages, SUPPORTED_LOCALES } from '@/i18n/messages'
import { sharedViewMessages } from '@/i18n/shared-messages'

function flatten(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix]
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix ? `${prefix}.${k}` : k),
  )
}

/**
 * The recipient page must not download the app's copy. These assertions are
 * the ones that fail when the subset silently widens.
 */
describe('shared view message subset', () => {
  it('ships exactly the namespaces the shared surface renders', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const namespaces = new Set(
        flatten(sharedViewMessages(locale)).map((key) => key.split('.')[0]),
      )
      expect([...namespaces].sort(), locale).toEqual(['misc', 'sharedView', 'timeline'])
    }
  })

  it('never ships sender, header, landing or auth copy', () => {
    const forbidden = ['share.', 'header.', 'landing.', 'auth.', 'print.', 'settings.', 'demo.']
    for (const locale of SUPPORTED_LOCALES) {
      const keys = flatten(sharedViewMessages(locale))
      for (const prefix of forbidden) {
        expect(keys.some((key) => key.startsWith(prefix)), `${locale}: ${prefix}`).toBe(false)
      }
    }
  })

  it('is a subset of the real catalog — no invented or reworded strings', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const full = new Set(flatten(messages[locale]))
      for (const key of flatten(sharedViewMessages(locale))) {
        expect(full.has(key), `${locale}:${key}`).toBe(true)
      }
    }
  })

  it('keeps the recipient, table and scale-marker strings the page renders', () => {
    const keys = flatten(sharedViewMessages('en'))
    expect(keys).toContain('sharedView.deadLink.title')
    expect(keys).toContain('sharedView.flags.title')
    expect(keys).toContain('timeline.flowsheet.notMeasured')
    expect(keys).toContain('misc.scaleNote.needsReview')
  })
})
