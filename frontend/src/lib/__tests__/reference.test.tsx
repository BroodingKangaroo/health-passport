import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { intervalReference, formatReference } from '@/lib/reference'
import { ReferenceInput } from '@/components/health-passport/reference-input'
import { TestI18nProvider } from '@/test/i18n-test-provider'

describe('intervalReference NaN guard (ISSUES.md #64)', () => {
  it('sanitizes non-finite bounds to null', () => {
    expect(intervalReference(Number.NaN, 5)).toEqual({ kind: 'interval', low: null, high: 5 })
    expect(intervalReference(4, Number.NaN)).toEqual({ kind: 'interval', low: 4, high: null })
    expect(intervalReference(Number.NaN, Number.NaN)).toBeNull()
    expect(intervalReference(Number.POSITIVE_INFINITY, 5)).toEqual({
      kind: 'interval',
      low: null,
      high: 5,
    })
  })

  it('keeps finite bounds untouched', () => {
    expect(intervalReference(4, 11)).toEqual({ kind: 'interval', low: 4, high: 11 })
    expect(intervalReference(null, 11)).toEqual({ kind: 'interval', low: null, high: 11 })
  })

  it('a NaN low bound no longer renders as "NaN – 5"', () => {
    expect(formatReference(intervalReference(Number.NaN, 5))).toBe('≤ 5')
    expect(formatReference(intervalReference(4, Number.NaN))).toBe('≥ 4')
  })
})

describe('ReferenceInput emits nothing for non-numeric bounds (ISSUES.md #64)', () => {
  function renderInput() {
    const onChange = vi.fn()
    const view = render(
      <TestI18nProvider>
        <ReferenceInput value={null} onChange={onChange} />
      </TestI18nProvider>,
    )
    // Switch to the two-sided interval type; the two bound inputs follow.
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'interval' } })
    const [lo, hi] = Array.from(view.container.querySelectorAll('input'))
    return { onChange, lo: lo as HTMLInputElement, hi: hi as HTMLInputElement }
  }

  it('two-sided with a non-numeric low bound emits null', () => {
    const { onChange, lo, hi } = renderInput()
    fireEvent.change(lo, { target: { value: 'abc' } })
    fireEvent.change(hi, { target: { value: '5' } })
    expect(onChange.mock.calls.at(-1)?.[0]).toBeNull()
  })

  it('two-sided with a non-numeric high bound emits null', () => {
    const { onChange, lo, hi } = renderInput()
    fireEvent.change(lo, { target: { value: '4' } })
    fireEvent.change(hi, { target: { value: 'abc' } })
    expect(onChange.mock.calls.at(-1)?.[0]).toBeNull()
  })

  it('two-sided with both bounds numeric still emits the interval', () => {
    const { onChange, lo, hi } = renderInput()
    fireEvent.change(lo, { target: { value: '4' } })
    fireEvent.change(hi, { target: { value: '11' } })
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ kind: 'interval', low: 4, high: 11 })
  })
})
