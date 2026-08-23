import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  UsageLimitError,
  extractMedicalData,
  saveMedicalEntry,
  translateBiomarkerNames,
} from '@/services/api'

function mockFetch(ok: boolean, status: number, body: unknown): void {
  const res = {
    ok,
    status,
    json: () => Promise.resolve(body),
    body: null,
  } as unknown as Response
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(res)))
}

const DETAIL = { detail: 'File too large (12500 KB). Maximum allowed size is 10 MB.' }

describe('saveMedicalEntry error detail', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('surfaces the backend detail on non-429 failure', async () => {
    mockFetch(false, 413, DETAIL)
    await expect(saveMedicalEntry(new FormData())).rejects.toMatchObject({
      status: 413,
      message: DETAIL.detail,
    })
  })

  it('throws a UsageLimitError on 429', async () => {
    mockFetch(false, 429, { detail: 'Anonymous quota reached' })
    await expect(saveMedicalEntry(new FormData())).rejects.toBeInstanceOf(UsageLimitError)
  })

  it('falls back to a generic message when the body is not JSON', async () => {
    const res = {
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json')),
      body: null,
    } as unknown as Response
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(res)))
    await expect(saveMedicalEntry(new FormData())).rejects.toMatchObject({
      status: 500,
      message: 'POST /entry failed',
    })
  })
})

describe('extractMedicalData error detail', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('surfaces the backend detail on non-429 failure', async () => {
    const detail = { detail: "Unsupported file type 'heic'. Allowed: pdf, png, jpg, jpeg." }
    mockFetch(false, 400, detail)
    await expect(extractMedicalData(new File([''], 'a.heic'))).rejects.toMatchObject({
      status: 400,
      message: detail.detail,
    })
  })

  it('throws a 429 UsageLimitError and keeps detail', async () => {
    mockFetch(false, 429, { detail: 'Usage limit reached' })
    await expect(extractMedicalData(new File([''], 'a.pdf'))).rejects.toMatchObject({
      status: 429,
      message: 'Usage limit reached',
    })
  })

  it('falls back to a generic message when the body is not JSON', async () => {
    const res = {
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json')),
      body: null,
    } as unknown as Response
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(res)))
    await expect(extractMedicalData(new File([''], 'a.pdf'))).rejects.toMatchObject({
      status: 500,
      message: 'POST /extract failed',
    })
  })
})

describe('translateBiomarkerNames error detail', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('formats FastAPI 422 validation arrays into readable text, never [object Object]', async () => {
    mockFetch(false, 422, {
      detail: [
        {
          type: 'literal_error',
          loc: ['body', 'lang'],
          msg: "Input should be 'de', 'fr', 'es' or 'he'",
          input: 'pl',
          ctx: { expected: "'de', 'fr', 'es' or 'he'" },
        },
      ],
    })
    await expect(
      translateBiomarkerNames('pl', [{ id: 'a', name: 'A' }]),
    ).rejects.toMatchObject({
      status: 422,
      message: "body.lang: Input should be 'de', 'fr', 'es' or 'he'",
    })
  })

  it('falls back to a generic message when the body is not JSON', async () => {
    const res = {
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json')),
      body: null,
    } as unknown as Response
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(res)))
    await expect(translateBiomarkerNames('de', [])).rejects.toMatchObject({
      status: 500,
      message: 'POST /translate-biomarkers failed',
    })
  })

  it('keeps string details and throws UsageLimitError on 429', async () => {
    mockFetch(false, 429, { detail: 'AI translation limit reached (5/5).' })
    await expect(
      translateBiomarkerNames('de', [{ id: 'a', name: 'A' }]),
    ).rejects.toMatchObject({
      status: 429,
      message: 'AI translation limit reached (5/5).',
    })
  })
})

describe('extractMedicalData SSE watchdog', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('rejects with a timeout error when the stream stalls past the watchdog window', async () => {
    vi.useFakeTimers()
    // A stream that never emits a byte — exactly the "silent forever" case the
    // watchdog exists for (dead connection, dropped SSE stream).
    const stalled = new ReadableStream<Uint8Array>({})
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, status: 200, body: stalled } as unknown as Response)),
    )

    const promise = extractMedicalData(new File([''], 'a.pdf'))
    const assertion = expect(promise).rejects.toThrow('AI extraction timed out')
    await vi.advanceTimersByTimeAsync(90_000)
    await assertion
  })

  it('resolves normally when the stream delivers a result before the watchdog fires', async () => {
    const payload = JSON.stringify({ entry_type: 'blood_test' })
    const sse = `event: result\ndata: ${payload}\n\n`
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse))
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, status: 200, body: stream } as unknown as Response)),
    )

    const result = await extractMedicalData(new File([''], 'a.pdf'))
    expect(result.entry_type).toBe('blood_test')
  })
})