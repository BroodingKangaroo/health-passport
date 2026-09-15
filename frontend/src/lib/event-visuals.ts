import type { ComponentType } from 'react'
import { Droplet, Stethoscope, Brain, Syringe, FileQuestion } from 'lucide-react'

import type { EventType } from './types'

/**
 * Single source for event-type → visual presentation (roadmap 0.6, timeline
 * scannability), mirroring the status-labels.ts precedent for statuses.
 *
 * CHANNEL CONTRACT — the two color channels must never be mixed:
 *   - Type colors (this module) are CATEGORICAL: they paint icon bubbles,
 *     timeline rail nodes, filter-chip dots, and detail-view header chips
 *     ONLY — never status-bearing text (values, badges, arrows).
 *   - Status colors (STATUS_TEXT_CLASS / Badge variants) are SEMANTIC:
 *     low/high/abnormal always mean out-of-range, in any view.
 *   - The primary accent is INTERACTION: selection, hover, focus, CTAs —
 *     never a type identity.
 * Type is additionally always encoded by icon shape + label, never by color
 * alone (a11y). Tokens live in globals.css (`--event-*`, light + .dark +
 * prefers-color-scheme fallback).
 */
export interface EventTypeVisual {
  icon: ComponentType<{ className?: string }>
  /** Tinted bubble + colored icon (history list, detail headers). */
  bubbleClass: string
  /** Solid fill for timeline rail nodes. */
  nodeClass: string
  /** Small solid dot for filter chips / legends. */
  dotClass: string
  /** Colored icon on neutral background (e.g. settings rows). */
  textClass: string
  /** Identity chip next to detail-view headers (border + bg + text). */
  chipClass: string
  /** Message-key suffix shared by the `timeline.historyList` (plural) and
      `timeline.entrySettings` (singular) namespaces, e.g. `typeBloodTest`. */
  labelKey: string
  /** Message-key suffix for the COMPACT filter-chip labels
      (`timeline.historyList.chip*`) — short forms that keep the chip row to
      one line in both locales (e.g. RU «Обследования» instead of
      «Инструментальные исследования»). */
  chipLabelKey: string
}

export const TYPE_VISUALS: Record<EventType, EventTypeVisual> = {
  blood_test: {
    icon: Droplet,
    bubbleClass: 'bg-event-blood-test-bg text-event-blood-test',
    nodeClass: 'bg-event-blood-test',
    dotClass: 'bg-event-blood-test',
    textClass: 'text-event-blood-test',
    chipClass: 'border-event-blood-test/30 bg-event-blood-test-bg text-event-blood-test',
    labelKey: 'typeBloodTest',
    chipLabelKey: 'chipBloodTest',
  },
  doctor_visit: {
    icon: Stethoscope,
    bubbleClass: 'bg-event-doctor-visit-bg text-event-doctor-visit',
    nodeClass: 'bg-event-doctor-visit',
    dotClass: 'bg-event-doctor-visit',
    textClass: 'text-event-doctor-visit',
    chipClass: 'border-event-doctor-visit/30 bg-event-doctor-visit-bg text-event-doctor-visit',
    labelKey: 'typeDoctorVisit',
    chipLabelKey: 'chipDoctorVisit',
  },
  instrumental_test: {
    icon: Brain,
    bubbleClass: 'bg-event-instrumental-test-bg text-event-instrumental-test',
    nodeClass: 'bg-event-instrumental-test',
    dotClass: 'bg-event-instrumental-test',
    textClass: 'text-event-instrumental-test',
    chipClass:
      'border-event-instrumental-test/30 bg-event-instrumental-test-bg text-event-instrumental-test',
    labelKey: 'typeInstrumentalTest',
    chipLabelKey: 'chipInstrumentalTest',
  },
  procedure: {
    icon: Syringe,
    bubbleClass: 'bg-event-procedure-bg text-event-procedure',
    nodeClass: 'bg-event-procedure',
    dotClass: 'bg-event-procedure',
    textClass: 'text-event-procedure',
    chipClass: 'border-event-procedure/30 bg-event-procedure-bg text-event-procedure',
    labelKey: 'typeProcedure',
    chipLabelKey: 'chipProcedure',
  },
}

/**
 * Neutral presentation for an event type this build does not know (legacy
 * rows persisted before entry-type validation, or a newer backend). Kept
 * OUT of ``TYPE_VISUALS`` on purpose: the type inventory is guarded by
 * event-visuals.test.ts, and an unknown type must never receive a
 * categorical ``--event-*`` token (the channel contract reserves those for
 * the four real types). Uses only semantic muted tokens.
 */
export const UNKNOWN_EVENT_VISUAL: EventTypeVisual = {
  icon: FileQuestion,
  bubbleClass: 'bg-muted text-muted-foreground',
  nodeClass: 'bg-muted-foreground',
  dotClass: 'bg-muted-foreground',
  textClass: 'text-muted-foreground',
  chipClass: 'border-border bg-muted text-muted-foreground',
  labelKey: 'typeUnknown',
  chipLabelKey: 'chipUnknown',
}

/**
 * Safe lookup for types that arrive from the API (untyped at runtime): falls
 * back to the neutral visual instead of crashing the whole timeline on
 * ``TYPE_VISUALS[event.type].icon`` for an unexpected value.
 */
export function eventVisual(type: string): EventTypeVisual {
  const known = TYPE_VISUALS as Partial<Record<string, EventTypeVisual>>
  return known[type] ?? UNKNOWN_EVENT_VISUAL
}
