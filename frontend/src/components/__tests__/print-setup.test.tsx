import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { PrintSetup } from '@/components/health-passport/print-setup'
import { PrintConfigProvider } from '@/providers/print-config-provider'
import { LeaveGuardProvider } from '@/providers/leave-guard-provider'
import type { FlowsheetResponse } from '@/lib/types'
import type { TranslatedName } from '@/services/api'

const mockPush = vi.fn()
const mockFetchFlowsheet = vi.fn()
const mockTranslate = vi.fn()
const mockCommit = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('@/services/api', () => ({
  fetchFlowsheetData: (...args: unknown[]) => mockFetchFlowsheet(...args),
  translateBiomarkerNames: (...args: unknown[]) => mockTranslate(...args),
  commitTranslatedNames: (...args: unknown[]) => mockCommit(...args),
}))

const FLOWSHEET: FlowsheetResponse = {
  dates: [],
  matrix: [
    {
      category: 'Complete Blood Count',
      rows: [
        {
          id: 'wbc',
          name: 'WBC',
          original: 'Лейкоциты',
          unit: 'K/µL',
          reference: null,
          cells: [{ value: '6.5', status: 'normal' }],
        },
        {
          id: 'hb',
          name: 'Hemoglobin',
          original: 'Гемоглобин',
          unit: 'g/dL',
          reference: null,
          cells: [{ value: '13.5', status: 'normal' }],
        },
      ],
    },
  ],
  biomarkers: [],
}

function translatedMap(
  entries: Record<string, TranslatedName>,
): Map<string, TranslatedName> {
  return new Map(Object.entries(entries))
}

function renderComponent() {
  return render(
    <LeaveGuardProvider>
      <PrintConfigProvider>
        <PrintSetup />
      </PrintConfigProvider>
    </LeaveGuardProvider>,
  )
}

function selectTranslateModeAndLang(lang: string) {
  fireEvent.click(screen.getAllByRole('radio')[1])
  fireEvent.change(screen.getByRole('combobox'), { target: { value: lang } })
}

/** Click the Generate button INSIDE the review dialog (the setup screen's
 * button shares the same accessible name). */
function confirmPreview() {
  const buttons = screen.getAllByRole('button', { name: /Generate Document/ })
  fireEvent.click(buttons[buttons.length - 1])
}

