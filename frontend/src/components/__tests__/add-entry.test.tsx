import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionProvider } from 'next-auth/react'
import { AddEntry } from '../health-passport/add-entry'
import type { StandardizedMedicalRecord, EntriesByDateResponse } from '@/lib/types'

const mockExtract = vi.fn()
const mockSave = vi.fn()
const mockMerge = vi.fn()
const mockFetchByDate = vi.fn().mockResolvedValue({ date: '2026-10-12', count: 0 })
const mockFetchDefinitions = vi.fn().mockResolvedValue([])

// Define the mock classes via vi.hoisted so they're available to the
// hoisted vi.mock factory — `instanceof` checks in component code resolve
// against these definitions.
const { ApiError, UsageLimitError } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message)
      this.name = 'ApiError'
    }
  }
  class UsageLimitError extends Error {
    constructor(public status: number, message: string) {
      super(message)
      this.name = 'UsageLimitError'
    }
  }
  return { ApiError, UsageLimitError }
})

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return {
    extractMedicalData: (...args: Parameters<typeof actual.extractMedicalData>) => mockExtract(...args),
    saveMedicalEntry: (...args: Parameters<typeof actual.saveMedicalEntry>) => mockSave(...args),
    mergeMedicalEntry: (...args: Parameters<typeof actual.mergeMedicalEntry>) => mockMerge(...args),
    fetchEntriesByDate: (...args: Parameters<typeof actual.fetchEntriesByDate>) => mockFetchByDate(...args),
    fetchBiomarkerDefinitions: (...args: Parameters<typeof actual.fetchBiomarkerDefinitions>) => mockFetchDefinitions(...args),
    buildSaveEntryFormData: actual.buildSaveEntryFormData,
    ApiError,
    UsageLimitError,
  }
})

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <SessionProvider session={null}>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </SessionProvider>,
  )
}

function createFile(name = 'lab.pdf', type = 'application/pdf', content = 'fake'): File {
  return new File([content], name, { type })
}

