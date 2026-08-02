import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DoctorVisitForm } from '../health-passport/DoctorVisitForm'
import type { ExtractedVisitData } from '@/lib/types'

describe('DoctorVisitForm', () => {
  it('renders with empty initialData', () => {
    render(<DoctorVisitForm />)

    expect(screen.getByText('Clinical Notes')).toBeInTheDocument()
    expect(screen.getByText('Primary Diagnosis')).toBeInTheDocument()
    expect(screen.getByText('Chief Complaint & Subjective')).toBeInTheDocument()
    expect(screen.getByText('Objective Findings')).toBeInTheDocument()
    expect(screen.getByText('Prescriptions & Medications')).toBeInTheDocument()
    expect(screen.getByText('Recommendations')).toBeInTheDocument()
    expect(screen.getByText('Add Medication')).toBeInTheDocument()
    expect(screen.getByText('Add Recommendation')).toBeInTheDocument()
  })

  it('pre-fills from initialData', () => {
    const initial: ExtractedVisitData = {
      diagnosis: { original: 'Diabetes Type 2', translated_en: 'Diabetes Type 2' },
      chief_complaint: { original: 'Increased thirst and frequent urination', translated_en: 'Increased thirst and frequent urination' },
      objective_findings: { original: 'HbA1c 8.2%, BMI 32', translated_en: 'HbA1c 8.2%, BMI 32' },
      prescriptions: [
        { name: { original: 'Metformin', translated_en: 'Metformin' }, dosage: { original: '500mg', translated_en: '500mg' }, instructions: { original: 'Twice daily with meals', translated_en: 'Twice daily with meals' } },
      ],
      recommendations: [{ original: 'Monitor blood glucose daily', translated_en: 'Monitor blood glucose daily' }, { original: 'Dietary consultation', translated_en: 'Dietary consultation' }],
    }

    render(<DoctorVisitForm initialData={initial} />)

    expect(screen.getByDisplayValue('Diabetes Type 2')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Increased thirst and frequent urination')).toBeInTheDocument()
    expect(screen.getByDisplayValue('HbA1c 8.2%, BMI 32')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Metformin')).toBeInTheDocument()
    expect(screen.getByDisplayValue('500mg')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Twice daily with meals')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Monitor blood glucose daily')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Dietary consultation')).toBeInTheDocument()
  })

  it('calls onDataChange when diagnosis is typed', () => {
    const onDataChange = vi.fn()
    render(<DoctorVisitForm onDataChange={onDataChange} />)

    const textareas = screen.getAllByRole('textbox')
    fireEvent.change(textareas[0], { target: { value: 'Asthma' } })

    expect(onDataChange).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnosis: expect.objectContaining({ translated_en: 'Asthma' }),
      }),
    )
  })

  it('adds a prescription row when add medication is clicked', async () => {
    render(<DoctorVisitForm />)

    expect(screen.queryByPlaceholderText('Medication name')).not.toBeInTheDocument()
    const addBtn = screen.getByText('Add Medication')
    fireEvent.click(addBtn)

    expect(screen.getByPlaceholderText('Medication name')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Dosage')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Instructions')).toBeInTheDocument()
  })
})
