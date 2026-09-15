import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'

import { printAuthedDocument } from '../utils'

type PrintWindow = Window & {
  print: () => void
  onafterprint: ((ev: Event) => void) | null
}

function stubPrint(iframe: HTMLIFrameElement) {
  const win = iframe.contentWindow as PrintWindow
  win.print = vi.fn()
  return win
}

describe('printAuthedDocument', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () =>
        Promise.resolve(new Blob(['pdf-bytes'], { type: 'application/pdf' })),
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
    document.querySelectorAll('iframe').forEach((el) => el.remove())
    vi.restoreAllMocks()
  })

  it('removes the hidden iframe and revokes object URLs when printing finishes', async () => {
    await printAuthedDocument('/static/uploads/report.pdf')

    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    expect(iframe).toBeTruthy()
    const win = stubPrint(iframe)
    fireEvent.load(iframe)

    expect(win.onafterprint).toBeTruthy()
    win.onafterprint!(new Event('afterprint'))

    expect(document.querySelector('iframe')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock')
  })

  it('cleans up even when afterprint never fires (safety timeout)', async () => {
    vi.useFakeTimers()
    try {
      await printAuthedDocument('/static/uploads/report.pdf')

      const iframe = document.querySelector('iframe') as HTMLIFrameElement
      stubPrint(iframe)
      fireEvent.load(iframe)
      expect(document.querySelector('iframe')).not.toBeNull()

      vi.advanceTimersByTime(60_000)

      expect(document.querySelector('iframe')).toBeNull()
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock')
    } finally {
      vi.useRealTimers()
    }
  })
})
