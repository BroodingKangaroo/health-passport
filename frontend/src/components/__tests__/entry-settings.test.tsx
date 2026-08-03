import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { EntrySettings } from '../health-passport/entry-settings'
import type { BiomarkerResult, MedicalEvent, VisitData } from '@/lib/types'

const baseEvent: MedicalEvent = {
  id: 'test-event-1',
  type: 'blood_test',
  date: '2026-12-15',
  title: 'Test Panel',
  clinic: 'Test Lab',
  attachments: [
    { id: 'att-1', name: 'report.pdf', type: 'Lab Report', size: '120 KB', url: '/static/uploads/file1.pdf' },
    { id: 'att-2', name: 'scan.png', type: 'Image', size: '2 MB', url: '/static/uploads/file2.png' },
  ],
}

const bloodTestBiomarkers: BiomarkerResult[] = [
  {
    id: 'wbc', value: 5.0, entry_id: 'evt-blood', date: '2026-12-15', status: 'normal',
    definition: { id: 'wbc', loinc_code: '6690-2', names: { en: 'WBC' }, synonyms: [], unit: 'K/µL', reference: { kind: 'interval', low: 4, high: 11 }, category: 'CBC', scope: 'global', user_id: null, reference_source: 'global' },
  },
  {
    id: 'glu', value: 120, entry_id: 'evt-blood', date: '2026-12-15', status: 'high',
    definition: { id: 'glu', loinc_code: '2345-7', names: { en: 'Glucose' }, synonyms: [], unit: 'mg/dL', reference: { kind: 'interval', low: 65, high: 100 }, category: 'CMP', scope: 'global', user_id: null, reference_source: 'global' },
  },
  {
    id: 'hb', value: 11, entry_id: 'evt-blood', date: '2026-12-15', status: 'low',
    definition: { id: 'hb', loinc_code: '718-7', names: { en: 'Hemoglobin' }, synonyms: [], unit: 'g/dL', reference: { kind: 'interval', low: 12, high: 16 }, category: 'CBC', scope: 'global', user_id: null, reference_source: 'global' },
  },
  {
    id: 'hcg', value: 'Positive', entry_id: 'evt-blood', date: '2026-12-15', status: 'abnormal',
    definition: { id: 'hcg', loinc_code: '2118-8', names: { en: 'hCG' }, synonyms: [], unit: '', reference: { kind: 'qualitative', expected: 'Negative' }, category: 'General', scope: 'global', user_id: null, reference_source: 'global' },
  },
]

const visitData: VisitData = {
  specialty: 'Cardiology Follow-up',
  provider: 'Dr. Test',
  date: '2026-12-15',
  clinic: 'Heart Institute',
  verdict: { original: 'Hypertension', translated_en: 'Hypertension' },
  notes: [
    { heading: 'Chief Complaint', text_original: 'Chest pain', text_translated: 'Chest pain' },
    { heading: 'History', text_original: 'Family history', text_translated: 'Family history' },
  ],
  prescriptions: [
    { id: 1, name: { original: 'Med', translated_en: 'Med' }, dose: { original: '10mg', translated_en: '10mg' }, instruction: { original: 'Daily', translated_en: 'Daily' } },
  ],
  recommendations: [
    { original: 'Follow up in 6 months', translated_en: 'Follow up in 6 months' },
    { original: 'Lose weight', translated_en: 'Lose weight' },
  ],
  attachments: [],
}

describe('EntrySettings', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the entry type, date, attachment count, and total size for a blood test', () => {
    render(
      <EntrySettings
        event={baseEvent}
        biomarkers={bloodTestBiomarkers}
        onDeleted={vi.fn()}
      />,
    )

    // Type row
    expect(screen.getByText('Blood Test')).toBeDefined()
    expect(screen.getByText('Test Lab')).toBeDefined()
    // Documents row: 2 attachments, 120 KB + 2 MB
    // 120 KB = 122880 B, 2 MB = 2097152 B → 2220032 B total → "2.1 MB"
    expect(screen.getByText('2 (2.1 MB)')).toBeDefined()
  })

  it('shows biomarker count and status breakdown for a blood test', () => {
    render(
      <EntrySettings
        event={baseEvent}
        biomarkers={bloodTestBiomarkers}
        onDeleted={vi.fn()}
      />,
    )

    expect(screen.getByText('4')).toBeDefined()
    expect(screen.getByText('1 normal · 1 low · 1 high · 1 abnormal')).toBeDefined()
  })

  it('shows visit-specific counts (notes, prescriptions, recommendations) for a doctor visit', () => {
    render(
      <EntrySettings
        event={{ ...baseEvent, type: 'doctor_visit', title: 'Cardiology Follow-up' }}
        visit={visitData}
        onDeleted={vi.fn()}
      />,
    )

    expect(screen.getByText('Doctor Visit')).toBeDefined()
    // Notes row
    expect(screen.getByText('Clinical Notes')).toBeDefined()
    // Prescriptions row
    expect(screen.getByText('Prescriptions')).toBeDefined()
    // Recommendations row
    expect(screen.getByText('Recommendations')).toBeDefined()
  })

  it('shows zero counts when no biomarkers are passed for a blood test', () => {
    render(
      <EntrySettings
        event={baseEvent}
        biomarkers={[]}
        onDeleted={vi.fn()}
      />,
    )

    expect(screen.getByText('0')).toBeDefined()
  })

  it('renders the entry ID and a copy button', () => {
    render(
      <EntrySettings
        event={baseEvent}
        biomarkers={[]}
        onDeleted={vi.fn()}
      />,
    )

    expect(screen.getByText('test-event-1')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Copy entry ID' })).toBeDefined()
  })

  it('opens a confirm popover and calls deleteEntry + onDeleted on confirm', async () => {
    const onDeleted = vi.fn()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, id: 'test-event-1', deleted_visit_data: false, freed_bytes: 0 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <EntrySettings
        event={baseEvent}
        biomarkers={bloodTestBiomarkers}
        onDeleted={onDeleted}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Delete this entry/ }))

    // Popover opens
    await waitFor(() => {
      expect(screen.getByTestId('delete-confirm')).toBeDefined()
    })

    const confirmButton = await screen.findByTestId('delete-confirm-button')
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    expect(fetchMock.mock.calls[0][0]).toContain('/api/entry/test-event-1')
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE')

    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledTimes(1)
    })
  })

  it('surfaces an error message and does not call onDeleted when delete fails', async () => {
    const onDeleted = vi.fn()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ detail: 'Server exploded' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <EntrySettings
        event={baseEvent}
        biomarkers={[]}
        onDeleted={onDeleted}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Delete this entry/ }))
    const confirmButton = await screen.findByTestId('delete-confirm-button')
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(screen.getByText('Server exploded')).toBeDefined()
    })
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('does not call deleteEntry when cancel is clicked', async () => {
    const onDeleted = vi.fn()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    render(
      <EntrySettings
        event={baseEvent}
        biomarkers={[]}
        onDeleted={onDeleted}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Delete this entry/ }))
    await screen.findByTestId('delete-confirm')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(onDeleted).not.toHaveBeenCalled()
  })
})
