import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TranslationPreviewDialog } from '@/components/health-passport/translation-preview-dialog'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import type { TranslationPreviewItem } from '@/components/health-passport/translation-preview-dialog'

const renderI18n = (ui: React.ReactElement) =>
  render(<TestI18nProvider>{ui}</TestI18nProvider>)

const ITEMS: TranslationPreviewItem[] = [
  { id: 'wbc', english: 'WBC', translated: 'Лейкоциты', source: 'translated' },
  { id: 'hb', english: 'Hemoglobin', translated: 'Гемоглобин', source: 'translated' },
  { id: 'rbc', english: 'RBC', translated: 'Эритроциты', source: 'cached' },
  { id: 'mcv', english: 'MCV', translated: 'MCV', source: 'fallback' },
]

describe('TranslationPreviewDialog layout', () => {
  it('caps the panel and scrolls the middle region with a pinned footer', () => {
    const { container } = renderI18n(
      <TranslationPreviewDialog
        items={ITEMS}
        categories={[{ original: 'Клинический анализ крови', translated: 'Complete Blood Count' }]}
        languageLabel="Russian"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )

    const panel = screen.getByRole('dialog')
    expect(panel.className).toContain('max-h-[85vh]')
    expect(panel.className).toContain('flex-col')

    // One scroll region holds rows + categories + legend; the footer sits
    // outside it so the confirm button stays reachable on long lists.
    const scrollRegion = container.querySelector('.flex-1.min-h-0.overflow-y-auto')
    expect(scrollRegion).not.toBeNull()
    expect(scrollRegion!.contains(screen.getByText('Panel headings (applied automatically)'))).toBe(
      true,
    )

    const footer = container.querySelector('.border-t')!
    expect(footer).not.toBeNull()
    expect(footer.className).toContain('shrink-0')
    expect(screen.getByRole('button', { name: 'Save 2 & Generate Document' })).toBeVisible()

    // The old nested-scroll cap on the rows list is gone — rows live in the
    // single outer scroll region now.
    expect(container.innerHTML).not.toContain('max-h-[60vh]')
  })

  it('keeps the column header sticky and toggles still recompute the saved count', () => {
    const onConfirm = vi.fn()
    const { container } = renderI18n(
      <TranslationPreviewDialog
        items={ITEMS}
        languageLabel="Russian"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    )

    expect(container.querySelector('.sticky.top-0.z-10')).not.toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: 'Use English for WBC' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 & Generate Document' }))
    expect(onConfirm).toHaveBeenCalledWith([ITEMS[1]])
  })
})
