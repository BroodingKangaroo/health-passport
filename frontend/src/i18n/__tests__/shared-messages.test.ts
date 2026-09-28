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
      expect([...namespaces].sort(), locale).toEqual([
        // The full record's correlation chart (ST3) is the app's own
        // component, so these two arrive with it — the chart's copy and the
        // axis-mode toggle / gap annotation it renders.
        'charts',
        'common',
        'correlation',
        'misc',
        'sharedView',
        'statuses',
        'timeline',
      ])
    }
  })

  it('never ships sender, header, landing or auth copy', () => {
    const forbidden = [
      'share.',
      'header.',
      'landing.',
      'auth.',
      'print.',
      'settings.',
      'demo.',
    ]
    for (const locale of SUPPORTED_LOCALES) {
      const keys = flatten(sharedViewMessages(locale))
      for (const prefix of forbidden) {
        expect(keys.some((key) => key.startsWith(prefix)), `${locale}: ${prefix}`).toBe(false)
      }
    }
  })

  /**
   * `common` is the one namespace the shared view needs a single key from
   * (TimelineContent's loading line, now that the full record renders it).
   * Shipping the whole namespace would hand a stranger the app's "Sign out /
   * Save / Cancel" vocabulary, so the subset is pinned to that one key.
   */
  it('ships exactly one key from `common`', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const commonKeys = flatten(sharedViewMessages(locale)).filter((key) =>
        key.startsWith('common.'),
      )
      expect(commonKeys, locale).toEqual(['common.loading'])
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
    // The flags block renders the app's own status words (never colour alone).
    expect(keys).toContain('statuses.low')
    expect(keys).toContain('timeline.flowsheet.notMeasured')
    expect(keys).toContain('misc.scaleNote.needsReview')
  })
})
