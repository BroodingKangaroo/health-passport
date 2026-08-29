import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { LeaveGuardProvider, useLeaveGuard } from '@/providers/leave-guard-provider'
import { TestI18nProvider } from '@/test/i18n-test-provider'

let leaveResolved: boolean | undefined
let onLeaveFired = 0

function Harness() {
  const { busy, arm, disarm, confirmLeave } = useLeaveGuard()
  return (
    <div>
      <span data-testid="busy">{String(busy)}</span>
      <button onClick={() => arm('AI extraction is in progress.', () => { onLeaveFired++ })}>start</button>
      <button onClick={() => disarm()}>stop</button>
      <button
        onClick={() => {
          void confirmLeave().then((ok) => {
            leaveResolved = ok
          })
        }}
      >
        ask
      </button>
    </div>
  )
}

function renderComponent() {
  return render(
    <TestI18nProvider>
      <LeaveGuardProvider>
        <Harness />
      </LeaveGuardProvider>
    </TestI18nProvider>,
  )
}

async function pressBack() {
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await screen.findByRole('alertdialog')
}

describe('LeaveGuardProvider', () => {
  beforeEach(() => {
    leaveResolved = undefined
    onLeaveFired = 0
    // Reset any history markers left by previous tests.
    history.pushState({}, '')
  })

  it('renders children and starts idle without a dialog', () => {
    renderComponent()
    expect(screen.getByTestId('busy').textContent).toBe('false')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('navigates freely (no dialog) when no process is running', async () => {
    renderComponent()
    fireEvent.click(screen.getByText('ask'))
    await waitFor(() => expect(leaveResolved).toBe(true))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('shows the styled dialog with the armed message when the user presses back', async () => {
    renderComponent()
    fireEvent.click(screen.getByText('start'))
    expect(screen.getByTestId('busy').textContent).toBe('true')

    await pressBack()

    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.getByText('AI extraction is in progress.')).toBeTruthy()
  })

  it('stays on the page and stays busy when the user chooses to stay', async () => {
    renderComponent()
    fireEvent.click(screen.getByText('start'))
    await pressBack()

    fireEvent.click(screen.getByText('Stay'))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByTestId('busy').textContent).toBe('true')
  })

  it('stays when the user clicks the backdrop outside the dialog', async () => {
    renderComponent()
    fireEvent.click(screen.getByText('start'))
    await pressBack()

    // Click the dimmed overlay itself (target === currentTarget).
    fireEvent.click(await screen.findByRole('alertdialog'))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByTestId('busy').textContent).toBe('true')
  })

  it('ignores clicks inside the dialog panel', async () => {
    renderComponent()
    fireEvent.click(screen.getByText('start'))
    await pressBack()

    // A click on the panel content bubbles up to the backdrop handler but
    // must not count as an outside click.
    await screen.findByRole('alertdialog')
    fireEvent.click(screen.getByText('Leave while AI is working?'))

    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(leaveResolved).toBeUndefined()
  })
  it('disarms and lets the user leave when they confirm', async () => {
    renderComponent()
    fireEvent.click(screen.getByText('start'))
    await pressBack()

    fireEvent.click(screen.getByText('Leave anyway'))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByTestId('busy').textContent).toBe('false')
  })

  it('re-asks on a second back press after staying', async () => {
    renderComponent()
    fireEvent.click(screen.getByText('start'))
    await pressBack()
    fireEvent.click(screen.getByText('Stay'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    await pressBack()

    expect(screen.getByRole('alertdialog')).toBeTruthy()
    fireEvent.click(screen.getByText('Leave anyway'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByTestId('busy').textContent).toBe('false')
  })

  it('confirmLeave asks while guarded and only resolves true on confirmation', async () => {
    renderComponent()
    fireEvent.click(screen.getByText('start'))

    fireEvent.click(screen.getByText('ask'))
    await screen.findByRole('alertdialog')
    fireEvent.click(screen.getByText('Stay'))
    await waitFor(() => expect(leaveResolved).toBe(false))

    fireEvent.click(screen.getByText('ask'))
    await screen.findByRole('alertdialog')
    fireEvent.click(screen.getByText('Leave anyway'))
    await waitFor(() => expect(leaveResolved).toBe(true))
    expect(screen.getByTestId('busy').textContent).toBe('false')
  })

  it('disarm stops guarding and closes a pending dialog', async () => {
    renderComponent()
    fireEvent.click(screen.getByText('start'))
    await pressBack()

    fireEvent.click(screen.getByText('stop'))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByTestId('busy').textContent).toBe('false')
  })

  it('fires the armed onLeave callback only when leave is confirmed', async () => {
    renderComponent()
    fireEvent.click(screen.getByText('start'))

    // Back + Stay: process keeps running, onLeave must not fire.
    await pressBack()
    fireEvent.click(screen.getByText('Stay'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(onLeaveFired).toBe(0)
    expect(screen.getByTestId('busy').textContent).toBe('true')

    // Back + Leave anyway: onLeave fires so the caller can abort.
    await pressBack()
    fireEvent.click(screen.getByText('Leave anyway'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(onLeaveFired).toBe(1)
    expect(screen.getByTestId('busy').textContent).toBe('false')
  })

  it('fires onLeave on a confirmed in-app leave (confirmLeave)', async () => {
    renderComponent()
    fireEvent.click(screen.getByText('start'))

    fireEvent.click(screen.getByText('ask'))
    fireEvent.click(await screen.findByText('Leave anyway'))

    await waitFor(() => expect(leaveResolved).toBe(true))
    expect(onLeaveFired).toBe(1)
    expect(screen.getByTestId('busy').textContent).toBe('false')
  })

  it('does not fire onLeave when disarmed normally', async () => {
    renderComponent()
    fireEvent.click(screen.getByText('start'))
    fireEvent.click(screen.getByText('stop'))
    expect(onLeaveFired).toBe(0)
  })
})
