import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'

import { SharedUnlockGate } from '@/components/share/SharedUnlockGate'
import { sharedViewMessages } from '@/i18n/shared-messages'
import { SHARE_GRANT_STORAGE_KEY } from '@/lib/share'
import type { SharedRecord } from '@/lib/share'

/**
 * The client half of a passcode-protected link (Stage 4, S15).
 *
 * Three properties matter more than the wiring: the grant lives in
 * `sessionStorage` and never in a cookie or the URL, a stale grant falls back
 * to the prompt instead of a dead-link page, and the record's table read
 * carries the grant too (a table that 404s under a record that rendered is the
 * exact bug this guards).
 */

const record: SharedRecord = {
  meta: {
    created_at: '2026-09-15T10:00:00+00:00',
    expires_at: '2026-09-22T10:00:00+00:00',
    last_updated: '2026-09-12T08:00:00+00:00',
    scope: { kind: 'all' },
    default_locale: null,
  },
  header: { name: 'Test User', dob: '1990-01-01', gender: 'Other' },
  events: [],
  biomarkers: [],
  visits: {},
  instrumental: {},
}

const flowsheet = { dates: [], matrix: [], biomarkers: [] }

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(),
  } as unknown as Response
}

const fetchMock = vi.fn()

function renderGate() {
  return render(
    <NextIntlClientProvider locale="en" messages={sharedViewMessages('en')}>
      <SharedUnlockGate token="hp_test" locale="en" />
    </NextIntlClientProvider>,
  )
}

beforeEach(() => {
  fetchMock.mockReset()
  window.sessionStorage.clear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
})

