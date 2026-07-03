import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PrintSetup } from '@/components/health-passport/print-setup'
import { PrintConfigProvider } from '@/providers/print-config-provider'

const mockPush = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

function renderComponent() {
  return render(
    <PrintConfigProvider>
      <PrintSetup />
    </PrintConfigProvider>,
  )
}

describe('PrintSetup', () => {
  beforeEach(() => {
    mockPush.mockClear()
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
})
