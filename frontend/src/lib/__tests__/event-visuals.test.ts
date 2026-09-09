import { describe, expect, it } from 'vitest'
import { TYPE_VISUALS } from '../event-visuals'
import type { EventType } from '../types'

/**
 * Structural guard for the channel contract (roadmap 0.6): type colors are
 * categorical and distinct; they must never reuse a status token, and every
 * type must carry its own icon + label key (color is never the only signal).
 */
describe('TYPE_VISUALS', () => {
  const ALL_TYPES: EventType[] = ['blood_test', 'doctor_visit', 'instrumental_test', 'procedure']

  it('covers every event type', () => {
    expect(Object.keys(TYPE_VISUALS).sort()).toEqual([...ALL_TYPES].sort())
  })

  it('gives each type a distinct color token base', () => {
    const bases = ALL_TYPES.map((type) => {
      const match = TYPE_VISUALS[type].nodeClass.match(/^bg-([\w-]+)$/)
      expect(match, `nodeClass for ${type} must be a single bg-* token`).not.toBeNull()
      return match![1]
    })
    expect(new Set(bases).size).toBe(ALL_TYPES.length)
    for (const base of bases) {
      expect(base.startsWith('event-')).toBe(true)
      // The channel contract: no type token may collide with a status token.
      expect(base.startsWith('status-')).toBe(false)
    }
  })

  it('never lets any class field drift onto a status token (channel contract)', () => {
    const fields = [
      'bubbleClass',
      'nodeClass',
      'dotClass',
      'textClass',
      'chipClass',
    ] as const
    for (const type of ALL_TYPES) {
      for (const field of fields) {
        expect(
          TYPE_VISUALS[type][field],
          `${type}.${field} must not use status tokens`,
        ).not.toContain('status-')
      }
    }
  })

  it('gives each type a distinct icon and label key', () => {
    const icons = new Set(ALL_TYPES.map((type) => TYPE_VISUALS[type].icon))
    const labels = new Set(ALL_TYPES.map((type) => TYPE_VISUALS[type].labelKey))
    expect(icons.size).toBe(ALL_TYPES.length)
    expect(labels.size).toBe(ALL_TYPES.length)
  })
})
