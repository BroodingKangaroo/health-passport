import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'

import { useExtraction } from '@/lib/hooks/useExtraction'
import { extractMedicalData } from '@/services/api'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import { LeaveGuardProvider } from '@/providers/leave-guard-provider'
import type { StandardizedMedicalRecord } from '@/lib/types'

vi.mock('@/services/api', () => ({
  extractMedicalData: vi.fn(),
  UsageLimitError: class UsageLimitError extends Error {},
}))

const extractMock = vi.mocked(extractMedicalData)

const fakeRecord = { entry_type: 'blood_test' } as unknown as StandardizedMedicalRecord
const fakeFile = new File(['x'], 'a.pdf', { type: 'application/pdf' })

function HookWrapper({ children }: { children: ReactNode }) {
  return (
    <TestI18nProvider>
      <LeaveGuardProvider>{children}</LeaveGuardProvider>
    </TestI18nProvider>
  )
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useExtraction superseded-run guards (ISSUES.md #65)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a superseded run must not flip the new run back to the editor', async () => {
    const onSuccess = vi.fn()
    const { result } = renderHook(
      () => useExtraction({ onSuccess, onFailure: () => {} }),
      { wrapper: HookWrapper },
    )

    const a = deferred<StandardizedMedicalRecord>()
    const b = deferred<StandardizedMedicalRecord>()
    extractMock.mockImplementationOnce(() => a.promise)
    extractMock.mockImplementationOnce(() => b.promise)

    // Run A starts, then run B supersedes it.
    await act(async () => {
      result.current.runExtraction(fakeFile)
    })
    expect(result.current.uploadState).toBe('scanning')
    await act(async () => {
      result.current.runExtraction(fakeFile)
    })
    expect(result.current.uploadState).toBe('scanning')

    // A resolves AFTER being superseded: its success tail (onSuccess +
    // 'completed' stage + delayed editor flip) must be ignored entirely.
    await act(async () => {
      a.resolve(fakeRecord)
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(onSuccess).not.toHaveBeenCalled()
    expect(result.current.uploadState).toBe('scanning')

    // B resolves normally: the editor appears after its success delay.
    await act(async () => {
      b.resolve(fakeRecord)
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(onSuccess).toHaveBeenCalledWith(fakeRecord)
    expect(result.current.uploadState).toBe('editor')
  })

  it('a superseded run erroring late must not clobber the new run', async () => {
    const onFailure = vi.fn()
    const { result } = renderHook(
      () => useExtraction({ onSuccess: () => {}, onFailure }),
      { wrapper: HookWrapper },
    )

    const a = deferred<StandardizedMedicalRecord>()
    const b = deferred<StandardizedMedicalRecord>()
    extractMock.mockImplementationOnce(() => a.promise)
    extractMock.mockImplementationOnce(() => b.promise)

    await act(async () => {
      result.current.runExtraction(fakeFile)
    })
    await act(async () => {
      result.current.runExtraction(fakeFile)
    })

    // A rejects with a network error AFTER B took over: no failure state.
    await act(async () => {
      a.reject(new Error('network gone'))
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(onFailure).not.toHaveBeenCalled()
    expect(result.current.aiError).toBeNull()
    expect(result.current.uploadState).toBe('scanning')
  })
})