function selectFile(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

function dropFiles(element: HTMLElement, files: File[]) {
  fireEvent.drop(element, {
    dataTransfer: { files },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AddEntry', () => {
  it('renders idle upload state', () => {
    renderWithProviders(<AddEntry onSave={vi.fn()} />)

    expect(screen.getByText('Add New Medical Record')).toBeInTheDocument()
    expect(screen.getByText('Skip Upload & Enter Manually')).toBeInTheDocument()
    expect(screen.getByText(/click to browse/i)).toBeInTheDocument()
  })

  it('switches to manual entry when skip upload is clicked', async () => {
    renderWithProviders(<AddEntry onSave={vi.fn()} />)
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

    const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
    selectFile(container, createFile())

    expect(screen.getByText('Scanning document pages...')).toBeInTheDocument()
  })

  it('starts extraction when a file is dropped on the upload surface', () => {
    mockExtract.mockImplementation(
      () => new Promise(() => {}),
    )

    const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
    const zone = container.querySelector('button[type="button"]') as HTMLButtonElement
    dropFiles(zone, [createFile('dropped.pdf')])

    expect(mockExtract).toHaveBeenCalledTimes(1)
    expect(mockExtract.mock.calls[0][0].name).toBe('dropped.pdf')
    expect(screen.getByText('Scanning document pages...')).toBeInTheDocument()
  })

  it('uses only the first file when multiple are dropped and shows a notice', () => {
    mockExtract.mockImplementation(
      () => new Promise(() => {}),
    )

    const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
    const zone = container.querySelector('button[type="button"]') as HTMLButtonElement
    dropFiles(zone, [createFile('first.pdf'), createFile('second.pdf')])

    expect(mockExtract).toHaveBeenCalledTimes(1)
    expect(mockExtract.mock.calls[0][0].name).toBe('first.pdf')
    expect(
      screen.getByText(/Only the first document is processed/),
    ).toBeInTheDocument()
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
          reference: { kind: 'interval', low: 130, high: 170 },
          status: 'normal', category: 'Complete Blood Count',
          definition_id: 'hb', scope: 'global',
        },
        {
          raw_name: 'WBC', raw_value: '7.2', raw_unit: 'K/µL', raw_range_string: '4.0-11.0',
          standard_name_en: 'WBC', standard_value: 7.2, standard_unit: 'K/µL',
          reference: { kind: 'interval', low: 4, high: 11 },
          status: 'normal', category: 'Complete Blood Count',
          definition_id: 'wbc', scope: 'global',
        },
        {
          raw_name: 'LDL', raw_value: '110', raw_unit: 'mg/dL', raw_range_string: '0-130',
          standard_name_en: 'LDL', standard_value: 110, standard_unit: 'mg/dL',
          reference: { kind: 'interval', low: 0, high: 130 },
          status: 'normal', category: 'Lipid Panel',
          definition_id: 'ldl', scope: 'global',
        },
      ],
      visit_data: null,
      imaging_data: null,
    }
    mockExtract.mockResolvedValue(aiResult)

    const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
    selectFile(container, createFile())

    await waitFor(() => {
      expect(screen.getByText('Blood Test Panel')).toBeInTheDocument()
    }, { timeout: 3000 })

    expect(screen.getByDisplayValue('2026-07-15')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Test Lab')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Dr. House')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Annual Panel')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Fasted 12h')).toBeInTheDocument()
    expect(screen.getByDisplayValue('145')).toBeInTheDocument()
    expect(screen.getByText('g/L')).toBeInTheDocument()
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
        diagnosis: { original: 'Hypertension', translated_en: 'Hypertension' },
        chief_complaint: { original: 'Headaches for 2 weeks', translated_en: 'Headaches for 2 weeks' },
        objective_findings: { original: 'BP 150/95', translated_en: 'BP 150/95' },
        prescriptions: [{ name: { original: 'Lisinopril', translated_en: 'Lisinopril' }, dosage: { original: '10mg', translated_en: '10mg' }, instructions: { original: 'Once daily', translated_en: 'Once daily' } }],
        recommendations: [{ original: 'Reduce sodium', translated_en: 'Reduce sodium' }, { original: 'Exercise daily', translated_en: 'Exercise daily' }],
      },
      imaging_data: null,
    }
    mockExtract.mockResolvedValue(aiResult)

    const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
    selectFile(container, createFile())

    await waitFor(() => {
      expect(screen.getByText('Doctor Visit / Clinical Notes')).toBeInTheDocument()
    }, { timeout: 3000 })

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

    const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
    selectFile(container, createFile())

    await waitFor(() => {
      expect(screen.getByText('MRI / Imaging Scan')).toBeInTheDocument()
    }, { timeout: 3000 })

    const select = screen.getByDisplayValue('MRI') as HTMLSelectElement
    expect(select.value).toBe('MRI')
    expect(screen.getByDisplayValue('Mild degeneration L4-L5')).toBeInTheDocument()
    expect(screen.getByDisplayValue('No acute pathology')).toBeInTheDocument()
  })

  it('falls back to manual entry on API error', async () => {
    mockExtract.mockRejectedValue(new Error('API unavailable'))

    const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
    selectFile(container, createFile())

    await waitFor(() => {
      expect(screen.getByText('AI extraction failed')).toBeInTheDocument()
    })
    expect(
      screen.getByText('Switched to manual entry. Fill in the details below.'),
    ).toBeInTheDocument()
  })

  describe('merge with existing blood test', () => {
    function bloodTestResult(biomarkers = bloodBiomarkers()): StandardizedMedicalRecord {
      return {
        entry_type: 'blood_test',
        date: '2026-07-15',
        time: null,
        clinic: 'Test Lab',
        provider: 'Dr. House',
        title: null,
        notes: null,
        biomarkers,
        visit_data: null,
        imaging_data: null,
      }
    }

    function bloodBiomarkers(): StandardizedMedicalRecord['biomarkers'] {
      return [
        {
          raw_name: 'Hemoglobin', raw_value: '145', raw_unit: 'g/L', raw_range_string: '130-170',
          standard_name_en: 'Hemoglobin', standard_value: 145, standard_unit: 'g/L',
          reference: { kind: 'interval', low: 130, high: 170 },
          status: 'normal', category: 'Complete Blood Count',
          definition_id: 'hb', scope: 'global',
        },
      ]
    }

    function existingEntry(overrides: Partial<EntriesByDateResponse['entries'][0]> = {}): EntriesByDateResponse['entries'][0] {
      return {
        id: 'existing-1',
        title: 'Morning Panel',
        date: '2026-07-15T09:00:00',
        time: '09:00',
        biomarkers: [{ definition_id: 'wbc', loinc_code: '6690-2' }],
        ...overrides,
      }
    }

    async function renderEditorWithExistingEntry(entry: EntriesByDateResponse['entries'][0]) {
      mockFetchByDate.mockResolvedValue({ date: '2026-07-15', count: 1, entries: [entry] })
      mockExtract.mockResolvedValue(bloodTestResult())
      const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
      selectFile(container, createFile())
      await waitFor(() => {
        expect(screen.getByText('Blood Test Panel')).toBeInTheDocument()
      }, { timeout: 3000 })
      return container
    }

    it('shows the merge checkbox when a non-conflicting test exists on the date', async () => {
      await renderEditorWithExistingEntry(existingEntry())

      await waitFor(() => {
        expect(
          screen.getByText("Merge with this date's existing blood test"),
        ).toBeInTheDocument()
      })
      expect(screen.getByRole('checkbox')).not.toBeDisabled()
    })

    it('hides the merge checkbox when no blood test exists on the date', async () => {
      mockFetchByDate.mockResolvedValue({ date: '2026-07-15', count: 0, entries: [] })
      mockExtract.mockResolvedValue(bloodTestResult())
      const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
      selectFile(container, createFile())

      await waitFor(() => {
        expect(screen.getByText('Blood Test Panel')).toBeInTheDocument()
      }, { timeout: 3000 })
      // Give the debounced by-date effect time to run.
      await new Promise((r) => setTimeout(r, 500))
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    })

    it('disables the merge checkbox and explains when biomarkers conflict', async () => {
      const entry = existingEntry({
        biomarkers: [
          { definition_id: 'wbc', loinc_code: '6690-2' },
          { definition_id: 'hb', loinc_code: '718-7' },
        ],
      })
      await renderEditorWithExistingEntry(entry)

      await waitFor(() => {
        expect(screen.getByRole('checkbox')).toBeDisabled()
      })
      expect(screen.getByText(/Can't merge/i)).toBeInTheDocument()
      expect(screen.getByText(/in the existing test: Hemoglobin/)).toBeInTheDocument()
    })

    it('detects conflicts for manual rows resolved by name on the server', async () => {
      // The target's hb definition carries its names; the extracted row has no
      // definition_id ('' — like a manually-typed row), so only the name can
      // reveal the conflict the server would otherwise reject with a 409.
      const entry = existingEntry({
        biomarkers: [
          {
            definition_id: 'hb',
            loinc_code: '718-7',
            names: { en: 'Hemoglobin', ru: 'Гемоглобин' },
            synonyms: ['Hgb'],
          },
        ],
      })
      mockFetchByDate.mockResolvedValue({ date: '2026-07-15', count: 1, entries: [entry] })
      mockExtract.mockResolvedValue(
        bloodTestResult([
          {
            raw_name: 'Hemoglobin', raw_value: '145', raw_unit: 'g/L', raw_range_string: '130-170',
            standard_name_en: 'Hemoglobin', standard_value: 145, standard_unit: 'g/L',
            reference: { kind: 'interval', low: 130, high: 170 },
            status: 'normal', category: 'Complete Blood Count',
            definition_id: '', scope: 'global',
          },
        ]),
      )
      const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
      selectFile(container, createFile())

      await waitFor(() => {
        expect(screen.getByRole('checkbox')).toBeDisabled()
      }, { timeout: 3000 })
      expect(screen.getByText(/Can't merge/i)).toBeInTheDocument()
      expect(screen.getByText(/in the existing test: Hemoglobin/)).toBeInTheDocument()
    })

    it('detects conflicts when a typed name is a substring of an existing synonym', async () => {
      // The server resolves synonyms with substring containment (ILIKE
      // '%name%'), so a manual row whose name is a substring of a target
      // synonym would 409 on Merge & Save even though it matches no name
      // exactly. The client's pre-flight check must mirror that, not
      // exact-match only.
      const entry = existingEntry({
        biomarkers: [
          {
            definition_id: 'hba1c',
            loinc_code: '4548-4',
            names: { en: 'Glycated Hemoglobin' },
            synonyms: ['HbA1c', 'Hemoglobin A1c'],
          },
        ],
      })
      mockFetchByDate.mockResolvedValue({ date: '2026-07-15', count: 1, entries: [entry] })
      mockExtract.mockResolvedValue(
        bloodTestResult([
          {
            raw_name: 'Hemoglobin', raw_value: '145', raw_unit: 'g/L', raw_range_string: '130-170',
            standard_name_en: 'Hemoglobin', standard_value: 145, standard_unit: 'g/L',
            reference: { kind: 'interval', low: 130, high: 170 },
            status: 'normal', category: 'Complete Blood Count',
            definition_id: '', scope: 'global',
          },
        ]),
      )
      const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
      selectFile(container, createFile())

      await waitFor(() => {
        expect(screen.getByRole('checkbox')).toBeDisabled()
      }, { timeout: 3000 })
      expect(screen.getByText(/Can't merge/i)).toBeInTheDocument()
      expect(screen.getByText(/in the existing test: Hemoglobin/)).toBeInTheDocument()
    })

    it('never saves as merge once the merge is blocked', async () => {
      // A conflicting target: the box is disabled and unchecked; clicking it is
      // a no-op, so the save can never silently route to mergeMedicalEntry.
      const entry = existingEntry({
        biomarkers: [{ definition_id: 'hb', loinc_code: '718-7' }],
      })
      await renderEditorWithExistingEntry(entry)

      await waitFor(() => {
        expect(screen.getByRole('checkbox')).toBeDisabled()
      })
      const box = screen.getByRole('checkbox') as HTMLInputElement
      expect(box.checked).toBe(false)
      fireEvent.click(box)
      expect(box.checked).toBe(false)
      expect(screen.queryByText('Merge & Save')).not.toBeInTheDocument()
      expect(screen.getByText('Save to HealthPassport')).toBeInTheDocument()
    })

    it('does not require a time when merging', async () => {
      await renderEditorWithExistingEntry(existingEntry())

      await waitFor(() => {
        expect(screen.getByRole('checkbox')).toBeInTheDocument()
      })
      fireEvent.click(screen.getByRole('checkbox'))

      expect(screen.getByText('Time (optional)')).toBeInTheDocument()
      expect(screen.getByText('Merge & Save')).toBeEnabled()
    })

    it('saves via mergeMedicalEntry with the target entry id when checked', async () => {
      mockMerge.mockResolvedValue({ success: true, message: 'Entry merged', id: 'existing-1' })
      await renderEditorWithExistingEntry(existingEntry())

      await waitFor(() => {
        expect(screen.getByRole('checkbox')).toBeInTheDocument()
      })
      fireEvent.click(screen.getByRole('checkbox'))
      fireEvent.click(screen.getByText('Merge & Save'))

      await waitFor(() => {
        expect(mockMerge).toHaveBeenCalledTimes(1)
      })
      const [targetId, formData] = mockMerge.mock.calls[0]
      expect(targetId).toBe('existing-1')
      expect(formData).toBeInstanceOf(FormData)
      expect(mockSave).not.toHaveBeenCalled()
    })

    it('saves via saveMedicalEntry when the checkbox is left unchecked', async () => {
      mockSave.mockResolvedValue({ success: true, message: 'Entry saved', id: 'new-1' })
      const container = await renderEditorWithExistingEntry(existingEntry())

      await waitFor(() => {
        expect(screen.getByRole('checkbox')).toBeInTheDocument()
      })
      // Without merging, an existing blood test on the date requires a time.
      const timeInput = container.querySelector('input[type="time"]') as HTMLInputElement
      fireEvent.change(timeInput, { target: { value: '10:00' } })
      fireEvent.click(screen.getByText('Save to HealthPassport'))

      await waitFor(() => {
        expect(mockSave).toHaveBeenCalledTimes(1)
      })
      expect(mockMerge).not.toHaveBeenCalled()
    })

    it('shows a target picker when multiple blood tests share the date', async () => {
      mockFetchByDate.mockResolvedValue({
        date: '2026-07-15',
        count: 2,
        entries: [
          existingEntry(),
          existingEntry({ id: 'existing-2', title: 'Evening Panel', time: '18:30', biomarkers: [] }),
        ],
      })
      mockExtract.mockResolvedValue(bloodTestResult())
      const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
      selectFile(container, createFile())

      await waitFor(() => {
        expect(screen.getByRole('checkbox')).toBeInTheDocument()
      }, { timeout: 3000 })
      fireEvent.click(screen.getByRole('checkbox'))

      const picker = screen.getByLabelText('Merge into:')
      expect(picker).toBeInTheDocument()
      expect(picker).toHaveValue('existing-1')
      fireEvent.change(picker, { target: { value: 'existing-2' } })
      expect(picker).toHaveValue('existing-2')
    })
  })
})
