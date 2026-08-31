'use client'

import { useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { signOut } from 'next-auth/react'
import { toast } from 'sonner'
import { AlertTriangle, KeyRound, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ApiError, changePassword, deleteAccount } from '@/services/api'
import type { CurrentUser } from '@/lib/types'

const PASSWORD_MIN_LENGTH = 8

function ChangePasswordForm() {
  const t = useTranslations('settings.danger')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (newPassword !== confirmPassword) {
      setError(t('passwordMismatch'))
      return
    }
    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      setError(t('passwordTooShort'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      await changePassword(currentPassword, newPassword)
      toast.success(t('changeSuccess'))
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      // ApiError carries either the backend's localized `detail` or the
      // localized apiFallback string; anything else is a network error.
      toast.error(err instanceof ApiError ? err.message : t('changeFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3" data-testid="change-password-form">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <h4 className="text-sm font-semibold text-foreground">{t('changePassword')}</h4>
      </div>
      <Input
        type="password"
        placeholder={t('currentPassword')}
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        autoComplete="current-password"
        data-testid="current-password"
      />
      <Input
        type="password"
        placeholder={t('newPassword')}
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        autoComplete="new-password"
        data-testid="new-password"
      />
      <Input
        type="password"
        placeholder={t('confirmPassword')}
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        autoComplete="new-password"
        data-testid="confirm-password"
      />
      {error && (
        <p className="rounded-md border border-status-high/30 bg-status-high/10 px-2 py-1 text-xs text-status-high">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={saving} data-testid="save-password">
        {saving ? t('saving') : t('save')}
      </Button>
    </form>
  )
}

export function DangerZoneCard({ user }: { user: CurrentUser | null }) {
  const t = useTranslations('settings.danger')
  const tc = useTranslations('common')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isRegistered = user !== null

  async function handleDelete() {
    setDeleting(true)
    setError(null)
    try {
      await deleteAccount()
      setConfirmOpen(false)
      toast.success(t('deleted'))
      if (isRegistered) {
        await signOut({ callbackUrl: '/' })
      } else {
        // Full reload onto a fresh anonymous session — the backend already
        // cleared the anon cookie.
        window.location.assign('/')
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div
      className="rounded-xl border border-status-high/30 bg-status-high/5 p-6"
      data-testid="danger-zone-card"
    >
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle className="size-4 text-status-high" />
        <h3 className="text-sm font-semibold text-status-high">{t('title')}</h3>
      </div>

      {isRegistered && (
        <div className="mb-5 rounded-lg border border-border/60 bg-card p-4">
          <ChangePasswordForm />
        </div>
      )}

      <p className="mb-3 text-sm text-muted-foreground">{t('deleteWarning')}</p>

      <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
        <PopoverTrigger asChild>
          <Button variant="destructive" disabled={deleting} data-testid="delete-account">
            <Trash2 className="size-4" />
            {isRegistered ? t('deleteAccount') : t('deleteData')}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-80" data-testid="delete-account-confirm">
          <div className="space-y-3">
            <p className="text-sm font-semibold text-foreground">
              {isRegistered ? t('deleteConfirmTitle') : t('deleteAnonConfirmTitle')}
            </p>
            <p className="text-xs text-muted-foreground">{t('deleteConfirmBody')}</p>
            {error && (
              <p className="rounded-md border border-status-high/30 bg-status-high/10 px-2 py-1 text-xs text-status-high">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmOpen(false)}
                disabled={deleting}
              >
                {tc('cancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={deleting}
                data-testid="delete-account-confirm-button"
              >
                {deleting ? t('deleting') : tc('delete')}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
