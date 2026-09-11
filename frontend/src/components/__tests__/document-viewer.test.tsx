import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DocumentViewer } from '../shared/DocumentViewer'
import { TestI18nProvider } from '@/test/i18n-test-provider'

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
}))

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    blob: () => Promise.resolve(new Blob()),
  }) as unknown as typeof fetch
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => 'blob:mock'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DocumentViewer', () => {
  it('rotates the image 90° clockwise per click and wraps around', async () => {
    render(
      <TestI18nProvider>
        <DocumentViewer url="/static/uploads/scan.png" />
      </TestI18nProvider>,
    )

    const img = await screen.findByAltText('Document preview')
    expect(img.style.transform).toBe('rotate(0deg)')

    const rotate = screen.getByRole('button', { name: 'Rotate clockwise' })
    fireEvent.click(rotate)
    expect(img.style.transform).toBe('rotate(90deg)')
    fireEvent.click(rotate)
    fireEvent.click(rotate)
    fireEvent.click(rotate)
    expect(img.style.transform).toBe('rotate(0deg)')
  })

  it('zooms the image in/out in 5% steps and resets to fit', async () => {
    render(
      <TestI18nProvider>
        <DocumentViewer url="/static/uploads/scan.png" />
      </TestI18nProvider>,
    )

    await screen.findByAltText('Document preview')
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' })
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' })

    expect(screen.getByText('100%')).toBeDefined()
    fireEvent.click(zoomIn)
    expect(screen.getByText('105%')).toBeDefined()
    fireEvent.click(zoomIn)
    expect(screen.getByText('110%')).toBeDefined()
    fireEvent.click(zoomOut)
    expect(screen.getByText('105%')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(screen.getByText('100%')).toBeDefined()
  })

  it('lays the image out at fit-to-viewport size and grows it with zoom', async () => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400)

    render(
      <TestI18nProvider>
        <DocumentViewer url="/static/uploads/scan.png" />
      </TestI18nProvider>,
    )

    const img = await screen.findByAltText('Document preview')
    Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 800 })
    Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 600 })
    fireEvent.load(img)

    const wrapper = img.parentElement as HTMLElement
    // Viewport is 400 - 32 (p-4) = 368; fit = 368/800 = 0.46 -> 368x276.
    expect(wrapper.style.width).toBe('368px')
    expect(wrapper.style.height).toBe('276px')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(wrapper.style.width).toBe('386px')
    expect(wrapper.style.height).toBe('290px')

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(wrapper.style.width).toBe('368px')
    expect(wrapper.style.height).toBe('276px')
  })
})
