import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { toast } from 'sonner'

import { ProfileCard } from '@/components/health-passport/settings/profile-card'
import { UsageCard } from '@/components/health-passport/settings/usage-card'
import { DataExportCard } from '@/components/health-passport/settings/data-export-card'
import { DangerZoneCard } from '@/components/health-passport/settings/danger-zone-card'
import { TestI18nProvider } from '@/test/i18n-test-provider'
import { ApiError } from '@/services/api'
import type { CurrentUser, DeleteAccountResponse, UsageLimits } from '@/lib/types'

// Wrap renders with the i18n context (English) — the cards use useTranslations.
const renderI18n = ((ui: React.ReactElement, options?: Parameters<typeof render>[1]) =>
  render(<TestI18nProvider>{ui}</TestI18nProvider>, options)) as typeof render

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const mockChangePassword = vi.fn()
const mockDeleteAccount = vi.fn()
const mockDownloadExport = vi.fn()
const mockFetchUsageLimits = vi.fn()

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>()
  return {
    ...actual,
    changePassword: (...args: unknown[]) => mockChangePassword(...args),
    deleteAccount: (...args: unknown[]) => mockDeleteAccount(...args),
    downloadAccountExport: (...args: unknown[]) => mockDownloadExport(...args),
    fetchUsageLimits: (...args: unknown[]) => mockFetchUsageLimits(...args),
  }
})

const mockSignOut = vi.fn()
vi.mock('next-auth/react', () => ({
  signOut: (...args: unknown[]) => mockSignOut(...args),
}))

const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

const TEST_USER: CurrentUser = {
  id: 'user-1',
  email: 'user@example.com',
  name: 'Jane Doe',
  dob: '1990-05-01',
  gender: 'female',
  external_id: 'HP-1',
}

const LIMITS: UsageLimits = {
  is_anonymous: false,
  ai_extraction_count: 12,
  ai_extraction_limit: 50,
  total_upload_size_bytes: 150 * 1024 * 1024,
  total_upload_limit_bytes: 200 * 1024 * 1024,
}

const DELETE_RESPONSE: DeleteAccountResponse = {
  message: 'Your data has been permanently deleted.',
  deleted_entries: 13,
  freed_bytes: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ProfileCard', () => {
  it('shows profile fields for a registered user', () => {
    renderI18n(<ProfileCard status="authenticated" user={TEST_USER} anonId={null} />)
    expect(screen.getByText('Jane Doe')).toBeDefined()
    expect(screen.getByText('user@example.com')).toBeDefined()
    expect(screen.getByText('1990-05-01')).toBeDefined()
    expect(screen.getByText('Female')).toBeDefined()
    expect(screen.queryByTestId('profile-anonymous')).toBeNull()
  })

  it('shows the anonymous explainer with a register CTA for anonymous sessions', () => {
    renderI18n(<ProfileCard status="unauthenticated" user={null} anonId="anon-123" />)
    expect(screen.getByTestId('profile-anonymous')).toBeDefined()
    expect(screen.getByText('Anonymous session')).toBeDefined()
    expect(screen.getByText(/anon-123/)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Create an account' })).toBeDefined()
  })

  it('renders the loading skeleton while auth resolves', () => {
    renderI18n(<ProfileCard status="loading" user={null} anonId={null} />)
    expect(screen.getByTestId('profile-loading')).toBeDefined()
  })
})

describe('UsageCard', () => {
  it('renders both usage meters from the fetched limits', async () => {
    mockFetchUsageLimits.mockResolvedValue(LIMITS)
    renderI18n(<UsageCard />)
    await waitFor(() => {
      expect(screen.getByText('12 of 50 used')).toBeDefined()
    })
    expect(screen.getByText('150.0 MB of 200.0 MB used')).toBeDefined()
    // 12/50 = 24%
    const fills = screen.getAllByTestId('usage-bar-fill') as HTMLElement[]
    expect(fills[0].style.width).toBe('24%')
    // 150/200 = 75%
    expect(fills[1].style.width).toBe('75%')
  })

  it('shows the limit-reached label when a meter is exhausted', async () => {
    mockFetchUsageLimits.mockResolvedValue({ ...LIMITS, ai_extraction_count: 50 })
    renderI18n(<UsageCard />)
    await waitFor(() => {
      expect(screen.getByText('Limit reached')).toBeDefined()
    })
  })

  it('renders nothing useful (em dash) when the limits call fails', async () => {
    mockFetchUsageLimits.mockRejectedValue(new Error('down'))
    renderI18n(<UsageCard />)
    await waitFor(() => {
      expect(screen.getByText('—')).toBeDefined()
    })
  })
})

describe('DataExportCard', () => {
  it('downloads the JSON backup when the JSON button is clicked', async () => {
    mockDownloadExport.mockResolvedValue(undefined)
    renderI18n(<DataExportCard />)
    fireEvent.click(screen.getByTestId('export-json'))
    await waitFor(() => {
      expect(mockDownloadExport).toHaveBeenCalledWith('json')
    })
    expect(mockDownloadExport).toHaveBeenCalledTimes(1)
  })

  it('downloads the CSV readings when the CSV button is clicked', async () => {
    mockDownloadExport.mockResolvedValue(undefined)
    renderI18n(<DataExportCard />)
    fireEvent.click(screen.getByTestId('export-csv'))
    await waitFor(() => {
      expect(mockDownloadExport).toHaveBeenCalledWith('csv')
    })
  })

  it('shows an error toast when the download fails', async () => {
    mockDownloadExport.mockRejectedValue(new Error('GET /export failed'))
    renderI18n(<DataExportCard />)
    fireEvent.click(screen.getByTestId('export-json'))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Download failed', {
        description: 'GET /export failed',
      })
    })
  })
})

