import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LandingHero } from '../landing/landing-hero'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import { ThemeProvider } from '@/providers/theme-provider'
import { useAuthStatus } from '@/components/providers/AuthStatusProvider'
import { fetchUsageLimits } from '@/services/api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/services/api', () => ({
  fetchUsageLimits: vi.fn(),
}))

vi.mock('@/components/providers/AuthStatusProvider', () => ({
  useAuthStatus: vi.fn(),
}))

beforeAll(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
})

const renderHero = (ui: React.ReactElement, locale = 'en') =>
  render(
    <ThemeProvider>
      <QueryClientProvider client={new QueryClient()}>
        <TestI18nProvider locale={locale}>{ui}</TestI18nProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  )

const mockUseAuthStatus = vi.mocked(useAuthStatus)
const mockFetchUsageLimits = vi.mocked(fetchUsageLimits)

beforeAll(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
})

beforeEach(() => {
  window.localStorage.clear()
  mockUseAuthStatus.mockReturnValue({
    status: 'unauthenticated',
    user: null,
    anonId: null,
    refresh: vi.fn(),
  })
  mockFetchUsageLimits.mockResolvedValue({
    is_anonymous: true,
    ai_extraction_count: 0,
    ai_extraction_limit: 5,
    total_upload_size_bytes: 0,
    total_upload_limit_bytes: 52428800,
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('LandingHero', () => {
  it('renders the mission-led headline, CTAs, and ownership badges (EN)', async () => {
    renderHero(<LandingHero />)

    expect(
      screen.getByRole('heading', { level: 1, name: 'Your labs, decoded' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Try without an account' })).toHaveAttribute(
      'href',
      '/add-entry',
    )
    expect(screen.getAllByRole('link', { name: 'Sign in' }).every((l) => l.getAttribute('href') === '/login')).toBe(true)
    expect(screen.getByText('Delete everything, anytime')).toBeInTheDocument()
    expect(screen.getByText('Export anytime')).toBeInTheDocument()
    expect(screen.getByText('Anonymous trial')).toBeInTheDocument()
    expect(
      await screen.findByText(
        'Documents are processed by an AI service and are not stored there. You can delete or export your data at any time.',
      ),
    ).toBeInTheDocument()
  })

  it('interpolates the trial-extraction count from the backend limits', async () => {
    renderHero(<LandingHero />)

    expect(await screen.findByText('5 free document extractions · no email required')).toBeInTheDocument()
    expect(mockFetchUsageLimits).toHaveBeenCalledTimes(1)
  })

  it('hides trial CTAs and shows an add-first-entry CTA for authenticated users', async () => {
    mockUseAuthStatus.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'u1',
        name: 'Test User',
        email: 't@example.com',
        dob: '1990-01-01',
        gender: 'other',
        external_id: '',
      },
      anonId: null,
      refresh: vi.fn(),
    })
    renderHero(<LandingHero />)

    expect(screen.getByRole('link', { name: 'Add your first entry' })).toHaveAttribute(
      'href',
      '/add-entry',
    )
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument()
    expect(screen.queryByText('Try without an account')).not.toBeInTheDocument()
    expect(screen.queryByText('5 free document extractions · no email required')).not.toBeInTheDocument()
    expect(mockFetchUsageLimits).not.toHaveBeenCalled()
  })

  it('shows the how-it-works steps', () => {
    renderHero(<LandingHero />)

    expect(screen.getByText('How it works')).toBeInTheDocument()
    expect(screen.getByText('Upload a document')).toBeInTheDocument()
    expect(screen.getByText('We decode it')).toBeInTheDocument()
    expect(screen.getByText('See your story')).toBeInTheDocument()
  })

  it('renders Russian copy in the ru locale', async () => {
    renderHero(<LandingHero />, 'ru')

    expect(
      screen.getByRole('heading', { level: 1, name: 'Ваши анализы — расшифрованы' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Попробовать без аккаунта' }),
    ).toHaveAttribute('href', '/add-entry')
    expect(await screen.findByText('5 бесплатных расшифровок документов · без email')).toBeInTheDocument()
  })
})
