'use client'

import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Lightweight accessible modal overlay (ISSUES.md #69): `role="dialog"` +
 * `aria-modal="true"` + `aria-labelledby`, Escape-to-close, a Tab focus trap
 * with initial focus on the panel, and optional backdrop-click dismissal.
 * All custom dialogs must render through this so keyboard and screen-reader
 * users get the same semantics.
 *
 * `open=false` renders nothing (early returns inside dialogs stay hook-safe).
 */
export function ModalDialog({
  open,
  onClose,
  labelledBy,
  children,
  closeOnBackdrop = false,
  panelClassName = '',
}: {
  open: boolean
  /** Called on Escape (and on backdrop click when `closeOnBackdrop`). */
  onClose?: () => void
  /** id of the element that labels the dialog (usually the heading). */
  labelledBy?: string
  children: ReactNode
  closeOnBackdrop?: boolean
  panelClassName?: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    // Initial focus goes to the panel itself: focusable children keep their
    // natural order, and the trap below keeps Tab cycling inside.
    panel?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panel) return
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null)
      if (focusables.length === 0) {
        e.preventDefault()
        panel.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }
    // Capture phase on window so the trap wins over unrelated listeners and
    // works no matter which element holds focus.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  const handleBackdrop = (e: MouseEvent<HTMLDivElement>) => {
    if (closeOnBackdrop && onClose && e.target === e.currentTarget) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleBackdrop}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`mx-4 w-full outline-none ${panelClassName}`}
      >
        {children}
      </div>
    </div>
  )
}
