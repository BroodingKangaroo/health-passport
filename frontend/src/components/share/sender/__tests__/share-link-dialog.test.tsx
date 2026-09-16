import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ShareLinkButton } from '@/components/share/sender/share-link-dialog'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { FlowsheetResponse } from '@/lib/types'

const createShareLink = vi.fn()
const fetchFlowsheetData = vi.fn()
const translateBiomarkerNames = vi.fn()

vi.mock('@/services/api', () => ({
  createShareLink: (input: unknown) => createShareLink(input),
  fetchFlowsheetData: () => fetchFlowsheetData(),
  translateBiomarkerNames: (lang: string, names: unknown, opts?: unknown) =>
    translateBiomarkerNames(lang, names, opts),
}))

// `useAuthPrincipal` reads the next-auth session: an authenticated session is a
// registered sender, a resolved null session is an anonymous one.
const session = vi.hoisted(() => ({
  current: { data: null, status: 'unauthenticated' } as {
    data: { user: { id: string } } | null
    status: string
  },
}))
vi.mock('next-auth/react', () => ({ useSession: () => session.current }))

const created = {
  id: 'link-1',
  token: 'hp_abc123',
  created_at: '2026-09-15T10:00:00+00:00',
  expires_at: '2026-09-22T10:00:00+00:00',
  scope: { kind: 'all' as const },
  include_header: true,
  default_locale: null,
}

const renderButton = () =>
  render(
    <TestI18nProvider>
      <ShareLinkButton />
    </TestI18nProvider>,
  )

function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Share a link' }))
}

beforeEach(() => {
  createShareLink.mockReset()
  fetchFlowsheetData.mockReset()
  fetchFlowsheetData.mockResolvedValue({ dates: [], matrix: [], biomarkers: [] })
  translateBiomarkerNames.mockReset()
  translateBiomarkerNames.mockResolvedValue({ names: new Map(), categories: {} })
  // Registered by default: the anonymous variant is the exception and sets it.
  session.current = { data: { user: { id: 'user-1' } }, status: 'authenticated' }
})

/** The minimal flowsheet response the translate-now step reads: matrix rows
 *  are the record's biomarkers, `biomarkers` carries their definitions. */
function flowsheetWith(
  rows: { id: string; name: string; ru?: string }[],
  ghostDefs: { id: string; name?: string; ru?: string }[] = [],
): FlowsheetResponse {
  return {
    dates: [],
    matrix: [
      {
        category: 'Complete Blood Count',
        rows: rows.map((row) => ({
          id: row.id,
          name: row.name,
          original: '',
          original_lang: null,
          unit: '',
          reference: null,
          cells: [],
        })),
      },
    ],
    biomarkers: [...rows, ...ghostDefs].map((row) => ({
      id: row.id,
      entry_id: 'evt',
      definition: {
        id: row.id,
        names: row.ru ? { en: row.name, ru: row.ru } : { en: row.name },
        synonyms: [],
        category: 'Complete Blood Count',
        unit: '',
        reference: null,
        scope: 'global',
        reference_source: 'global',
      },
      value: 1,
      date: '2026-01-01T00:00:00+00:00',
      status: 'normal',
      history: [],
    })),
  } as unknown as FlowsheetResponse
}

