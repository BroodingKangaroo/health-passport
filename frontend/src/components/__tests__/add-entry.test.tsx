import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AddEntry } from '../health-passport/add-entry'
import type { StandardizedMedicalRecord } from '@/lib/types'

const mockExtract = vi.fn()
const mockSave = vi.fn()
const mockFetchByDate = vi.fn().mockResolvedValue({ date: '2026-10-12', count: 0 })
const mockFetchDefinitions = vi.fn().mockResolvedValue([])

vi.mock('@/services/api', () => ({
  extractMedicalData: (...args: any[]) => mockExtract(...args),
  saveMedicalEntry: (...args: any[]) => mockSave(...args),
  fetchEntriesByDate: (...args: any[]) => mockFetchByDate(...args),
  fetchBiomarkerDefinitions: (...args: any[]) => mockFetchDefinitions(...args),
}))

function createFile(name = 'lab.pdf', type = 'application/pdf', content = 'fake'): File {
  return new File([content], name, { type })
}

function selectFile(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AddEntry', () => {
  it('renders idle upload state', () => {
    render(<AddEntry onSave={vi.fn()} />)

    expect(screen.getByText('Add New Medical Record')).toBeInTheDocument()
    expect(screen.getByText('Skip Upload & Enter Manually')).toBeInTheDocument()
    expect(screen.getByText(/click to browse/i)).toBeInTheDocument()
  })

  it('switches to manual entry when skip upload is clicked', async () => {
    render(<AddEntry onSave={vi.fn()} />)
    fireEvent.click(screen.getByText('Skip Upload & Enter Manually'))

    await waitFor(() => {
      expect(screen.getByText('Blood Test Panel')).toBeInTheDocument()
    })
    expect(screen.getByText('Save to HealthPassport')).toBeInTheDocument()
  })

  it('shows scanning state while extracting', () => {
    mockExtract.mockImplementation(
      () => new Promise(() => {}),
    )

    const { container } = render(<AddEntry onSave={vi.fn()} />)
    selectFile(container, createFile())

    expect(screen.getByText('Scanning documents...')).toBeInTheDocument()
  })

  it('pre-fills blood test form from AI data', async () => {
    const aiResult: StandardizedMedicalRecord = {
      entry_type: 'blood_test',
      date: '2026-07-15',
      time: null,
      clinic: 'Test Lab',
      provider: 'Dr. House',
      title: 'Annual Panel',
      notes: 'Fasted 12h',
      biomarkers: [
        {
          raw_name: 'Hemoglobin', raw_value: '145', raw_unit: 'g/L', raw_range_string: '130-170',
          standard_name_en: 'Hemoglobin', standard_value: 145, standard_unit: 'g/L',
          standard_range_min: 130, standard_range_max: 170,
          status: 'normal', category: 'Complete Blood Count',
        },
        {
          raw_name: 'WBC', raw_value: '7.2', raw_unit: 'K/µL', raw_range_string: '4.0-11.0',
          standard_name_en: 'WBC', standard_value: 7.2, standard_unit: 'K/µL',
          standard_range_min: 4, standard_range_max: 11,
          status: 'normal', category: 'Complete Blood Count',
        },
        {
          raw_name: 'LDL', raw_value: '110', raw_unit: 'mg/dL', raw_range_string: '0-130',
          standard_name_en: 'LDL', standard_value: 110, standard_unit: 'mg/dL',
          standard_range_min: 0, standard_range_max: 130,
          status: 'normal', category: 'Lipid Panel',
        },
      ],
      visit_data: null,
      imaging_data: null,
    }
    mockExtract.mockResolvedValue(aiResult)

    const { container } = render(<AddEntry onSave={vi.fn()} />)
    selectFile(container, createFile())

    await waitFor(() => {
      expect(screen.getByText('Blood Test Panel')).toBeInTheDocument()
    })

    expect(screen.getByDisplayValue('2026-07-15')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Test Lab')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Dr. House')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Annual Panel')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Fasted 12h')).toBeInTheDocument()
    expect(screen.getByDisplayValue('145')).toBeInTheDocument()
    expect(screen.getByDisplayValue('g/L')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Complete Blood Count')).toBeInTheDocument()
    expect(screen.getAllByText('Hemoglobin').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('LDL').length).toBeGreaterThanOrEqual(1)
  })

  it('pre-fills doctor visit form from AI data', async () => {
    const aiResult: StandardizedMedicalRecord = {
      entry_type: 'doctor_visit',
      date: '2026-07-10',
      clinic: 'City Clinic',
      provider: 'Dr. Wilson',
      title: null,
      notes: null,
      biomarkers: null,
      visit_data: {
        diagnosis: 'Hypertension',
        chief_complaint: 'Headaches for 2 weeks',
        objective_findings: 'BP 150/95',
        prescriptions: [{ name: 'Lisinopril', dosage: '10mg', instructions: 'Once daily' }],
        recommendations: ['Reduce sodium', 'Exercise daily'],
      },
      imaging_data: null,
    }
    mockExtract.mockResolvedValue(aiResult)

    const { container } = render(<AddEntry onSave={vi.fn()} />)
    selectFile(container, createFile())

    await waitFor(() => {
      expect(screen.getByText('Doctor Visit / Clinical Notes')).toBeInTheDocument()
    })

    expect(screen.getByDisplayValue('Hypertension')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Headaches for 2 weeks')).toBeInTheDocument()
    expect(screen.getByDisplayValue('BP 150/95')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Lisinopril')).toBeInTheDocument()
    expect(screen.getByDisplayValue('10mg')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Once daily')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Reduce sodium')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Exercise daily')).toBeInTheDocument()
  })

  it('pre-fills imaging form from AI data', async () => {
    const aiResult: StandardizedMedicalRecord = {
      entry_type: 'imaging',
      date: '2026-07-20',
      clinic: 'Rad Center',
      provider: 'Dr. Grey',
      title: null,
      notes: null,
      biomarkers: null,
      visit_data: null,
      imaging_data: {
        modality: 'MRI',
        findings: 'Mild degeneration L4-L5',
        conclusion: 'No acute pathology',
      },
    }
    mockExtract.mockResolvedValue(aiResult)

    const { container } = render(<AddEntry onSave={vi.fn()} />)
    selectFile(container, createFile())

    await waitFor(() => {
      expect(screen.getByText('MRI / Imaging Scan')).toBeInTheDocument()
    })

    const select = screen.getByDisplayValue('MRI') as HTMLSelectElement
    expect(select.value).toBe('MRI')
    expect(screen.getByDisplayValue('Mild degeneration L4-L5')).toBeInTheDocument()
    expect(screen.getByDisplayValue('No acute pathology')).toBeInTheDocument()
  })

  it('falls back to manual entry on API error', async () => {
    mockExtract.mockRejectedValue(new Error('API unavailable'))

    const { container } = render(<AddEntry onSave={vi.fn()} />)
    selectFile(container, createFile())

    await waitFor(() => {
      expect(screen.getByText('AI extraction failed')).toBeInTheDocument()
    })
    expect(
      screen.getByText('Switched to manual entry. Fill in the details below.'),
    ).toBeInTheDocument()
  })
})
