import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ImagingForm } from '../health-passport/ImagingForm'
import type { ExtractedImagingData } from '@/lib/types'

describe('ImagingForm', () => {
  it('renders all fields with empty defaults', () => {
    render(<ImagingForm />)

    expect(screen.getByText('Imaging Report')).toBeInTheDocument()
    expect(screen.getByText('Modality')).toBeInTheDocument()
    expect(screen.getByText('Findings')).toBeInTheDocument()
    expect(screen.getByText('Conclusion / Impression')).toBeInTheDocument()
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('')
  })

  it('pre-fills from initialData', () => {
    const initial: ExtractedImagingData = {
      modality: 'CT',
      findings: 'Normal chest scan',
      conclusion: 'No abnormalities detected',
    }

    render(<ImagingForm initialData={initial} />)

    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('CT')
    expect(screen.getByDisplayValue('Normal chest scan')).toBeInTheDocument()
    expect(screen.getByDisplayValue('No abnormalities detected')).toBeInTheDocument()
  })

  it('calls onDataChange when modality changes', () => {
    const onDataChange = vi.fn()
    render(<ImagingForm onDataChange={onDataChange} />)

    const select = screen.getByRole('combobox')
    fireEvent.change(select, { target: { value: 'Ultrasound' } })

    expect(onDataChange).toHaveBeenCalledWith(
      expect.objectContaining({ modality: 'Ultrasound' }),
    )
  })

  it('calls onDataChange when findings change', () => {
    const onDataChange = vi.fn()
    render(<ImagingForm onDataChange={onDataChange} />)

    const textareas = screen.getAllByRole('textbox')
    fireEvent.change(textareas[0], { target: { value: 'Some findings' } })

    expect(onDataChange).toHaveBeenCalledWith(
      expect.objectContaining({ findings: 'Some findings' }),
    )
  })
})