describe('PrintSetup', () => {
  beforeEach(() => {
    mockPush.mockClear()
    mockFetchFlowsheet.mockClear()
    mockTranslate.mockClear()
    mockCommit.mockClear()
    mockCommit.mockResolvedValue(2)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the title and description', () => {
    renderComponent()
    expect(screen.getByText('Prepare Document for Print/Export')).toBeTruthy()
  })

  it('renders all three mode options without hardcoding a source language', () => {
    renderComponent()
    expect(screen.getByText('Keep Original')).toBeTruthy()
    expect(screen.queryByText(/Keep Original \(Russian\)/)).toBeNull()
    expect(screen.getByText('Translate to\u2026')).toBeTruthy()
    expect(screen.getByText('Bilingual Format')).toBeTruthy()
  })

  it('has Keep Original selected by default', () => {
    renderComponent()
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios[0].checked).toBe(true)
    expect(radios[1].checked).toBe(false)
    expect(radios[2].checked).toBe(false)
  })

  it('shows language dropdown when translate mode is selected', () => {
    renderComponent()
    const translateRadio = screen.getAllByRole('radio')[1]
    fireEvent.click(translateRadio)
    expect(screen.getByRole('combobox')).toBeTruthy()
  })

  it('shows language dropdown when bilingual mode is selected', () => {
    renderComponent()
    const bilingualRadio = screen.getAllByRole('radio')[2]
    fireEvent.click(bilingualRadio)
    expect(screen.getByRole('combobox')).toBeTruthy()
  })

  it('does not show language dropdown in original mode', () => {
    renderComponent()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('navigates to /print-editor on Generate Document click', () => {
    renderComponent()
    fireEvent.click(screen.getByText('Generate Document'))
    expect(mockPush).toHaveBeenCalledWith('/print-editor')
  })

  it('selecting a mode updates the radio state', () => {
    renderComponent()
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]

    fireEvent.click(radios[1])
    expect(radios[1].checked).toBe(true)
    expect(radios[0].checked).toBe(false)

    fireEvent.click(radios[2])
    expect(radios[2].checked).toBe(true)
    expect(radios[1].checked).toBe(false)
  })

  it('does not call the translation API in original mode', () => {
    renderComponent()
    fireEvent.click(screen.getByText('Generate Document'))
    expect(mockFetchFlowsheet).not.toHaveBeenCalled()
    expect(mockTranslate).not.toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith('/print-editor')
  })

  it('does not call the translation API when the target is English', async () => {
    renderComponent()
    selectTranslateModeAndLang('en')
    fireEvent.click(screen.getByText('Generate Document'))
    expect(mockFetchFlowsheet).not.toHaveBeenCalled()
    expect(mockTranslate).not.toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith('/print-editor')
  })

  it('shows a review dialog with translated terms before generating', async () => {
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockResolvedValue(
      translatedMap({
        wbc: { name: 'Leukozyten', source: 'translated' },
        hb: { name: 'Hämoglobin', source: 'translated' },
      }),
    )
    renderComponent()
    selectTranslateModeAndLang('de')
    fireEvent.click(screen.getByText('Generate Document'))

    await waitFor(() =>
      expect(mockTranslate).toHaveBeenCalledWith(
        'de',
        [
          { id: 'wbc', name: 'WBC' },
          { id: 'hb', name: 'Hemoglobin' },
        ],
        { persist: false, signal: expect.any(AbortSignal) },
      ),
    )
    expect(await screen.findByText('Verify Translations')).toBeTruthy()
    expect(screen.getByText('Leukozyten')).toBeTruthy()
    // Navigation is gated behind the review step.
    expect(mockPush).not.toHaveBeenCalledWith('/print-editor')

    confirmPreview()
    await waitFor(() =>
      expect(mockCommit).toHaveBeenCalledWith('de', [
        { id: 'wbc', name: 'Leukozyten' },
        { id: 'hb', name: 'Hämoglobin' },
      ]),
    )
    expect(mockPush).toHaveBeenCalledWith('/print-editor')
  })

  it('saves only the accepted translations and discards unchecked ones', async () => {
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockResolvedValue(
      translatedMap({
        wbc: { name: 'Leukozyten', source: 'translated' },
        hb: { name: 'Hämoglobin', source: 'translated' },
      }),
    )
    renderComponent()
    selectTranslateModeAndLang('de')
    fireEvent.click(screen.getByText('Generate Document'))

    await screen.findByText('Verify Translations')
    expect(screen.getByText('Biomarker')).toBeTruthy()
    expect(screen.getByText('Name used in document')).toBeTruthy()

    // Choose English for WBC; keep the translation for Hemoglobin.
    const wbcEn = screen.getByRole('radio', { name: 'Use English for WBC' })
    fireEvent.click(wbcEn)
    expect(wbcEn.getAttribute('aria-checked')).toBe('true')
    expect(
      screen.getByRole('radio', { name: 'Use translation for WBC' }).getAttribute('aria-checked'),
    ).toBe('false')
    expect(screen.getByText(/Save 1 & Generate Document/)).toBeTruthy()

    confirmPreview()
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1))
    expect(mockCommit).toHaveBeenCalledWith('de', [{ id: 'hb', name: 'Hämoglobin' }])
    expect(mockPush).toHaveBeenCalledWith('/print-editor')
  })

  it('going back discards the run: nothing is saved or navigated', async () => {
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockResolvedValue(
      translatedMap({
        wbc: { name: 'Leukozyten', source: 'translated' },
        hb: { name: 'Hämoglobin', source: 'translated' },
      }),
    )
    renderComponent()
    selectTranslateModeAndLang('de')
    fireEvent.click(screen.getByText('Generate Document'))

    fireEvent.click(await screen.findByText('Back — discard translations'))
    expect(screen.queryByText('Verify Translations')).toBeNull()
    expect(mockCommit).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalledWith('/print-editor')
    // The setup screen is still usable.
    expect(screen.getByText('Generate Document')).toBeTruthy()
  })

  it('proceeds without saving when every translation is rejected', async () => {
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockResolvedValue(
      translatedMap({
        wbc: { name: 'Leukozyten', source: 'translated' },
        hb: { name: 'Hämoglobin', source: 'translated' },
      }),
    )
    renderComponent()
    selectTranslateModeAndLang('de')
    fireEvent.click(screen.getByText('Generate Document'))

    await screen.findByText('Verify Translations')
    fireEvent.click(screen.getByRole('radio', { name: 'Use English for WBC' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Use English for Hemoglobin' }))

    expect(screen.getByText('Generate Document (nothing saved)')).toBeTruthy()
    confirmPreview()
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/print-editor'))
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('locks the toggle on cached rows and replaces fallback rows with a label', async () => {
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockResolvedValue(
      translatedMap({
        wbc: { name: 'Leukozyten', source: 'translated' },
        hb: { name: 'Hemoglobin', source: 'fallback' },
      }),
    )
    renderComponent()
    selectTranslateModeAndLang('de')
    fireEvent.click(screen.getByText('Generate Document'))

    await screen.findByText('Verify Translations')
    // Fresh translation: active toggle, Translation selected by default.
    expect(
      screen.getByRole('radio', { name: 'Use translation for WBC' }).getAttribute('aria-checked'),
    ).toBe('true')
    expect(screen.getByRole('radio', { name: 'Use English for WBC' }).disabled).toBe(false)

    // Fallback: no toggle at all — the amber label takes its place at the
    // right edge, and the preview shows the English name it will print.
    expect(screen.queryByRole('radio', { name: /Hemoglobin/ })).toBeNull()
    expect(screen.getByTitle('The AI could not translate this name.')).toBeTruthy()
    expect(
      screen
        .getAllByTitle('Hemoglobin')
        .some((el) => el.className.includes('font-medium')),
    ).toBe(true)
  })

  it('explains that the choice affects names only, not document inclusion', async () => {
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockResolvedValue(
      translatedMap({
        wbc: { name: 'Leukozyten', source: 'translated' },
        hb: { name: 'Hämoglobin', source: 'translated' },
      }),
    )
    renderComponent()
    selectTranslateModeAndLang('de')
    fireEvent.click(screen.getByText('Generate Document'))

    expect(await screen.findByText(/never removes the biomarker from the document/)).toBeTruthy()
    expect(screen.getByText(/use the filter in the print editor/)).toBeTruthy()
  })

  it('review dialog Back cancels and stays on the setup screen', async () => {
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockResolvedValue(
      translatedMap({
        wbc: { name: 'Leukozyten', source: 'translated' },
        hb: { name: 'Hémoglobine', source: 'translated' },
      }),
    )
    renderComponent()
    selectTranslateModeAndLang('fr')
    fireEvent.click(screen.getByText('Generate Document'))

    fireEvent.click(await screen.findByText('Back — discard translations'))
    expect(screen.queryByText('Verify Translations')).toBeNull()
    expect(mockPush).not.toHaveBeenCalledWith('/print-editor')
  })

  it('badges English fallbacks in the review and warns after closing', async () => {
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockResolvedValue(
      translatedMap({
        wbc: { name: 'Leukozyten', source: 'translated' },
        hb: { name: 'Hemoglobin', source: 'fallback' },
      }),
    )
    renderComponent()
    selectTranslateModeAndLang('de')
    fireEvent.click(screen.getByText('Generate Document'))

    expect((await screen.findAllByText('English fallback')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('Back — discard translations'))
    expect(
      await screen.findByText(/could not be translated and will appear in English/),
    ).toBeTruthy()
  })

  it('marks unchanged translations (Latin names) as kept as-is, not failed', async () => {
    const microbiology = {
      ...FLOWSHEET,
      matrix: [
        {
          category: 'Microbiology',
          rows: [
            {
              id: 'eco',
              name: 'Escherichia coli',
              original: 'Кишечная палочка',
              unit: '',
              reference: null,
              cells: [{ value: 'grown', status: 'normal' }],
            },
            {
              id: 'wbc',
              name: 'WBC',
              original: 'Лейкоциты',
              unit: 'K/µL',
              reference: null,
              cells: [{ value: '6.5', status: 'normal' }],
            },
          ],
        },
      ],
    }
    mockFetchFlowsheet.mockResolvedValue(microbiology)
    mockTranslate.mockResolvedValue(
      translatedMap({
        // The model returns Latin binomials verbatim (prompt rule), but the
        // id IS present — deliberately kept, not a failure.
        eco: { name: 'Escherichia coli', source: 'translated' },
        wbc: { name: 'Leukozyten', source: 'translated' },
      }),
    )
    renderComponent()
    selectTranslateModeAndLang('de')
    fireEvent.click(screen.getByText('Generate Document'))

    expect((await screen.findAllByText('kept as-is')).length).toBeGreaterThan(0)
    // The legend explains what the badge means.
    expect(screen.getByText(/Latin term, acronym, or proper noun/)).toBeTruthy()
    // Not a failure: no amber badge, no warning after closing.
    expect(screen.queryByText('English fallback')).toBeNull()
    fireEvent.click(screen.getByText('Back — discard translations'))
    expect(
      screen.queryByText(/could not be translated and will appear in English/),
    ).toBeNull()
  })

  it('skips the review dialog when everything is already translated', async () => {
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockResolvedValue(
      translatedMap({
        wbc: { name: 'Leukozyten', source: 'cached' },
        hb: { name: 'Hämoglobin', source: 'cached' },
      }),
    )
    renderComponent()
    selectTranslateModeAndLang('de')
    fireEvent.click(screen.getByText('Generate Document'))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/print-editor'))
    expect(screen.queryByText('Verify Translations')).toBeNull()
  })

  it('shows elapsed seconds while translating', async () => {
    vi.useFakeTimers()
    let resolveTranslate!: (m: Map<string, TranslatedName>) => void
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockReturnValue(
      new Promise<Map<string, TranslatedName>>((res) => {
        resolveTranslate = res
      }),
    )
    renderComponent()
    selectTranslateModeAndLang('de')
    fireEvent.click(screen.getByText('Generate Document'))
    expect(screen.getByText(/Translating terminology… 0s/)).toBeTruthy()

    // Flush the flowsheet fetch, then let three interval ticks pass.
    await act(async () => {})
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.getByText(/Translating terminology… 3s/)).toBeTruthy()

    // Resolve the translation and flush the promise chain without relying
    // on timers (they are faked here).
    resolveTranslate(
      translatedMap({
        wbc: { name: 'Leukozyten', source: 'translated' },
        hb: { name: 'Hämoglobin', source: 'translated' },
      }),
    )
    for (let i = 0; i < 6; i++) {
      await act(async () => {})
    }
    expect(screen.getByText('Verify Translations')).toBeTruthy()
    expect(screen.queryByText(/Translating terminology/)).toBeNull()
  })

  it('still navigates with English fallback when translation fails', async () => {
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockRejectedValue(new Error('Mistral down'))
    renderComponent()
    selectTranslateModeAndLang('fr')
    fireEvent.click(screen.getByText('Generate Document'))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/print-editor'))
    expect(screen.queryByText('Verify Translations')).toBeNull()
  })

  it('navigates when the translation request times out', async () => {
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockRejectedValue(
      new Error('Translation timed out — the AI service did not respond in time. Please try again.'),
    )
    renderComponent()
    selectTranslateModeAndLang('es')
    fireEvent.click(screen.getByText('Generate Document'))

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/print-editor'))
  })

  it('does not send empty biomarker names for translation', async () => {
    const withEmptyName = {
      ...FLOWSHEET,
      matrix: [
        {
          ...FLOWSHEET.matrix[0],
          rows: [
            ...FLOWSHEET.matrix[0].rows,
            { id: 'ghost', name: '', original: '', unit: '', reference: null, cells: [] },
          ],
        },
      ],
    }
    mockFetchFlowsheet.mockResolvedValue(withEmptyName)
    mockTranslate.mockResolvedValue(translatedMap({}))
    renderComponent()
    selectTranslateModeAndLang('de')
    fireEvent.click(screen.getByText('Generate Document'))

    await waitFor(() => expect(mockTranslate).toHaveBeenCalled())
    const [, namesArg] = mockTranslate.mock.calls[0]
    expect(namesArg).toHaveLength(2)
    expect(namesArg).not.toContainEqual(expect.objectContaining({ id: 'ghost' }))
    // Nothing came back translated: the review shows the fallbacks instead
    // of navigating straight away.
    expect(await screen.findByText('Verify Translations')).toBeTruthy()
    confirmPreview()
    expect(mockPush).toHaveBeenCalledWith('/print-editor')
  })

  it('asks before leaving mid-translation and does not navigate when the user stays', async () => {
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockImplementation(
      () => new Promise(() => {}), // never resolves while translating
    )
    renderComponent()
    selectTranslateModeAndLang('de')
    fireEvent.click(screen.getByText('Generate Document'))
    await waitFor(() => expect(mockTranslate).toHaveBeenCalled())

    // User presses the browser Back button mid-translation.
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    fireEvent.click(screen.getByText('Stay'))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('leaving mid-translation aborts the request and skips navigation', async () => {
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockImplementation(
      (_lang: string, _names: unknown, opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
        }),
    )
    const { unmount } = renderComponent()
    selectTranslateModeAndLang('de')
    fireEvent.click(screen.getByText('Generate Document'))
    await waitFor(() => expect(mockTranslate).toHaveBeenCalled())

    // User presses the browser Back button mid-translation and confirms.
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    fireEvent.click(await screen.findByText('Leave anyway'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    // Leaving unmounts the page: the in-flight request is aborted and the
    // completion cannot hijack navigation into /print-editor.
    unmount()
    await waitFor(() => expect(mockPush).not.toHaveBeenCalled())
  })
})
