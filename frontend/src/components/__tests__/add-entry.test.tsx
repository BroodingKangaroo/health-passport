import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionProvider } from 'next-auth/react'
import { AddEntry } from '../health-passport/add-entry'
import { LeaveGuardProvider } from '@/providers/leave-guard-provider'
import { TestI18nProvider } from '@/test/i18n-test-provider'
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
    fetchUsageLimits: vi.fn().mockResolvedValue({
      is_anonymous: false,
      ai_extraction_count: 0,
      ai_extraction_limit: 50,
      total_upload_size_bytes: 0,
      total_upload_limit_bytes: 1,
    }),
    ApiError,
    UsageLimitError,
  }
})

vi.mock('@/services/import-jobs', () => ({
  createImportJob: vi.fn().mockResolvedValue('job-mock'),
  cancelImportJob: vi.fn(),
  retryImportJob: vi.fn(),
  dismissImportJob: vi.fn(),
  fetchImportJobs: vi.fn().mockResolvedValue({ items: [] }),
}))

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <TestI18nProvider>
      <SessionProvider session={null}>
        <QueryClientProvider client={queryClient}>
          <LeaveGuardProvider>{ui}</LeaveGuardProvider>
        </QueryClientProvider>
      </SessionProvider>
    </TestI18nProvider>,
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

  it('opens the batch import panel when multiple files are dropped', () => {
    mockExtract.mockImplementation(
      () => new Promise(() => {}),
    )

    const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
    const zone = container.querySelector('button[type="button"]') as HTMLButtonElement
    dropFiles(zone, [createFile('first.pdf'), createFile('second.pdf')])

    // >1 file routes to the background-jobs batch panel (capped submission,
    // per-row progress); the single-file SSE extraction never runs.
    expect(mockExtract).not.toHaveBeenCalled()
    expect(screen.getByTestId('batch-import-panel')).toBeInTheDocument()
    expect(screen.getByText('Importing 2 documents')).toBeInTheDocument()
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
      instrumental_data: null,
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
      instrumental_data: null,
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

  it('pre-fills instrumental test form from AI data', async () => {
    const aiResult: StandardizedMedicalRecord = {
      entry_type: 'instrumental_test',
      date: '2026-07-20',
      clinic: 'Rad Center',
      provider: 'Dr. Grey',
      title: null,
      notes: null,
      biomarkers: null,
      visit_data: null,
      instrumental_data: {
        modality: 'MRI',
        findings: 'Mild degeneration L4-L5',
        conclusion: 'No acute pathology',
      },
    }
    mockExtract.mockResolvedValue(aiResult)

    const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
    selectFile(container, createFile())

    await waitFor(() => {
      expect(screen.getByText('Instrumental Test (MRI, Elastography, ECG...)')).toBeInTheDocument()
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

  describe('save validation', () => {
    async function renderManualEditor() {
      const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
      fireEvent.click(screen.getByText('Skip Upload & Enter Manually'))
      await waitFor(() => {
        expect(screen.getByText('Save to HealthPassport')).toBeInTheDocument()
      })
      return container
    }

    function setDate(container: HTMLElement, value: string) {
      const input = container.querySelector('input[type="date"]') as HTMLInputElement
      fireEvent.change(input, { target: { value } })
    }

    it('blocks save when the date is blank', async () => {
      const container = await renderManualEditor()
      // the date input starts empty in manual mode

      fireEvent.click(screen.getByText('Save to HealthPassport'))

      await waitFor(() => {
        expect(screen.getByText('Date is required')).toBeInTheDocument()
      })
      expect(mockSave).not.toHaveBeenCalled()
      // The error clears as soon as a date is picked.
      setDate(container, '2025-06-10')
      expect(screen.queryByText('Date is required')).not.toBeInTheDocument()
    })

    it('blocks save when the date is in the future', async () => {
      const container = await renderManualEditor()
      const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      const pad = (n: number) => String(n).padStart(2, '0')
      setDate(container, `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}`)

      fireEvent.click(screen.getByText('Save to HealthPassport'))

      await waitFor(() => {
        expect(screen.getByText('Date can\u2019t be in the future')).toBeInTheDocument()
      })
      expect(mockSave).not.toHaveBeenCalled()
    })

    it('blocks save when every biomarker row is empty', async () => {
      const container = await renderManualEditor()
      setDate(container, '2025-06-10')
      // manual mode starts with a single empty template row

      fireEvent.click(screen.getByText('Save to HealthPassport'))

      await waitFor(() => {
        expect(
          screen.getByText('Add at least one biomarker with a name and value.'),
        ).toBeInTheDocument()
      })
      expect(mockSave).not.toHaveBeenCalled()
    })

    it('blocks save when every row has been deleted', async () => {
      // Deleting all rows leaves both valid and skipped counts at zero,
      // which used to slip past the empty-save guard.
      const container = await renderManualEditor()
      setDate(container, '2025-06-10')
      fireEvent.click(screen.getByRole('button', { name: 'Remove biomarker' }))
      expect(screen.queryByText(/missing a name or value/)).not.toBeInTheDocument()

      fireEvent.click(screen.getByText('Save to HealthPassport'))

      await waitFor(() => {
        expect(
          screen.getByText('Add at least one biomarker with a name and value.'),
        ).toBeInTheDocument()
      })
      expect(mockSave).not.toHaveBeenCalled()
    })

    it('warns about skipped rows but saves when at least one row is filled', async () => {
      // AI-extracted test where one biomarker parsed and one came back empty:
      // the empty row must be flagged, not silently dropped, yet the save
      // proceeds with the valid row.
      mockSave.mockResolvedValue({ success: true, message: 'Entry saved', id: 'new-1' })
      mockExtract.mockResolvedValue({
        entry_type: 'blood_test',
        date: '2025-06-10',
        time: null,
        clinic: 'Test Lab',
        provider: null,
        title: null,
        notes: null,
        biomarkers: [
          {
            raw_name: 'Hemoglobin', raw_value: '145', raw_unit: 'g/L', raw_range_string: '130-170',
            standard_name_en: 'Hemoglobin', standard_value: 145, standard_unit: 'g/L',
            reference: { kind: 'interval', low: 130, high: 170 },
            status: 'normal', category: 'Complete Blood Count',
            definition_id: 'hb', scope: 'global',
          },
          {
            raw_name: '', raw_value: '', raw_unit: '', raw_range_string: '',
            standard_name_en: '', standard_value: null, standard_unit: '',
            reference: null, status: 'normal', category: 'Complete Blood Count',
            definition_id: '', scope: 'local',
          },
        ],
        visit_data: null,
        instrumental_data: null,
      } satisfies StandardizedMedicalRecord)
      const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
      selectFile(container, createFile())

      await waitFor(() => {
        expect(screen.getByText('Blood Test Panel')).toBeInTheDocument()
      }, { timeout: 3000 })
      fireEvent.click(screen.getByText('Save to HealthPassport'))

      await waitFor(() => {
        expect(mockSave).toHaveBeenCalledTimes(1)
      })
      expect(screen.getByText(/1 row is missing a name or value/)).toBeInTheDocument()
    })

    it('shows a warning when the duplicate-test check fails, save stays enabled', async () => {
      mockFetchByDate.mockRejectedValue(new Error('backend down'))
      const container = await renderManualEditor()
      setDate(container, '2025-06-10')

      await waitFor(() => {
        expect(
          screen.getByText(/Couldn't check for existing tests on this date/),
        ).toBeInTheDocument()
      })
      expect(screen.getByText('Save to HealthPassport')).toBeEnabled()
    })
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
        instrumental_data: null,
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

  describe('leave-guard abort wiring', () => {
    // The extraction's AbortSignal, captured from the mockExtract call so the
    // tests can assert what the confirmed-leave onLeave callback did to it.
    let capturedSignal: AbortSignal | null

    beforeEach(() => {
      capturedSignal = null
      // Reset any history markers left by previous tests.
      history.pushState({}, '')
      mockExtract.mockImplementation((_file, _onProgress, signal) => {
        capturedSignal = signal ?? null
        return new Promise(() => {}) // never resolves — stays on the scan screen
      })
    })

    async function startExtraction() {
      const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
      selectFile(container, createFile())
      await screen.findByText('Scanning document pages...')
    }

    async function pressBack() {
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
      await screen.findByRole('alertdialog')
    }

    it('aborts the in-flight extraction when leave is confirmed', async () => {
      await startExtraction()
      await pressBack()

      fireEvent.click(screen.getByText('Leave anyway'))

      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(capturedSignal?.aborted).toBe(true)
    })

    it('keeps the extraction running when the user stays', async () => {
      await startExtraction()
      await pressBack()

      fireEvent.click(screen.getByText('Stay'))

      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(capturedSignal?.aborted).toBe(false)
      expect(screen.getByText('Scanning document pages...')).toBeInTheDocument()
    })

    it('does not abort on natural completion', async () => {
      const result = {
        entry_type: 'blood_test',
        date: '2026-07-15',
        time: null,
        clinic: 'Test Lab',
        provider: null,
        title: null,
        notes: null,
        biomarkers: [
          {
            raw_name: 'Hemoglobin', raw_value: '145', raw_unit: 'g/L', raw_range_string: '130-170',
            standard_name_en: 'Hemoglobin', standard_value: 145, standard_unit: 'g/L',
            reference: { kind: 'interval', low: 130, high: 170 },
            status: 'normal', category: 'Complete Blood Count',
            definition_id: 'hb', scope: 'global',
          },
        ],
        visit_data: null,
        instrumental_data: null,
      } satisfies StandardizedMedicalRecord
      // Resolving variant of the capturing implementation (mockResolvedValue
      // would replace it and lose the signal capture).
      mockExtract.mockImplementation((_file, _onProgress, signal) => {
        capturedSignal = signal ?? null
        return Promise.resolve(result)
      })
      const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
      selectFile(container, createFile())

      await waitFor(() => {
        expect(screen.getByText('Blood Test Panel')).toBeInTheDocument()
      }, { timeout: 3000 })

      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(capturedSignal?.aborted).toBe(false)
    })
  })

  describe('replace document after removal', () => {
    function extractedResult(): StandardizedMedicalRecord {
      return {
        entry_type: 'blood_test',
        date: '2026-07-15',
        time: null,
        clinic: 'Test Lab',
        provider: null,
        title: null,
        notes: null,
        biomarkers: [
          {
            raw_name: 'Hemoglobin', raw_value: '145', raw_unit: 'g/L', raw_range_string: '130-170',
            standard_name_en: 'Hemoglobin', standard_value: 145, standard_unit: 'g/L',
            reference: { kind: 'interval', low: 130, high: 170 },
            status: 'normal', category: 'Complete Blood Count',
            definition_id: 'hb', scope: 'global',
          },
        ],
        visit_data: null,
        instrumental_data: null,
      }
    }

    async function renderEditorWithExtractedDoc() {
      mockExtract.mockResolvedValue(extractedResult())
      const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
      selectFile(container, createFile())
      await waitFor(() => {
        expect(screen.getByText('Blood Test Panel')).toBeInTheDocument()
      }, { timeout: 3000 })
      return container
    }

    it('offers an attach slot after removing the extracted document', async () => {
      await renderEditorWithExtractedDoc()

      fireEvent.click(screen.getByRole('button', { name: 'Remove document' }))

      expect(screen.getByText('Add a photo or scan')).toBeInTheDocument()
    })

    it('re-runs AI extraction when a replacement is confirmed in AI mode', async () => {
      const container = await renderEditorWithExtractedDoc()
      // The replacement extraction hangs so the scan screen stays up.
      mockExtract.mockImplementationOnce(() => new Promise(() => {}))

      fireEvent.click(screen.getByRole('button', { name: 'Remove document' }))
      selectFile(container, createFile('replacement.pdf'))

      // The form holds extracted data, so a confirmation gates the extraction.
      expect(screen.getByText('Re-run AI extraction?')).toBeInTheDocument()
      expect(mockExtract).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByText('Extract new document'))

      await waitFor(() => expect(mockExtract).toHaveBeenCalledTimes(2))
      expect(mockExtract.mock.calls[1][0].name).toBe('replacement.pdf')
      expect(screen.getByText('Scanning document pages...')).toBeInTheDocument()
    })

    it('canceling the confirmation keeps the form data and the attached file', async () => {
      const container = await renderEditorWithExtractedDoc()

      fireEvent.click(screen.getByRole('button', { name: 'Remove document' }))
      selectFile(container, createFile('replacement.pdf'))
      fireEvent.click(screen.getByText('Keep current data'))

      expect(screen.queryByText('Re-run AI extraction?')).not.toBeInTheDocument()
      expect(mockExtract).toHaveBeenCalledTimes(1)
      // The extracted data survives untouched.
      expect(screen.getByDisplayValue('145')).toBeInTheDocument()
    })

    it('extracts immediately when the form has no data to lose', async () => {
      mockExtract.mockResolvedValue({ ...extractedResult(), biomarkers: [] })
      const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
      selectFile(container, createFile())
      await waitFor(() => {
        expect(screen.getByText('Blood Test Panel')).toBeInTheDocument()
      }, { timeout: 3000 })
      mockExtract.mockImplementationOnce(() => new Promise(() => {}))

      fireEvent.click(screen.getByRole('button', { name: 'Remove document' }))
      selectFile(container, createFile('replacement.pdf'))

      expect(screen.queryByText('Re-run AI extraction?')).not.toBeInTheDocument()
      await waitFor(() => expect(mockExtract).toHaveBeenCalledTimes(2))
      expect(mockExtract.mock.calls[1][0].name).toBe('replacement.pdf')
    })

    it('does not re-extract when attaching in manual mode', async () => {
      const { container } = renderWithProviders(<AddEntry onSave={vi.fn()} />)
      fireEvent.click(screen.getByText('Skip Upload & Enter Manually'))
      await waitFor(() => {
        expect(screen.getByText('Save to HealthPassport')).toBeInTheDocument()
      })
      expect(screen.getByText('Add a photo or scan')).toBeInTheDocument()

      selectFile(container, createFile('scan.jpg', 'image/jpeg'))

      expect(mockExtract).not.toHaveBeenCalled()
    })
  })
})

describe('staged import job review (B4)', () => {
  const stagedRecord: StandardizedMedicalRecord = {
    entry_type: 'blood_test',
    date: '2026-07-15',
    time: null,
    clinic: 'Test Lab',
    provider: 'Dr. House',
    title: 'Annual Panel',
    notes: 'Fasted 12h',
    source_language: 'en',
    biomarkers: [
      {
        raw_name: 'Hemoglobin', raw_value: '145', raw_unit: 'g/L', raw_range_string: '130-170',
        standard_name_en: 'Hemoglobin', standard_value: 145, standard_unit: 'g/L',
        reference: { kind: 'interval', low: 130, high: 170 },
        status: 'normal', category: 'Complete Blood Count',
        definition_id: 'hb', scope: 'global',
      },
    ],
    visit_data: null,
    instrumental_data: null,
  }

  async function renderStagedEditor() {
    mockFetchByDate.mockResolvedValue({ date: '2026-07-15', count: 0, entries: [] })
    const view = renderWithProviders(
      <AddEntry
        onSave={vi.fn()}
        stagedJob={{ jobId: 'job-stage', record: stagedRecord }}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('Blood Test Panel')).toBeInTheDocument()
    }, { timeout: 3000 })
    return view
  }

  it('prefills the editor from the staged record without any extraction', async () => {
    const { container } = await renderStagedEditor()
    // No SSE extraction, no file — the record comes from the staged job.
    expect(mockExtract).not.toHaveBeenCalled()
    const dateInput = container.querySelector('input[type="date"]') as HTMLInputElement
    expect(dateInput.value).toBe('2026-07-15')
    expect((container.querySelector('input[type="time"]') as HTMLInputElement)).toBeTruthy()
    // Clinic/provider/title prefills landed (identified banner shows the type).
    expect(screen.getByText('AI successfully identified')).toBeInTheDocument()
  })

  it('shows the staged document in the preview pane', async () => {
    const stagedFile = new File(['%PDF fake'], 'Отчёт.pdf', {
      type: 'application/octet-stream',
    })
    mockFetchByDate.mockResolvedValue({ date: '2026-07-15', count: 0, entries: [] })
    renderWithProviders(
      <AddEntry
        onSave={vi.fn()}
        stagedJob={{ jobId: 'job-stage', record: stagedRecord, file: stagedFile }}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('Blood Test Panel')).toBeInTheDocument()
    }, { timeout: 3000 })
    // The preview pane renders the staged document (generic card w/ filename
    // for non-pdf types; the pdf/image viewers key off the blob type).
    expect(screen.getByText('Отчёт.pdf')).toBeInTheDocument()
  })

  it('saves with import_job_id and no file re-upload', async () => {
    mockSave.mockResolvedValue({ success: true, message: 'Entry saved', id: 'e1' })
    await renderStagedEditor()
    fireEvent.click(screen.getByText('Save to HealthPassport'))
    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    const fd = mockSave.mock.calls[0][0] as FormData
    expect(fd.get('import_job_id')).toBe('job-stage')
    expect(fd.get('file')).toBeNull()
    expect(fd.get('type')).toBe('blood_test')
  })

  it('merges with import_job_id when the same-date merge is selected', async () => {
    mockMerge.mockResolvedValue({ success: true, message: 'Entry merged', id: 'existing-1' })
    mockFetchByDate.mockResolvedValue({
      date: '2026-07-15',
      count: 1,
      entries: [
        {
          id: 'existing-1',
          title: 'Morning Panel',
          date: '2026-07-15T09:00:00',
          time: '09:00',
          biomarkers: [{ definition_id: 'wbc', loinc_code: '6690-2' }],
        },
      ],
    })
    renderWithProviders(
      <AddEntry
        onSave={vi.fn()}
        stagedJob={{ jobId: 'job-stage', record: stagedRecord }}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('Blood Test Panel')).toBeInTheDocument()
    }, { timeout: 3000 })
    // Same-date hint: the merge checkbox is the same-date strategy.
    await waitFor(() => {
      expect(
        screen.getByText("Merge with this date's existing blood test"),
      ).toBeInTheDocument()
    }, { timeout: 3000 })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByText('Merge & Save'))
    await waitFor(() => expect(mockMerge).toHaveBeenCalled())
    const fd = mockMerge.mock.calls[0][1] as FormData
    expect(fd.get('import_job_id')).toBe('job-stage')
    expect(fd.get('file')).toBeNull()
  })
})