describe('DangerZoneCard (registered)', () => {
  function fillChangePassword() {
    fireEvent.change(screen.getByTestId('current-password'), { target: { value: 'oldpass123' } })
    fireEvent.change(screen.getByTestId('new-password'), { target: { value: 'newpass456' } })
    fireEvent.change(screen.getByTestId('confirm-password'), { target: { value: 'newpass456' } })
  }

  it('offers change-password and delete-account for a registered user', () => {
    renderI18n(<DangerZoneCard user={TEST_USER} />)
    expect(screen.getByTestId('change-password-form')).toBeDefined()
    expect(screen.getByText('Delete account')).toBeDefined()
  })

  it('submits a valid change-password form and toasts success', async () => {
    mockChangePassword.mockResolvedValue(undefined)
    renderI18n(<DangerZoneCard user={TEST_USER} />)
    fillChangePassword()
    fireEvent.click(screen.getByTestId('save-password'))
    await waitFor(() => {
      expect(mockChangePassword).toHaveBeenCalledWith('oldpass123', 'newpass456')
    })
    expect(toast.success).toHaveBeenCalledWith('Password changed.')
  })

  it('rejects mismatched passwords client-side without calling the API', () => {
    renderI18n(<DangerZoneCard user={TEST_USER} />)
    fireEvent.change(screen.getByTestId('current-password'), { target: { value: 'oldpass123' } })
    fireEvent.change(screen.getByTestId('new-password'), { target: { value: 'newpass456' } })
    fireEvent.change(screen.getByTestId('confirm-password'), { target: { value: 'different' } })
    fireEvent.click(screen.getByTestId('save-password'))
    expect(mockChangePassword).not.toHaveBeenCalled()
    expect(screen.getByText('Passwords do not match')).toBeDefined()
  })

  it('rejects short passwords client-side', () => {
    renderI18n(<DangerZoneCard user={TEST_USER} />)
    fireEvent.change(screen.getByTestId('current-password'), { target: { value: 'oldpass123' } })
    fireEvent.change(screen.getByTestId('new-password'), { target: { value: 'short' } })
    fireEvent.change(screen.getByTestId('confirm-password'), { target: { value: 'short' } })
    fireEvent.click(screen.getByTestId('save-password'))
    expect(mockChangePassword).not.toHaveBeenCalled()
    expect(screen.getByText('Password must be at least 8 characters')).toBeDefined()
  })

  it('surfaces the backend detail when the current password is wrong', async () => {
    mockChangePassword.mockRejectedValue(new ApiError(400, 'Current password is incorrect'))
    renderI18n(<DangerZoneCard user={TEST_USER} />)
    fillChangePassword()
    fireEvent.click(screen.getByTestId('save-password'))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Current password is incorrect')
    })
  })

  it('deletes the account after confirmation and signs out', async () => {
    mockDeleteAccount.mockResolvedValue(DELETE_RESPONSE)
    mockSignOut.mockResolvedValue(undefined)
    renderI18n(<DangerZoneCard user={TEST_USER} />)
    fireEvent.click(screen.getByTestId('delete-account'))
    fireEvent.click(await screen.findByTestId('delete-account-confirm-button'))
    await waitFor(() => {
      expect(mockDeleteAccount).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: '/' })
    })
    expect(toast.success).toHaveBeenCalledWith('Your data has been permanently deleted.')
  })

  it('shows the backend error inside the confirm dialog when deletion fails', async () => {
    mockDeleteAccount.mockRejectedValue(new ApiError(500, 'DELETE /auth/account failed'))
    renderI18n(<DangerZoneCard user={TEST_USER} />)
    fireEvent.click(screen.getByTestId('delete-account'))
    fireEvent.click(await screen.findByTestId('delete-account-confirm-button'))
    await waitFor(() => {
      expect(screen.getByText('DELETE /auth/account failed')).toBeDefined()
    })
    expect(mockSignOut).not.toHaveBeenCalled()
  })
})

describe('DangerZoneCard (anonymous)', () => {
  const assign = vi.fn()

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { assign },
    })
  })

  afterEach(() => {
    // Restore the jsdom location for other suites.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).location
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).location = { href: 'http://localhost/' }
  })

  it('hides change-password and offers session-data deletion for anonymous users', () => {
    renderI18n(<DangerZoneCard user={null} />)
    expect(screen.queryByTestId('change-password-form')).toBeNull()
    expect(screen.getByText('Delete all session data')).toBeDefined()
  })

  it('deletes the session data and reloads onto a fresh session', async () => {
    mockDeleteAccount.mockResolvedValue(DELETE_RESPONSE)
    renderI18n(<DangerZoneCard user={null} />)
    fireEvent.click(screen.getByTestId('delete-account'))
    fireEvent.click(await screen.findByTestId('delete-account-confirm-button'))
    await waitFor(() => {
      expect(mockDeleteAccount).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/')
    })
    expect(mockSignOut).not.toHaveBeenCalled()
  })
})
