import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { TimelineContent } from '@/views/TimelineView'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { MedicalEvent, TimelineResponse } from '@/lib/types'

const bloodTest: MedicalEvent = {
  id: 'evt-1',
  date: 'Jan 15, 2027',
  type: 'blood_test',
  title: 'Test Panel',
  clinic: 'Test Lab',
  attachments: [],
}

const data: TimelineResponse = {
  events: [bloodTest],
  biomarkers: [],
  visits: {},
  instrumental: {},
}

const oldest: MedicalEvent = {
  id: 'evt-1',
  date: 'Jan 15, 2027',
  type: 'blood_test',
  title: 'Panel One',
  clinic: 'Test Lab',
  attachments: [],
}

const middle: MedicalEvent = {
  id: 'evt-2',
  date: 'Feb 15, 2027',
  type: 'blood_test',
  title: 'Panel Two',
  clinic: 'Test Lab',
  attachments: [],
}

const newest: MedicalEvent = {
  id: 'evt-3',
  date: 'Mar 15, 2027',
  type: 'blood_test',
  title: 'Panel Three',
  clinic: 'Test Lab',
  attachments: [],
}

// Events arrive ascending (oldest first), like the backend payload.
const threeEvents: TimelineResponse = {
  events: [oldest, middle, newest],
  biomarkers: [],
  visits: {},
  instrumental: {},
}

function renderTimeline(payload: TimelineResponse) {
  return render(
    <TestI18nProvider>
      <TimelineContent data={payload} isLoading={false} error={null} refetch={vi.fn()} />
    </TestI18nProvider>,
  )
}

function stubBelowLg() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      // Below lg = Tailwind's `(min-width: 64rem)` does NOT match.
      matches: !query.includes('min-width'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('TimelineContent shell', () => {
  it('renders both panes with the newest event selected', () => {
    renderTimeline(data)

    expect(screen.getByRole('region', { name: 'History' })).toBeInTheDocument()
    // The entry title shows on the history card AND as the details heading
    // (the details pane displays it in full instead of "Blood Test Results").
    expect(screen.getAllByText('Test Panel')).toHaveLength(2)
    expect(screen.queryByText('Blood Test Results')).toBeNull()
    expect(screen.getByPlaceholderText('Search biomarkers...')).toBeInTheDocument()
    // A single event has nothing to step through — no dead switcher controls.
    expect(screen.queryByRole('group', { name: 'Event navigation' })).toBeNull()
  })

  it('renders the mobile switcher with the newest event selected', () => {
    renderTimeline(threeEvents)

    const switcher = screen.getByRole('group', { name: 'Event navigation' })
    expect(within(switcher).getByText('3/3')).toBeInTheDocument()
    expect(within(switcher).getByText('Panel Three')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next event' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous event' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Back to history list' })).toBeInTheDocument()
  })

  it('steps older and newer from the switcher without scrolling', () => {
    renderTimeline(threeEvents)
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')

    fireEvent.click(screen.getByRole('button', { name: 'Previous event' }))
    expect(within(screen.getByRole('group', { name: 'Event navigation' })).getByText('2/3')).toBeInTheDocument()
    expect(screen.getAllByText('Panel Two').length).toBeGreaterThanOrEqual(2)

    fireEvent.click(screen.getByRole('button', { name: 'Previous event' }))
    expect(within(screen.getByRole('group', { name: 'Event navigation' })).getByText('1/3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous event' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Next event' }))
    expect(within(screen.getByRole('group', { name: 'Event navigation' })).getByText('2/3')).toBeInTheDocument()

    // Stepping the pane never triggers the master-detail scroll.
    expect(spy).not.toHaveBeenCalled()
  })

  it('below lg, selecting a card scrolls the details into view and focuses them', async () => {
    stubBelowLg()
    const { container } = renderTimeline(threeEvents)
    const section = container.querySelector('section')
    expect(section).not.toBeNull()
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')

    fireEvent.click(screen.getByRole('button', { name: /Panel One/ }))

    await waitFor(() => expect(spy).toHaveBeenCalledWith({ block: 'start' }))
    expect(document.activeElement).toBe(section)
  })

  it('without a below-lg matchMedia (desktop/jsdom) selecting does not scroll', () => {
    const { container } = renderTimeline(threeEvents)
    const section = container.querySelector('section')
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')

    fireEvent.click(screen.getByRole('button', { name: /Panel One/ }))

    expect(spy).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(section)
  })

  it('back-to-history scrolls the list into view and focuses the rail region', () => {
    const { container } = renderTimeline(threeEvents)
    const aside = container.querySelector('aside')
    expect(aside).not.toBeNull()
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')

    fireEvent.click(screen.getByRole('button', { name: 'Back to history list' }))

    expect(spy).toHaveBeenCalledWith({ block: 'start' })
    expect(document.activeElement).toBe(within(aside as HTMLElement).getByRole('region', { name: 'History' }))
  })
})
