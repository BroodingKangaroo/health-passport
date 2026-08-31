import type { KeyboardEvent } from 'react'

/**
 * Keyboard activation for clickable non-button rows (ISSUES.md #70): rows
 * whose only activation path is an onClick on a <div> are unreachable by
 * keyboard. Pair this handler with role="button" + tabIndex={0} so Enter and
 * Space trigger the same action a click does.
 */
export function activateOnKey(e: KeyboardEvent, action: () => void): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    action()
  }
}
