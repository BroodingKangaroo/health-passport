import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  UsageLimitError,
  extractMedicalData,
  saveMedicalEntry,
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