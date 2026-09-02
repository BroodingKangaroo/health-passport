import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LandingGate } from '../landing/landing-gate'
import { useTimelineData } from '@/hooks/useTimelineData'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import { ThemeProvider } from '@/providers/theme-provider'
import type { TimelineResponse } from '@/lib/types'

vi.mock('@/hooks/useTimelineData', () => ({ useTimelineData: vi.fn() }))
vi.mock('@/views/TimelineView', () => ({
  TimelineView: () => <div data-testid="timeline-view" />,
}))
vi.mock('../landing/landing-hero', () => ({
  LandingHero: () => <div data-testid="landing-hero" />,
}))

const mockUseTimelineData = vi.mocked(useTimelineData)

beforeAll(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
})

const renderGate = ((ui: React.ReactElement) =>
  render(
    <ThemeProvider>
      <TestI18nProvider>{ui}</TestI18nProvider>
    </ThemeProvider>,
  )) as typeof render

describe('LandingGate', () => {
  beforeEach(() => {
    mockUseTimelineData.mockReset()
  })

  it('shows the landing hero for a zero-entry visitor', () => {
    mockUseTimelineData.mockReturnValue({
      data: { events: [] } as unknown as TimelineResponse,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    })

    renderGate(<LandingGate />)

    expect(screen.getByTestId('landing-hero')).toBeInTheDocument()
    expect(screen.queryByTestId('timeline-view')).not.toBeInTheDocument()
  })

  it('goes straight to the timeline when the user has entries', () => {
    mockUseTimelineData.mockReturnValue({
      data: { events: [{ id: 'e1' }] } as unknown as TimelineResponse,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    })

    renderGate(<LandingGate />)

    expect(screen.getByTestId('timeline-view')).toBeInTheDocument()
    expect(screen.queryByTestId('landing-hero')).not.toBeInTheDocument()
  })

  it('never shows the hero while loading', () => {
    mockUseTimelineData.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    })

    renderGate(<LandingGate />)

    expect(screen.getByTestId('timeline-view')).toBeInTheDocument()
    expect(screen.queryByTestId('landing-hero')).not.toBeInTheDocument()
  })

  it('never shows the hero on a timeline fetch error (existing user must not see marketing)', () => {
    mockUseTimelineData.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('network down'),
      refetch: vi.fn(),
    })

    renderGate(<LandingGate />)

    expect(screen.getByTestId('timeline-view')).toBeInTheDocument()
    expect(screen.queryByTestId('landing-hero')).not.toBeInTheDocument()
  })
})