describe('ShareLinkButton', () => {
  it('creates a link with the chosen scope, expiry and header, and shows the URL exactly once', async () => {
    createShareLink.mockResolvedValue(created)
    renderButton()
    openDialog()

    expect(await screen.findByText(/Anyone with this link can view your record/)).toBeInTheDocument()
    expect(screen.getByText(/including anyone it gets forwarded to/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Date range' }))
    fireEvent.change(screen.getByTestId('share-scope-from'), { target: { value: '2026-01-01' } })
    fireEvent.change(screen.getByTestId('share-scope-to'), { target: { value: '2026-03-31' } })
    fireEvent.click(screen.getByRole('radio', { name: '30 days' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    await waitFor(() =>
      expect(createShareLink).toHaveBeenCalledWith({
        expiry_days: 30,
        scope: { kind: 'range', from: '2026-01-01', to: '2026-03-31' },
        include_header: true,
        default_locale: null,
      }),
    )

    const link = await screen.findByText(/\/s\/hp_abc123$/)
    // The token is only ever offered as a copyable link — never as a stored,
    // re-displayable value on the sender's side.
    expect(link).toBeInTheDocument()
    expect(createShareLink).toHaveBeenCalledTimes(1)
  })

  it('sends the whole record by default and honours a cleared header checkbox', async () => {
    createShareLink.mockResolvedValue(created)
    renderButton()
    openDialog()

    // The header defaults ON (S6); clearing it must travel as an explicit false.
    fireEvent.click(await screen.findByTestId('share-include-header'))
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    await waitFor(() =>
      expect(createShareLink).toHaveBeenCalledWith({
        expiry_days: 7,
        scope: null,
        include_header: false,
        default_locale: null,
      }),
    )
  })

  it('sends an open-ended range when only one end is filled in', async () => {
    createShareLink.mockResolvedValue(created)
    renderButton()
    openDialog()

    fireEvent.click(screen.getByRole('radio', { name: 'Date range' }))
    fireEvent.change(screen.getByTestId('share-scope-from'), { target: { value: '2026-01-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    await waitFor(() =>
      expect(createShareLink).toHaveBeenCalledWith({
        expiry_days: 7,
        scope: { kind: 'range', from: '2026-01-01', to: null },
        include_header: true,
        default_locale: null,
      }),
    )
  })

  it('refuses an inverted range instead of letting the request come back refused', async () => {
    createShareLink.mockResolvedValue(created)
    renderButton()
    openDialog()

    fireEvent.click(screen.getByRole('radio', { name: 'Date range' }))
    fireEvent.change(screen.getByTestId('share-scope-from'), { target: { value: '2026-03-31' } })
    fireEvent.change(screen.getByTestId('share-scope-to'), { target: { value: '2026-01-01' } })

    expect(await screen.findByText('The end date must be after the start date.')).toBeInTheDocument()
    const submit = screen.getByRole('button', { name: 'Create link' })
    expect(submit).toBeDisabled()
    fireEvent.click(submit)
    expect(createShareLink).not.toHaveBeenCalled()
  })

  it('offers 1, 7 and 30 days to a registered sender, with no cookie warning', async () => {
    renderButton()
    openDialog()

    expect(await screen.findByRole('radio', { name: '1 day' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '7 days' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '30 days' })).toBeInTheDocument()
    expect(screen.queryByText(/You are not signed in/)).toBeNull()
  })

  it('offers only 1 and 7 days to an anonymous sender, and says why', async () => {
    session.current = { data: null, status: 'unauthenticated' }
    renderButton()
    openDialog()

    expect(await screen.findByRole('radio', { name: '1 day' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '7 days' })).toBeInTheDocument()
    // S4: the server refuses 30 days for an anonymous principal, so the dialog
    // must never imply it is available.
    expect(screen.queryByRole('radio', { name: '30 days' })).toBeNull()
    expect(screen.getByText(/You are not signed in/)).toBeInTheDocument()
    expect(screen.getByText(/these links can no longer be revoked/)).toBeInTheDocument()
  })

  it('has no notes toggle — entry notes never travel', async () => {
    renderButton()
    openDialog()

    await screen.findByRole('button', { name: 'Create link' })
    expect(screen.queryByText(/notes/i)).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /notes/i })).toBeNull()
  })

  it('renders the Russian dialog copy (ICU plurals included)', async () => {
    session.current = { data: null, status: 'unauthenticated' }
    render(
      <TestI18nProvider locale="ru">
        <ShareLinkButton />
      </TestI18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Поделиться ссылкой' }))
    expect(await screen.findByRole('radio', { name: '7 дней' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '1 день' })).toBeInTheDocument()
    expect(screen.getByText(/Вы не вошли в аккаунт/)).toBeInTheDocument()
  })

  it('sends no language preset by default, so the recipient browser decides', async () => {
    createShareLink.mockResolvedValue(created)
    renderButton()
    openDialog()

    expect(await screen.findByRole('radio', { name: "Recipient's choice" })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    await waitFor(() =>
      expect(createShareLink).toHaveBeenCalledWith({
        expiry_days: 7,
        scope: null,
        include_header: true,
        default_locale: null,
      }),
    )
  })

  it('pins the link to Russian, which the recipient can still override on the page', async () => {
    createShareLink.mockResolvedValue({ ...created, default_locale: 'ru' })
    renderButton()
    openDialog()

    fireEvent.click(await screen.findByRole('radio', { name: 'Russian' }))
    const hint = screen.getByText(/The recipient can still switch it on the page/)
    expect(hint).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    await waitFor(() =>
      expect(createShareLink).toHaveBeenCalledWith({
        expiry_days: 7,
        scope: null,
        include_header: true,
        default_locale: 'ru',
      }),
    )
  })

  it('offers translate-now for a Russian link only while Russian names are missing', async () => {
    createShareLink.mockResolvedValue({ ...created, default_locale: 'ru' })
    fetchFlowsheetData.mockResolvedValue(
      flowsheetWith([
        { id: 'hb', name: 'Hemoglobin' },
        { id: 'tsh', name: 'TSH', ru: 'ТТГ' },
      ]),
    )
    renderButton()
    openDialog()

    // No Russian preset, no translate step.
    expect(screen.queryByTestId('share-translate-now')).toBeNull()
    fireEvent.click(await screen.findByRole('radio', { name: 'Russian' }))
    // Only the missing ones (hemoglobin, not TSH) make it onto the payload,
    // and the cost is stated before the sender commits.
    expect(await screen.findByTestId('share-translate-now')).toBeInTheDocument()
    expect(screen.getByText(/spends one AI translation from your quota/)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('share-translate-now'))
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    await waitFor(() => expect(createShareLink).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(translateBiomarkerNames).toHaveBeenCalledWith(
        'ru',
        [{ id: 'hb', name: 'Hemoglobin' }],
        { persist: true },
      ),
    )
    expect(await screen.findByText('Names translated to Russian.')).toBeInTheDocument()
  })

  it('scopes the translate payload to the record, never the whole dictionary', async () => {
    createShareLink.mockResolvedValue({ ...created, default_locale: 'ru' })
    // Only `hb` is a matrix row (a real biomarker in the record); `ghost` is
    // a definition the dialog could see elsewhere but the record never
    // references — the 1500-LOINC-dictionary case in miniature.
    fetchFlowsheetData.mockResolvedValue(
      flowsheetWith([{ id: 'hb', name: 'Hemoglobin' }], [{ id: 'ghost' }]),
    )
    renderButton()
    openDialog()

    fireEvent.click(await screen.findByRole('radio', { name: 'Russian' }))
    fireEvent.click(await screen.findByTestId('share-translate-now'))
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    await waitFor(() =>
      expect(translateBiomarkerNames).toHaveBeenCalledWith(
        'ru',
        [{ id: 'hb', name: 'Hemoglobin' }],
        { persist: true },
      ),
    )
  })

  it('hides translate-now from anonymous senders and never fetches their defs', async () => {
    createShareLink.mockResolvedValue(created)
    session.current = { data: null, status: 'unauthenticated' }
    fetchFlowsheetData.mockResolvedValue(flowsheetWith([{ id: 'hb', name: 'Hemoglobin' }]))
    renderButton()
    openDialog()

    fireEvent.click(await screen.findByRole('radio', { name: 'Russian' }))
    expect(screen.queryByTestId('share-translate-now')).toBeNull()
    expect(fetchFlowsheetData).not.toHaveBeenCalled()
  })

  it('still creates the link when the translation fails — declining is always allowed', async () => {
    createShareLink.mockResolvedValue({ ...created, default_locale: 'ru' })
    fetchFlowsheetData.mockResolvedValue(flowsheetWith([{ id: 'hb', name: 'Hemoglobin' }]))
    translateBiomarkerNames.mockRejectedValue(new Error('LLM down'))
    renderButton()
    openDialog()

    fireEvent.click(await screen.findByRole('radio', { name: 'Russian' }))
    fireEvent.click(await screen.findByTestId('share-translate-now'))
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    expect(await screen.findByText(/\/s\/hp_abc123$/)).toBeInTheDocument()
    expect(await screen.findByText(/Could not translate the names/)).toBeInTheDocument()
  })
})
