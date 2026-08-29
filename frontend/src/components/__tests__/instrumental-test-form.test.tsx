import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InstrumentalTestForm } from '../health-passport/InstrumentalTestForm'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { ExtractedInstrumentalData } from '@/lib/types'

// Wrap renders with the i18n context (English) — InstrumentalTestForm uses useTranslations.
const renderI18n = ((ui: React.ReactElement, options?: Parameters<typeof render>[1]) =>
  render(<TestI18nProvider>{ui}</TestI18nProvider>, options)) as typeof render

describe('InstrumentalTestForm', () => {
  it('renders all fields with empty defaults', () => {
    renderI18n(<InstrumentalTestForm />)

    expect(screen.getByText('Instrumental Test Report')).toBeInTheDocument()
    expect(screen.getByText('Modality')).toBeInTheDocument()
    expect(screen.getByText('Findings')).toBeInTheDocument()
    expect(screen.getByText('Conclusion / Impression')).toBeInTheDocument()
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('')
  })

  it('pre-fills from initialData', () => {
    const initial: ExtractedInstrumentalData = {
      modality: 'CT',
      findings: 'Normal chest scan',
      conclusion: 'No abnormalities detected',
    }

    renderI18n(<InstrumentalTestForm initialData={initial} />)

    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('CT')
    expect(screen.getByDisplayValue('Normal chest scan')).toBeInTheDocument()
    expect(screen.getByDisplayValue('No abnormalities detected')).toBeInTheDocument()
  })

  it('calls onDataChange when modality changes', () => {
    const onDataChange = vi.fn()
    renderI18n(<InstrumentalTestForm onDataChange={onDataChange} />)

    const select = screen.getByRole('combobox')
    fireEvent.change(select, { target: { value: 'Elastography' } })

    expect(onDataChange).toHaveBeenCalledWith(
      expect.objectContaining({ modality: 'Elastography' }),
    )
  })

  it('calls onDataChange when findings change', () => {
    const onDataChange = vi.fn()
    renderI18n(<InstrumentalTestForm onDataChange={onDataChange} />)

    const textareas = screen.getAllByRole('textbox')
    fireEvent.change(textareas[0], { target: { value: 'Some findings' } })

    expect(onDataChange).toHaveBeenCalledWith(
      expect.objectContaining({ findings: 'Some findings' }),
    )
  })
})
