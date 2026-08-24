import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PrintConfigProvider, PrintConfigContext } from '@/providers/print-config-provider'
import { useContext } from 'react'

function TestConsumer() {
  const ctx = useContext(PrintConfigContext)
  if (!ctx) return <div>no context</div>
  return (
    <div>
      <div data-testid="mode">{ctx.mode}</div>
      <div data-testid="target">{ctx.targetLanguage}</div>
      <div data-testid="layout">{ctx.layout}</div>
      <div data-testid="textSize">{ctx.textSize}</div>
      <div data-testid="selectedDates">{ctx.selectedDates.join(',')}</div>
      <div data-testid="selectedBiomarkers">{ctx.selectedBiomarkers.join(',')}</div>
      <div data-testid="showAbnormalOnly">{String(ctx.showAbnormalOnly)}</div>
      <div data-testid="showReferences">{String(ctx.showReferences)}</div>
      <div data-testid="compactNumbers">{String(ctx.compactNumbers)}</div>
      <button data-testid="setTranslate" onClick={() => ctx.setMode('translate')} />
      <button data-testid="setTarget" onClick={() => ctx.setTargetLanguage('de')} />
      <button data-testid="setLandscape" onClick={() => ctx.setLayout('landscape')} />
      <button data-testid="setTextSize14" onClick={() => ctx.setTextSize(14)} />
      <button data-testid="toggleAbnormal" onClick={() => ctx.setShowAbnormalOnly(!ctx.showAbnormalOnly)} />
      <button data-testid="toggleReferences" onClick={() => ctx.setShowReferences(!ctx.showReferences)} />
      <button data-testid="toggleCompactNumbers" onClick={() => ctx.setCompactNumbers(!ctx.compactNumbers)} />
      <button data-testid="initFilters" onClick={() => ctx.initFilters(['a', 'b'], ['x', 'y'])} />
    </div>
  )
}

function renderWithProvider() {
  return render(
    <PrintConfigProvider>
      <TestConsumer />
    </PrintConfigProvider>,
  )
}

describe('PrintConfigProvider', () => {
  it('provides default values', () => {
    renderWithProvider()
    expect(screen.getByTestId('mode').textContent).toBe('original')
    expect(screen.getByTestId('target').textContent).toBe('en')
    expect(screen.getByTestId('layout').textContent).toBe('portrait')
    expect(screen.getByTestId('textSize').textContent).toBe('10')
    expect(screen.getByTestId('selectedDates').textContent).toBe('')
    expect(screen.getByTestId('selectedBiomarkers').textContent).toBe('')
    expect(screen.getByTestId('showAbnormalOnly').textContent).toBe('false')
    expect(screen.getByTestId('showReferences').textContent).toBe('true')
    expect(screen.getByTestId('compactNumbers').textContent).toBe('false')
  })

  it('updates mode via setMode', () => {
    renderWithProvider()
    fireEvent.click(screen.getByTestId('setTranslate'))
    expect(screen.getByTestId('mode').textContent).toBe('translate')
  })

  it('updates targetLanguage via setTargetLanguage', () => {
    renderWithProvider()
    fireEvent.click(screen.getByTestId('setTarget'))
    expect(screen.getByTestId('target').textContent).toBe('de')
  })

  it('updates layout via setLayout', () => {
    renderWithProvider()
    fireEvent.click(screen.getByTestId('setLandscape'))
    expect(screen.getByTestId('layout').textContent).toBe('landscape')
  })

  it('updates textSize via setTextSize', () => {
    renderWithProvider()
    fireEvent.click(screen.getByTestId('setTextSize14'))
    expect(screen.getByTestId('textSize').textContent).toBe('14')
  })

  it('toggles showAbnormalOnly', () => {
    renderWithProvider()
    fireEvent.click(screen.getByTestId('toggleAbnormal'))
    expect(screen.getByTestId('showAbnormalOnly').textContent).toBe('true')
  })

  it('toggles showReferences', () => {
    renderWithProvider()
    expect(screen.getByTestId('showReferences').textContent).toBe('true')
    fireEvent.click(screen.getByTestId('toggleReferences'))
    expect(screen.getByTestId('showReferences').textContent).toBe('false')
  })

  it('toggles compactNumbers', () => {
    renderWithProvider()
    expect(screen.getByTestId('compactNumbers').textContent).toBe('false')
    fireEvent.click(screen.getByTestId('toggleCompactNumbers'))
    expect(screen.getByTestId('compactNumbers').textContent).toBe('true')
  })

  it('initFilters populates selectedDates and selectedBiomarkers', () => {
    renderWithProvider()
    fireEvent.click(screen.getByTestId('initFilters'))
    expect(screen.getByTestId('selectedDates').textContent).toBe('a,b')
    expect(screen.getByTestId('selectedBiomarkers').textContent).toBe('x,y')
  })

  it('renders fallback when context is missing', () => {
    render(<TestConsumer />)
    expect(screen.getByText('no context')).toBeTruthy()
  })
})
