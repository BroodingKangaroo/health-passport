import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ModalDialog } from '../ui/modal-dialog'

function FocusHarness() {
  const [count, setCount] = useState(0)
  return (
    <div>
      <span data-testid="count">{count}</span>
      {/* fireEvent.click does not move focus in jsdom, so this re-renders the
          parent while the input keeps focus. */}
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        bump
      </button>
      {/* Inline arrow, like every production caller: the effect must not
          re-run (and re-focus the panel) when the parent re-renders. */}
      <ModalDialog open onClose={() => {}}>
        <input data-testid="field" />
      </ModalDialog>
    </div>
  )
}

function EscapeHarness({ onClose }: { onClose: () => void }) {
  return (
    <ModalDialog open onClose={onClose}>
      <input data-testid="field" />
    </ModalDialog>
  )
}

describe('ModalDialog', () => {
  it('focuses the panel initially and keeps focus across parent re-renders', () => {
    render(<FocusHarness />)
    const panel = screen.getByRole('dialog')
    expect(document.activeElement).toBe(panel)

    const field = screen.getByTestId('field')
    field.focus()
    expect(document.activeElement).toBe(field)

    fireEvent.click(screen.getByRole('button', { name: 'bump' }))
    expect(screen.getByTestId('count')).toHaveTextContent('1')
    // The old [open, onClose] dependency re-ran the effect on the parent
    // render and yanked focus back to the panel.
    expect(document.activeElement).toBe(field)
  })

  it('calls the LATEST onClose on Escape after a parent re-render', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<EscapeHarness onClose={first} />)
    rerender(<EscapeHarness onClose={second} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
