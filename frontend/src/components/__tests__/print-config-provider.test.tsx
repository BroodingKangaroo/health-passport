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
      <div data-testid="showOutOfRangeOnly">{String(ctx.showOutOfRangeOnly)}</div>
      <div data-testid="showRanges">{String(ctx.showRanges)}</div>
      <button data-testid="setTranslate" onClick={() => ctx.setMode('translate')} />
      <button data-testid="setTarget" onClick={() => ctx.setTargetLanguage('de')} />
      <button data-testid="setLandscape" onClick={() => ctx.setLayout('landscape')} />
      <button data-testid="setTextSize14" onClick={() => ctx.setTextSize(14)} />
      <button data-testid="toggleOutOfRange" onClick={() => ctx.setShowOutOfRangeOnly(!ctx.showOutOfRangeOnly)} />
      <button data-testid="toggleRanges" onClick={() => ctx.setShowRanges(!ctx.showRanges)} />
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
    expect(screen.getByTestId('showOutOfRangeOnly').textContent).toBe('false')
    expect(screen.getByTestId('showRanges').textContent).toBe('true')
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

  it('toggles showOutOfRangeOnly', () => {
    renderWithProvider()
    fireEvent.click(screen.getByTestId('toggleOutOfRange'))
    expect(screen.getByTestId('showOutOfRangeOnly').textContent).toBe('true')
  })

  it('toggles showRanges', () => {
    renderWithProvider()
    expect(screen.getByTestId('showRanges').textContent).toBe('true')
    fireEvent.click(screen.getByTestId('toggleRanges'))
    expect(screen.getByTestId('showRanges').textContent).toBe('false')
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
