import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { ReferenceInput } from '../health-passport/reference-input'
import { TestI18nProvider } from '@/test/i18n-test-provider'

function renderInput(value: React.ComponentProps<typeof ReferenceInput>['value'], onChange = vi.fn()) {
  const ui = (v: React.ComponentProps<typeof ReferenceInput>['value']) => (
    <TestI18nProvider>
      <ReferenceInput value={v} onChange={onChange} />
    </TestI18nProvider>
  )
  const view = render(ui(value))
  return { onChange, rerender: (v: React.ComponentProps<typeof ReferenceInput>['value']) => view.rerender(ui(v)) }
}

describe('ReferenceInput external sync', () => {
  it('adopts an externally supplied reference (biomarker pick) and keeps it on the next edit', () => {
    const { onChange, rerender } = renderInput(null)

    // Picking a biomarker supplies the definition's reference from outside.
    rerender({ kind: 'interval', low: 4, high: 11 })

    expect(screen.getByDisplayValue('4')).toBeInTheDocument()
    expect(screen.getByDisplayValue('11')).toBeInTheDocument()

    // Switching to a one-sided type must keep the lower bound — it used to
    // emit `null` from the stale empty state, wiping the reference.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gt' } })

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'interval', low: 4 }),
    )
  })

  it('does not clobber in-progress typing with the value it echoed back', () => {
    const { onChange, rerender } = renderInput({ kind: 'interval', low: 1, high: 10 })

    const low = screen.getByDisplayValue('1')
    fireEvent.change(low, { target: { value: '1.5' } })

    const emitted = onChange.mock.calls.at(-1)?.[0] as { low: number } | null
    expect(emitted?.low).toBe(1.5)
    // Parent echoes the emitted object back — the input must keep "1.5".
    rerender(emitted as React.ComponentProps<typeof ReferenceInput>['value'])
    expect(screen.getByDisplayValue('1.5')).toBeInTheDocument()
  })
})
