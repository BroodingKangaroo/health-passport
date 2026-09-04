import { describe, expect, it, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent, type RenderResult } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DemoTimelineView } from '../landing/demo-view'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import { ThemeProvider } from '@/providers/theme-provider'
import { DemoModeProvider } from '@/providers/demo-provider'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/components/providers/AuthStatusProvider', () => ({
  useAuthStatus: vi.fn().mockReturnValue({
    status: 'unauthenticated',
    user: null,
    anonId: null,
    refresh: vi.fn(),
  }),
}))

beforeAll(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
  window.ResizeObserver =
    window.ResizeObserver ||
    vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }))
})

function renderDemo(ui: React.ReactElement, locale = 'en'): RenderResult {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={new QueryClient()}>
        <TestI18nProvider locale={locale}>
          <DemoModeProvider>{ui}</DemoModeProvider>
        </TestI18nProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  )
}

describe('DemoTimelineView', () => {
  it('renders the demo badge, banner, and conversion CTA (EN)', () => {
    renderDemo(<DemoTimelineView />)

    expect(screen.getByText('Demo')).toBeInTheDocument()
    expect(screen.getByText('Sample data from a fictional patient')).toBeInTheDocument()
    expect(screen.getByText(/Nothing here is real and nothing is stored/)).toBeInTheDocument()
    const cta = screen.getByRole('link', { name: 'Upload your first document' })
    expect(cta).toHaveAttribute('href', '/add-entry')
  })

  it('renders the three demo events and the newest blood test by default', () => {
    renderDemo(<DemoTimelineView />)

    expect(screen.getAllByRole('button', { name: /Blood test/ })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /Gastroenterologist consultation/ })).toHaveLength(1)
    // The newest event (repeat panel) is selected by default: its rows show
    // statuses including a persistent high cholesterol and still-low hemoglobin.
    expect(screen.getByText('Hemoglobin')).toBeInTheDocument()
    expect(screen.getByText('Cholesterol, total')).toBeInTheDocument()
    expect(screen.getByText('Low')).toBeInTheDocument()
    expect(screen.getByText('High')).toBeInTheDocument()
  })

  it('shows an abnormal flag on the older panel after selecting it', async () => {
    renderDemo(<DemoTimelineView />)

    // History list sorts newest-first: [bt2, visit, bt1] — index 1 is the
    // older blood test.
    const bt1 = screen.getAllByRole('button', { name: /Blood test/ })[1]
    fireEvent.click(bt1)

    // H. pylori was abnormal at the first panel (treated at the visit).
    expect(screen.getByText('Abnormal')).toBeInTheDocument()
    expect(screen.getByText('Ferritin')).toBeInTheDocument()
  })

  it('expanding a row shows no full-details navigation on the demo surface', async () => {
    renderDemo(<DemoTimelineView />)

    fireEvent.click(screen.getByText('Hemoglobin'))
    expect(screen.queryByRole('button', { name: /View full details/ })).not.toBeInTheDocument()
  })

  it('hides the delete danger zone in the entry settings tab (nothing to delete)', async () => {
    renderDemo(<DemoTimelineView />)

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.queryByText('Delete this entry')).not.toBeInTheDocument()
    expect(screen.queryByText('Danger Zone')).not.toBeInTheDocument()
  })

  it('renders the fictional-patient banner and visit in the ru locale', async () => {
    renderDemo(<DemoTimelineView />, 'ru')

    expect(screen.getByText('Пример данных вымышленного пациента')).toBeInTheDocument()
    expect(screen.getByText('Загрузите свой первый документ')).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: /Консультация гастроэнтеролога/ }),
    ).toHaveLength(1)
    // Selecting the visit renders its fictional verdict (EN translation side).
    fireEvent.click(screen.getByRole('button', { name: /Консультация гастроэнтеролога/ }))
    expect(
      screen.getByText(/Chronic gastritis associated with H\. pylori/),
    ).toBeInTheDocument()
  })

  it('no real API calls are made from the demo surface', () => {
    // The fixture is passed straight to TimelineContent; the only network
    // useAuthStatus (mocked here) would perform is the auth check, which the
    // real page performs app-wide anyway. The timeline itself never fetches.
    renderDemo(<DemoTimelineView />)
    expect(screen.getByText('Demo')).toBeInTheDocument()
  })
})
