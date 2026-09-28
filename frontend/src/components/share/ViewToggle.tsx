'use client'

import { useTranslations } from 'next-intl'
import { List, Table2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { SharedView } from '@/lib/share'

interface ViewToggleProps {
  view: SharedView
  /** Where each option goes with JavaScript disabled — a real, shareable URL. */
  hrefFor: (view: SharedView) => string
  /**
   * In-place switch. The shared shell always provides it: the payload for both
   * views is already loaded, and a full navigation would throw away the scroll
   * position and re-fetch the flowsheet.
   */
  onSelect: (view: SharedView) => void
}

/**
 * The Summary | Full record segmented control (shared-view plan §1).
 *
 * A pair of plain `<a>` elements rather than buttons: with JavaScript off (or
 * before hydration) each one is an ordinary link to `?view=…`, so the control
 * works either way. With JavaScript on, the click is intercepted and the view
 * switches in place.
 *
 * Deliberately NOT a `<Link>`: this is not a route change, so a client-side
 * router navigation would be wasted work on a control that only re-renders
 * already-loaded data. (Note `next/link` is not banned from the shared tree —
 * the language switch uses it; only the CTA is held to a plain anchor, for its
 * own counting reason.)
 */
export function ViewToggle({ view, hrefFor, onSelect }: ViewToggleProps) {
  const t = useTranslations('sharedView.viewSwitch')
  const options: { value: SharedView; label: string; Icon: typeof List }[] = [
    { value: 'summary', label: t('summary'), Icon: List },
    { value: 'full', label: t('full'), Icon: Table2 },
  ]
  return (
    <div
      role="group"
      aria-label={t('label')}
      data-testid="shared-view-toggle"
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5 print:hidden"
    >
      {options.map((option) => {
        const active = option.value === view
        const Icon = option.Icon
        return (
          <a
            key={option.value}
            href={hrefFor(option.value)}
            aria-current={active ? 'page' : undefined}
            data-state={active ? 'active' : 'idle'}
            onClick={(event) => {
              // Modified clicks (new tab, save link) keep their browser
              // meaning: the href is a real URL, so let them through.
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
              // Fall back to the link's own navigation where history cannot be
              // updated (jsdom, ancient browsers) rather than doing nothing.
              if (
                typeof window !== 'undefined' &&
                typeof window.history?.pushState === 'function'
              ) {
                event.preventDefault()
                onSelect(option.value)
              }
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {option.label}
          </a>
        )
      })}
    </div>
  )
}
