import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { LeaveGuardProvider, useLeaveGuard } from '@/providers/leave-guard-provider'

// Mirrors the provider's internal marker shape; asserted via history.state.
const MARKER = { leaveGuard: true }

function Harness({ onLeave }: { onLeave?: () => void }) {
  const { arm, disarm } = useLeaveGuard()
  return (
    <div>
      <button onClick={() => arm('working…', onLeave)}>arm</button>
      <button onClick={() => disarm()}>disarm-pop</button>
      <button onClick={() => disarm({ pop: false })}>disarm-keep</button>
    </div>
  )
}

function renderHarness(onLeave?: () => void) {
  return render(
    <LeaveGuardProvider>
      <Harness onLeave={onLeave} />
    </LeaveGuardProvider>,
  )
}

describe('LeaveGuardProvider history marker', () => {
  let goSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Start every test from a clean (non-marker) top entry.
    history.replaceState(null, '', location.href)
  })

  afterEach(() => {
    goSpy.mockRestore()
    history.replaceState(null, '', location.href)
  })

  it('arm pushes a marker and default disarm pops it with one go(-1)', () => {
    renderHarness()
    fireEvent.click(screen.getByText('arm'))
    expect(history.state).toEqual(MARKER)

    goSpy = vi.spyOn(history, 'go').mockImplementation(((() => {}) as typeof history.go))
    fireEvent.click(screen.getByText('disarm-pop'))
    expect(goSpy).toHaveBeenCalledWith(-1)
  })

  it("disarm({ pop: false }) leaves the marker without traversing", () => {
    renderHarness()
    fireEvent.click(screen.getByText('arm'))
    expect(history.state).toEqual(MARKER)

    goSpy = vi.spyOn(history, 'go').mockImplementation(((() => {}) as typeof history.go))
    fireEvent.click(screen.getByText('disarm-keep'))
    expect(goSpy).not.toHaveBeenCalled()
    expect(history.state).toEqual(MARKER)
  })

  it('arm does not stack a second marker when the top entry already is one', () => {
    renderHarness()

    // Simulate a prior programmatic exit that left a marker behind.
    history.pushState(MARKER, '')
    const pushSpy = vi.spyOn(history, 'pushState')
    fireEvent.click(screen.getByText('arm'))
    expect(pushSpy).not.toHaveBeenCalled()
    pushSpy.mockRestore()
  })

  it('a leftover marker is absorbed silently: Back while disarmed consumes it', () => {
    const onLeave = vi.fn()
    renderHarness(onLeave)
    fireEvent.click(screen.getByText('arm'))

    // Programmatic-style exit: teardown without popping.
    fireEvent.click(screen.getByText('disarm-keep'))
    expect(history.state).toEqual(MARKER)

    // The user presses browser Back: the guard is disarmed, so the stale
    // marker is consumed invisibly instead of eating the press — and the
    // process's abort callback must NOT fire (nothing is running).
    goSpy = vi.spyOn(history, 'go').mockImplementation(((() => {}) as typeof history.go))
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(goSpy).toHaveBeenCalledWith(-1)
    expect(onLeave).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
