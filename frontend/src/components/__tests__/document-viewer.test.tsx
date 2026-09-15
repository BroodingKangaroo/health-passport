import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DocumentViewer } from '../shared/DocumentViewer'
import { TestI18nProvider } from '@/test/i18n-test-provider'

const pdfjsMock = vi.hoisted(() => ({
  getDocument: vi.fn(),
  getPage: vi.fn(),
  destroy: vi.fn(),
}))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: pdfjsMock.getDocument,
}))

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    blob: () => Promise.resolve(new Blob()),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
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

  pdfjsMock.getPage.mockReset()
  pdfjsMock.getPage.mockImplementation(async () => ({
    getViewport: () => ({ width: 600, height: 800 }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    rotate: 0,
  }))
  pdfjsMock.destroy.mockReset()
  pdfjsMock.destroy.mockResolvedValue(undefined)
  pdfjsMock.getDocument.mockReset()
  pdfjsMock.getDocument.mockImplementation(() => ({
    // A pdf.js PDFDocumentLoadingTask: destroy() owns the document+worker.
    promise: Promise.resolve({
      numPages: 2,
      getPage: pdfjsMock.getPage,
    }),
    destroy: pdfjsMock.destroy,
  }))
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

  it('destroys the pdf.js document on unmount', async () => {
    const { unmount } = render(
      <TestI18nProvider>
        <DocumentViewer url="/static/uploads/report.pdf" />
      </TestI18nProvider>,
    )

    await waitFor(() => expect(pdfjsMock.getPage).toHaveBeenCalled())
    expect(pdfjsMock.destroy).not.toHaveBeenCalled()

    unmount()
    expect(pdfjsMock.destroy).toHaveBeenCalledTimes(1)
  })

  it('destroys the previous pdf.js document when the url changes', async () => {
    const { rerender } = render(
      <TestI18nProvider>
        <DocumentViewer url="/static/uploads/first.pdf" />
      </TestI18nProvider>,
    )
    await waitFor(() => expect(pdfjsMock.getPage).toHaveBeenCalled())

    rerender(
      <TestI18nProvider>
        <DocumentViewer url="/static/uploads/second.pdf" />
      </TestI18nProvider>,
    )

    await waitFor(() => expect(pdfjsMock.destroy).toHaveBeenCalledTimes(1))
    expect(pdfjsMock.getDocument).toHaveBeenCalledTimes(2)
  })

  it('destroys the loading task even when the document resolves after unmount', async () => {
    let resolveDoc: (value: unknown) => void = () => {}
    pdfjsMock.getDocument.mockImplementation(() => ({
      promise: new Promise((resolve) => { resolveDoc = resolve }),
      destroy: pdfjsMock.destroy,
    }))

    const { unmount } = render(
      <TestI18nProvider>
        <DocumentViewer url="/static/uploads/slow.pdf" />
      </TestI18nProvider>,
    )
    await waitFor(() => expect(pdfjsMock.getDocument).toHaveBeenCalled())

    unmount()
    // Destroyed at unmount time, without waiting for the document promise.
    expect(pdfjsMock.destroy).toHaveBeenCalledTimes(1)

    resolveDoc({ numPages: 1, getPage: pdfjsMock.getPage })
    await Promise.resolve()
    expect(pdfjsMock.destroy).toHaveBeenCalledTimes(1)
  })

  it('never creates a loading task when the fetch resolves after unmount', async () => {
    let resolveFetch: (value: unknown) => void = () => {}
    global.fetch = vi.fn(
      () => new Promise((resolve) => { resolveFetch = resolve }),
    ) as unknown as typeof fetch

    const { unmount } = render(
      <TestI18nProvider>
        <DocumentViewer url="/static/uploads/cancelled.pdf" />
      </TestI18nProvider>,
    )
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    unmount()

    resolveFetch({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pdfjsMock.getDocument).not.toHaveBeenCalled()
  })

  it('destroys the loading task when switching from a PDF to an image', async () => {
    const { rerender } = render(
      <TestI18nProvider>
        <DocumentViewer url="/static/uploads/first.pdf" />
      </TestI18nProvider>,
    )
    await waitFor(() => expect(pdfjsMock.getPage).toHaveBeenCalled())

    rerender(
      <TestI18nProvider>
        <DocumentViewer url="/static/uploads/scan.png" />
      </TestI18nProvider>,
    )

    await waitFor(() => expect(pdfjsMock.destroy).toHaveBeenCalledTimes(1))
    expect(await screen.findByAltText('Document preview')).toBeDefined()
  })
})
