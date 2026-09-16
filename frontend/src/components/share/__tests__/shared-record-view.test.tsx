import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import { SharedRecordView } from '@/components/share/SharedRecordView'
import { SharedLoadError, SharedUnavailable } from '@/components/share/SharedStates'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { SharedFlowsheet, SharedRecord } from '@/lib/share'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const record: SharedRecord = {
  meta: {
    created_at: '2026-09-15T10:00:00+00:00',
    expires_at: '2026-09-22T10:00:00+00:00',
    last_updated: '2026-09-12T08:00:00+00:00',
    scope: { kind: 'all' },
    default_locale: null,
  },
  header: { name: 'Test User', dob: '1990-01-01', gender: 'Other' },
  events: [
    {
      id: 'blood-jan',
      type: 'blood_test',
      date: '2026-01-12T00:00:00+00:00',
      title: 'New Year Baseline',
      subtitle: '',
      category: 'Labs',
      status: '',
      clinic: 'CityLab Diagnostics',
      attachments: [],
    },
    {
      id: 'visit-1',
      type: 'doctor_visit',
      date: '2026-02-01T00:00:00+00:00',
      title: 'Cardiology follow-up',
      subtitle: '',
      category: 'Visits',
      status: '',
      clinic: 'Heart Center',
      attachments: [],
    },
  ],
  biomarkers: [
    {
      id: 'hb',
      entry_id: 'blood-jan',
      definition: {
        id: 'hb',
        names: { en: 'Hemoglobin', ru: 'Гемоглобин' },
        synonyms: [],
        unit: 'g/dL',
        category: 'Complete Blood Count',
        scope: 'global',
        reference: { kind: 'interval', low: 12, high: 16 },
        reference_source: 'global',
      },
      value: 10.2,
      date: '2026-01-12T00:00:00+00:00',
      status: 'low',
      history: [
        {
          entry_id: 'blood-may',
          date: '2025-05-05T00:00:00+00:00',
          value: 13.4,
          status: 'normal',
        },
        {
          entry_id: 'blood-oct',
          date: '2025-10-15T00:00:00+00:00',
          value: 11.8,
          status: 'low',
        },
      ],
      reference: { kind: 'interval', low: 12, high: 16 },
    },
    {
      id: 'tsh',
      entry_id: 'blood-jan',
      definition: {
        id: 'tsh',
        names: { en: 'TSH', ru: 'ТТГ' },
        synonyms: [],
        unit: 'mIU/L',
        category: 'Thyroid Panel',
        scope: 'global',
        reference: { kind: 'interval', low: 0.4, high: 4 },
        reference_source: 'global',
      },
      value: 9.9,
      date: '2026-01-12T00:00:00+00:00',
      status: 'high',
      // The app could not standardise this reading, so it must NOT be shown as
      // a confident flag — only in the full table (D13).
      needs_review: true,
      history: [],
    },
  ],
  visits: {
    'visit-1': {
      specialty: 'Cardiology',
      provider: 'Dr. Who',
      date: '2026-02-01T00:00:00+00:00',
      clinic: 'Heart Center',
      verdict: { original: 'Anaemia', translated_en: 'Anaemia' },
      notes: [],
      prescriptions: [],
      recommendations: [{ original: 'Repeat CBC', translated_en: 'Repeat CBC' }],
      attachments: [],
    },
  },
  instrumental: {},
}

const flowsheet: SharedFlowsheet = {
  dates: [{ label: 'Jan 12', sub: null, source_language: null }],
  matrix: [
    {
      category: 'Complete Blood Count',
      rows: [
        {
          id: 'hb',
          name: 'Hemoglobin',
          original: '',
          original_lang: null,
          unit: 'g/dL',
          reference: { kind: 'interval', low: 12, high: 16 },
          cells: [{ value: '10.2', status: 'low' }],
        },
      ],
    },
    {
      category: 'Thyroid Panel',
      rows: [
        {
          id: 'tsh',
          name: 'TSH',
          original: '',
          original_lang: null,
          unit: 'mIU/L',
          reference: { kind: 'interval', low: 0.4, high: 4 },
          cells: [{ value: '9.9', status: 'high', needs_review: true }],
        },
      ],
    },
  ],
  biomarkers: [],
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => flowsheet,
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const renderView = (locale = 'en') =>
  render(
    <TestI18nProvider locale={locale}>
      <SharedRecordView token="hp_test" record={record} locale={locale} />
    </TestI18nProvider>,
  )

describe('SharedRecordView', () => {
  it('opens on the orientation strip and the flagged results', () => {
    renderView()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Health record of Test User',
    )
    expect(screen.getByText(/Last updated/)).toBeInTheDocument()
    expect(screen.getByText(/This link expires/)).toBeInTheDocument()

    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument()
    // The low hemoglobin is the flag…
    expect(screen.getByText('10.2 g/dL')).toBeInTheDocument()
    // …and the reading the app could not standardise is not presented as one.
    expect(screen.queryByText('9.9 mIU/L')).not.toBeInTheDocument()
  })

  it('shows the trend series for a flagged biomarker', () => {
    renderView()
    expect(screen.getByRole('heading', { name: 'What changed' })).toBeInTheDocument()
    expect(screen.getByText('13.4 → 11.8 → 10.2')).toBeInTheDocument()
  })

  it('lists the non-lab history with its conclusion and recommendations', () => {
    renderView()
    expect(screen.getByText('Cardiology follow-up')).toBeInTheDocument()
    expect(screen.getByText('Anaemia')).toBeInTheDocument()
    expect(screen.getByText('Repeat CBC')).toBeInTheDocument()
    // Blood tests belong in the results table, not in the history list.
    expect(screen.queryByText('New Year Baseline')).not.toBeInTheDocument()
  })

  it('loads the full table separately and without a cache', async () => {
    renderView()
    await waitFor(() => expect(screen.getByText('TSH')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/share/flowsheet')
    expect(init).toMatchObject({
      cache: 'no-store',
      headers: { 'X-Share-Token': 'hp_test' },
      referrerPolicy: 'no-referrer',
    })
    // Rows in the shared table are text, not doors into the app: a recipient
    // has no details view, so the reused matrix gets no navigation callback.
    expect(screen.getByText('TSH').closest('[role="button"]')).toBeNull()
  })

  it('offers no owner affordances', () => {
    renderView()
    expect(screen.queryByRole('link', { name: /settings/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /add|upload/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    // The only outbound link is the conversion CTA.
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/')
    expect(links[0]).toHaveAttribute('rel', 'noreferrer')
  })

  it('renders the same record in Russian chrome', () => {
    renderView('ru')
    expect(screen.getByText('Требует внимания')).toBeInTheDocument()
    expect(screen.getByText(/Обновлено/)).toBeInTheDocument()
    // The persisted Russian name is used as-is (the public view must never
    // trigger a translation run): it appears in the flag card and the trend.
    expect(screen.getAllByText('Гемоглобин').length).toBeGreaterThan(0)
  })
})

describe('shared surface states', () => {
  it('renders one dead-link page that says nothing about the link', () => {
    render(
      <TestI18nProvider>
        <SharedUnavailable />
      </TestI18nProvider>,
    )
    expect(screen.getByText('This link is no longer active.')).toBeInTheDocument()
    expect(screen.getByText(/ask the person who shared it/)).toBeInTheDocument()
  })

  it('renders a retryable error for a non-404 failure', () => {
    render(
      <TestI18nProvider>
        <SharedLoadError />
      </TestI18nProvider>,
    )
    expect(screen.getByText('Could not load this record.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