describe('SharedUnlockGate', () => {
  it('shows the prompt first and unlocks into the record', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/share/unlock')) {
        return jsonResponse({
          grant: 'grant-1',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        })
      }
      if (url.endsWith('/api/share/record')) return jsonResponse(record)
      if (url === '/api/share/flowsheet') return jsonResponse(flowsheet)
      throw new Error(`unexpected ${url}`)
    })

    renderGate()
    // First paint is the prompt, not the record and not the dead-link page.
    expect(await screen.findByTestId('share-passcode-input')).toBeInTheDocument()
    expect(screen.queryByText('This link is no longer active.')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('share-passcode-input'), {
      target: { value: 'swordfish' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open record' }))

    expect(await screen.findByText('Health record of Test User')).toBeInTheDocument()
    // The unlock carried the code once, and the record read carried the grant.
    const recordCall = fetchMock.mock.calls.find(([url]) => url.endsWith('/api/share/record'))
    expect(recordCall?.[1].headers['X-Share-Grant']).toBe('grant-1')
  })

  it('keeps the grant in sessionStorage, never a cookie or the URL (S15)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/share/unlock')) {
        return jsonResponse({
          grant: 'grant-1',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        })
      }
      if (url.endsWith('/api/share/record')) return jsonResponse(record)
      if (url === '/api/share/flowsheet') return jsonResponse(flowsheet)
      throw new Error(`unexpected ${url}`)
    })

    renderGate()
    fireEvent.change(await screen.findByTestId('share-passcode-input'), {
      target: { value: 'swordfish' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open record' }))
    await screen.findByText('Health record of Test User')

    const stored = window.sessionStorage.getItem(SHARE_GRANT_STORAGE_KEY) ?? ''
    expect(stored).toContain('grant-1')
    // The share surface writes no cookie at all: a recipient is a stranger and
    // opening a link must not leave state the app later sends for them.
    expect(document.cookie).toBe('')
    // Nothing about the grant reached the address bar.
    expect(window.location.search).not.toContain('grant-1')
  })

  it('reuses a stored grant without asking for the passcode again', async () => {
    window.sessionStorage.setItem(
      SHARE_GRANT_STORAGE_KEY,
      JSON.stringify({
        token: 'hp_test',
        grant: 'stored-grant',
        expiresAt: Date.now() + 3_600_000,
      }),
    )
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/share/record')) return jsonResponse(record)
      if (url === '/api/share/flowsheet') return jsonResponse(flowsheet)
      throw new Error(`unexpected ${url}`)
    })

    renderGate()
    expect(await screen.findByText('Health record of Test User')).toBeInTheDocument()
    // No unlock call at all: the tab already holds a valid grant.
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/api/share/unlock'))).toBe(false)
  })

  it('ignores a stored grant that belongs to another link', async () => {
    window.sessionStorage.setItem(
      SHARE_GRANT_STORAGE_KEY,
      JSON.stringify({
        token: 'hp_some-other-link',
        grant: 'other-grant',
        expiresAt: Date.now() + 3_600_000,
      }),
    )
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/share/unlock')) {
        return jsonResponse({
          grant: 'grant-1',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        })
      }
      if (url.endsWith('/api/share/record')) return jsonResponse(record)
      if (url === '/api/share/flowsheet') return jsonResponse(flowsheet)
      throw new Error(`unexpected ${url}`)
    })

    renderGate()
    expect(await screen.findByTestId('share-passcode-input')).toBeInTheDocument()
  })

  it('drops an expired stored grant rather than sending it to be refused', async () => {
    window.sessionStorage.setItem(
      SHARE_GRANT_STORAGE_KEY,
      JSON.stringify({
        token: 'hp_test',
        grant: 'stale-grant',
        expiresAt: Date.now() - 1000,
      }),
    )
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/share/record')) return jsonResponse(record)
      throw new Error(`unexpected ${url}`)
    })

    renderGate()
    expect(await screen.findByTestId('share-passcode-input')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/api/share/record'))).toBe(false)
    expect(window.sessionStorage.getItem(SHARE_GRANT_STORAGE_KEY)).toBeNull()
  })

  it('shows one line for a wrong passcode, and keeps the prompt', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/share/unlock')) return jsonResponse({ detail: 'no' }, 400)
      throw new Error(`unexpected ${url}`)
    })

    renderGate()
    fireEvent.change(await screen.findByTestId('share-passcode-input'), {
      target: { value: 'wrong' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open record' }))

    expect(await screen.findByText('That passcode is not correct.')).toBeInTheDocument()
    // Still the prompt, so the recipient can simply try again.
    expect(screen.getByTestId('share-passcode-input')).toBeInTheDocument()
  })

  it('tells the recipient to wait when the link is throttled', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/share/unlock')) return jsonResponse({ detail: 'slow down' }, 429)
      throw new Error(`unexpected ${url}`)
    })

    renderGate()
    fireEvent.change(await screen.findByTestId('share-passcode-input'), {
      target: { value: 'wrong' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open record' }))

    expect(
      await screen.findByText('Too many attempts. Try again in a few minutes.'),
    ).toBeInTheDocument()
  })

  it('falls back to the prompt when a stored grant is no longer valid', async () => {
    window.sessionStorage.setItem(
      SHARE_GRANT_STORAGE_KEY,
      JSON.stringify({
        token: 'hp_test',
        grant: 'revoked-grant',
        expiresAt: Date.now() + 3_600_000,
      }),
    )
    // The backend answers a dead link and a stale grant with the same 404, so
    // this path must show the prompt rather than claim the link is dead.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/share/record')) return jsonResponse({ detail: 'x' }, 404)
      if (url.endsWith('/api/share/unlock')) {
        return jsonResponse({
          grant: 'grant-2',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        })
      }
      if (url === '/api/share/flowsheet') return jsonResponse(flowsheet)
      throw new Error(`unexpected ${url}`)
    })

    renderGate()
    expect(await screen.findByTestId('share-passcode-input')).toBeInTheDocument()
    expect(window.sessionStorage.getItem(SHARE_GRANT_STORAGE_KEY)).toBeNull()
    // F3: a 404 here means a stale GRANT, not a dead link — the page was only
    // mounted because /status said the link is live and protected, and the two
    // answers are indistinguishable by design. Claiming the link is dead would
    // assert something we cannot know.
    expect(screen.queryByText('This link is no longer active.')).not.toBeInTheDocument()
  })

  it('addresses every BROWSER read same-origin, never the backend origin (regression)', async () => {
    // Found live: the unlock and the client-side record read addressed
    // STATIC_PROXY_URL directly, which is a DIFFERENT ORIGIN from the page, so
    // a protected link could never be opened in a real browser. The Next
    // rewrite proxies same-origin `/api/*` instead.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/share/unlock')) {
        return jsonResponse({
          grant: 'grant-1',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        })
      }
      if (url.includes('/api/share/record')) return jsonResponse(record)
      if (url === '/api/share/flowsheet') return jsonResponse(flowsheet)
      throw new Error(`unexpected ${url}`)
    })

    renderGate()
    fireEvent.change(await screen.findByTestId('share-passcode-input'), {
      target: { value: 'swordfish' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open record' }))
    await screen.findByText('Health record of Test User')

    const browserCalls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(browserCalls.length).toBeGreaterThan(0)
    for (const url of browserCalls) {
      expect(url.startsWith('/api/share/')).toBe(true)
      expect(url).not.toContain('http://')
    }
  })

  it('sends the grant with the results-table read, not only the record', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/share/unlock')) {
        return jsonResponse({
          grant: 'grant-1',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        })
      }
      if (url.endsWith('/api/share/record')) return jsonResponse(record)
      if (url === '/api/share/flowsheet') return jsonResponse(flowsheet)
      throw new Error(`unexpected ${url}`)
    })

    renderGate()
    fireEvent.change(await screen.findByTestId('share-passcode-input'), {
      target: { value: 'swordfish' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open record' }))
    await screen.findByText('Health record of Test User')

    await waitFor(() => {
      const flowsheetCall = fetchMock.mock.calls.find(([url]) => url === '/api/share/flowsheet')
      expect(flowsheetCall?.[1].headers['X-Share-Grant']).toBe('grant-1')
    })
  })
})
