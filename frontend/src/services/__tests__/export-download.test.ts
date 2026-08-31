import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { downloadAccountExport } from '@/services/api'

const createObjectURL = vi.fn(() => 'blob:mock')
const revokeObjectURL = vi.fn()

describe('downloadAccountExport', () => {
  let anchorSpy: HTMLAnchorElement

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
    anchorSpy = Object.assign(document.createElement('a'), { click: vi.fn() })
    vi.spyOn(document, 'createElement').mockReturnValue(anchorSpy)
    vi.spyOn(document.body, 'appendChild').mockReturnValue(anchorSpy)
    document.cookie = 'NEXT_LOCALE=ru'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function mockExportResponse(headers: Record<string, string>, ok = true) {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue({
      ok,
      status: ok ? 200 : 400,
      blob: async () => new Blob(['data']),
      headers: new Headers(headers),
    })
    return fetchMock
  }

  it('requests the JSON export through the proxy and names the file from Content-Disposition', async () => {
    await mockExportResponse({
      'content-disposition': 'attachment; filename="healthpassport-backup-20260831.json"',
    })

    await downloadAccountExport('json')

    expect(fetch).toHaveBeenCalledWith(
      '/api/export?format=json',
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(anchorSpy.download).toBe('healthpassport-backup-20260831.json')
    expect(anchorSpy.click).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock')
  })

  it('falls back to a dated readings filename when no Content-Disposition is present', async () => {
    await mockExportResponse({})

    await downloadAccountExport('csv')

    expect(anchorSpy.download).toMatch(/^healthpassport-readings-\d{8}\.csv$/)
  })

  it('sends Accept-Language from the UI locale cookie', async () => {
    const fetchMock = await mockExportResponse({})
    await downloadAccountExport('json')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['Accept-Language']).toBe('ru')
  })
})
