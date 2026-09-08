import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { useBatchSubmit } from '@/lib/hooks/useBatchSubmit'
import { createImportJob } from '@/services/import-jobs'
import { fetchUsageLimits, ApiError } from '@/services/api'
import type { UsageLimits } from '@/lib/types'

vi.mock('@/services/import-jobs', () => ({
  createImportJob: vi.fn(),
}))
vi.mock('@/services/api', () => ({
  fetchUsageLimits: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message)
    }
  },
}))

const createMock = vi.mocked(createImportJob)
const limitsMock = vi.mocked(fetchUsageLimits)

function file(name: string): File {
  return new File(['x'], name, { type: 'application/pdf' })
}

function limits(overrides: Partial<UsageLimits> = {}): UsageLimits {
  return {
    is_anonymous: false,
    ai_extraction_count: 0,
    ai_extraction_limit: 50,
    total_upload_size_bytes: 0,
    total_upload_limit_bytes: 1,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  limitsMock.mockResolvedValue(limits())
})

describe('useBatchSubmit (headless submission after the batch panel removal)', () => {
  it('submits every file sequentially and reports the job ids', async () => {
    createMock.mockResolvedValue('job-1')
    const { result } = renderHook(() => useBatchSubmit())

    let outcome!: Awaited<ReturnType<typeof result.current.submit>>
    await act(async () => {
      outcome = await result.current.submit([file('a.pdf'), file('b.pdf')])
    })

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(outcome.submittedIds).toEqual(['job-1', 'job-1'])
    expect(outcome.skippedCount).toBe(0)
    expect(outcome.error).toBeNull()
    expect(outcome.cancelled).toBe(false)
    expect(result.current.submitting).toBe(false)
  })

  it('caps submission at the remaining quota and reports the skipped files', async () => {
    limitsMock.mockResolvedValue(
      limits({ ai_extraction_count: 3, ai_extraction_limit: 5 }),
    )
    createMock.mockResolvedValue('job-x')
    const { result } = renderHook(() => useBatchSubmit())

    let outcome!: Awaited<ReturnType<typeof result.current.submit>>
    await act(async () => {
      outcome = await result.current.submit([file('a.pdf'), file('b.pdf'), file('c.pdf')])
    })

    // Capped: only the remaining 2 are submitted, never a doomed third.
    expect(createMock).toHaveBeenCalledTimes(2)
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'a.pdf' }))
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'b.pdf' }))
    expect(createMock).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'c.pdf' }))
    expect(outcome.submittedIds).toHaveLength(2)
    expect(outcome.skippedCount).toBe(1)
    expect(outcome.error).toBeNull()
  })

  it('stops submitting after a submit failure instead of stacking more', async () => {
    createMock.mockRejectedValueOnce(new ApiError(500, 'boom'))
    const { result } = renderHook(() => useBatchSubmit())

    let outcome!: Awaited<ReturnType<typeof result.current.submit>>
    await act(async () => {
      outcome = await result.current.submit([file('a.pdf'), file('b.pdf')])
    })

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(outcome.submittedIds).toEqual([])
    expect(outcome.error).toEqual({ kind: 'submit', message: 'boom' })
  })

  it('fails closed when the quota check fails (no submissions at all)', async () => {
    limitsMock.mockRejectedValue(new Error('limits down'))
    createMock.mockResolvedValue('job-1')
    const { result } = renderHook(() => useBatchSubmit())

    let outcome!: Awaited<ReturnType<typeof result.current.submit>>
    await act(async () => {
      outcome = await result.current.submit([file('a.pdf'), file('b.pdf')])
    })

    expect(createMock).not.toHaveBeenCalled()
    expect(outcome.submittedIds).toEqual([])
    expect(outcome.skippedCount).toBe(0)
    expect(outcome.error).toEqual({ kind: 'limits' })
  })

  it('arms a plain beforeunload prompt only while submissions are in flight', async () => {
    let resolveLimits: (v: UsageLimits) => void = () => {}
    limitsMock.mockReturnValue(
      new Promise<UsageLimits>((res) => {
        resolveLimits = res
      }),
    )
    createMock.mockResolvedValue('job-1')
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    const { result, unmount } = renderHook(() => useBatchSubmit())

    let pending!: Promise<Awaited<ReturnType<typeof result.current.submit>>>
    act(() => {
      pending = result.current.submit([file('a.pdf')])
    })
    // In flight (limits fetch pending): the plain beforeunload prompt is armed.
    await act(async () => {
      await Promise.resolve()
    })
    expect(added.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true)
    expect(result.current.submitting).toBe(true)
    expect(result.current.total).toBe(1)

    resolveLimits(limits())
    await act(async () => {
      await pending
    })
    unmount()
    expect(removed.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true)
  })

  it('ignores a second concurrent submission', async () => {
    let resolveLimits: (v: UsageLimits) => void = () => {}
    limitsMock.mockReturnValue(
      new Promise<UsageLimits>((res) => {
        resolveLimits = res
      }),
    )
    createMock.mockResolvedValue('job-1')
    const { result } = renderHook(() => useBatchSubmit())

    let first!: Promise<Awaited<ReturnType<typeof result.current.submit>>>
    act(() => {
      first = result.current.submit([file('a.pdf')])
    })
    const second = await act(async () => {
      return result.current.submit([file('b.pdf')])
    })

    expect(second.submittedIds).toEqual([])
    resolveLimits(limits())
    await act(async () => {
      await first
    })
    expect(createMock).toHaveBeenCalledTimes(1)
  })
})
