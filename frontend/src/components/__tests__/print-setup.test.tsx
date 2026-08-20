import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PrintSetup } from '@/components/health-passport/print-setup'
import { PrintConfigProvider } from '@/providers/print-config-provider'
import type { FlowsheetResponse } from '@/lib/types'

const mockPush = vi.fn()
const mockFetchFlowsheet = vi.fn()
const mockTranslate = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('@/services/api', () => ({
  fetchFlowsheetData: (...args: unknown[]) => mockFetchFlowsheet(...args),
  translateBiomarkerNames: (...args: unknown[]) => mockTranslate(...args),
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

function renderComponent() {
  return render(
    <PrintConfigProvider>
      <PrintSetup />
    </PrintConfigProvider>,
  )
}

function selectTranslateModeAndLang(lang: string) {
  fireEvent.click(screen.getAllByRole('radio')[1])
  fireEvent.change(screen.getByRole('combobox'), { target: { value: lang } })
}

describe('PrintSetup', () => {
  beforeEach(() => {
    mockPush.mockClear()
    mockFetchFlowsheet.mockClear()
    mockTranslate.mockClear()
  })

  it('renders the title and description', () => {
    renderComponent()
    expect(screen.getByText('Prepare Document for Print/Export')).toBeTruthy()
  })

  it('renders all three mode options', () => {
    renderComponent()
    expect(screen.getByText('Keep Original (Russian)')).toBeTruthy()
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

  it('awaits the translation call before navigating in translate mode', async () => {
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockResolvedValue(new Map([['wbc', 'Leukozyten']]))
    renderComponent()
    selectTranslateModeAndLang('de')
    fireEvent.click(screen.getByText('Generate Document'))

    await waitFor(() =>
      expect(mockTranslate).toHaveBeenCalledWith('de', [
        { id: 'wbc', name: 'WBC' },
        { id: 'hb', name: 'Hemoglobin' },
      ]),
    )
    expect(mockPush).toHaveBeenCalledWith('/print-editor')
  })

  it('still navigates with English fallback when translation fails', async () => {
    mockFetchFlowsheet.mockResolvedValue(FLOWSHEET)
    mockTranslate.mockRejectedValue(new Error('Mistral down'))
    renderComponent()
    selectTranslateModeAndLang('fr')
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
    mockTranslate.mockResolvedValue(new Map())
    renderComponent()
    selectTranslateModeAndLang('de')
    fireEvent.click(screen.getByText('Generate Document'))

    await waitFor(() => expect(mockTranslate).toHaveBeenCalled())
    const [, namesArg] = mockTranslate.mock.calls[0]
    expect(namesArg).toHaveLength(2)
    expect(namesArg).not.toContainEqual(expect.objectContaining({ id: 'ghost' }))
    expect(mockPush).toHaveBeenCalledWith('/print-editor')
  })
})
