'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Calendar, Mail, User, ShieldQuestion } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ApiError, changeEmail } from '@/services/api'
import { useEmailDeliveryEnabled } from '@/lib/hooks/useEmailDeliveryEnabled'
import type { AuthStatus } from '@/components/providers/AuthStatusProvider'
import type { CurrentUser } from '@/lib/types'

function localizedGender(raw: string, t: (key: string) => string): string {
  const g = raw.trim().toLowerCase()
  if (g === 'male') return t('genderMale')
  if (g === 'female') return t('genderFemale')
  if (g === 'other') return t('genderOther')
  return raw
}

/**
 * Starts an email change: password re-verification plus a confirmation link to
 * the NEW address. The account's address is untouched until that link is
 * opened, so this form only ever reports "link sent", never "email changed".
 */
function ChangeEmailForm({
  currentEmail,
  onCancel,
}: {
  currentEmail: string
  onCancel: () => void
}) {
  const t = useTranslations('settings.profile')
  const [newEmail, setNewEmail] = useState('')
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)
  // Same instance-level honesty as the reset screen: "link sent" is a lie when
  // this deployment has no SMTP transport.
  const emailDeliveryEnabled = useEmailDeliveryEnabled()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await changeEmail(password, newEmail)
      setSentTo(newEmail)
      setPassword('')
    } catch (err) {
      // ApiError carries the backend's localized detail (wrong password,
      // address already registered, throttled) or the localized fallback.
      setError(err instanceof ApiError ? err.message : t('emailChangeFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (sentTo) {
    return (
      <div className="space-y-3" data-testid="email-change-sent">
        <p className="rounded-md border border-status-normal/30 bg-status-normal/10 px-2 py-1 text-xs text-status-normal">
          {t('emailChangeSent', { email: sentTo, current: currentEmail })}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCancel}
          data-testid="email-change-done"
        >
          {t('cancel')}
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3" data-testid="change-email-form">
      {emailDeliveryEnabled === false && (
        <p
          role="status"
          data-testid="email-delivery-warning"
          className="rounded-md border border-status-high/30 bg-status-high/10 px-2 py-1 text-xs text-status-high"
        >
          {t('emailDeliveryWarning')}
        </p>
      )}
      <Input
        type="email"
        placeholder={t('newEmailPlaceholder')}
        value={newEmail}
        onChange={(e) => setNewEmail(e.target.value)}
        autoComplete="email"
        required
        aria-label={t('newEmail')}
        data-testid="new-email"
      />
      <Input
        type="password"
        placeholder={t('currentPassword')}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        required
        aria-label={t('currentPassword')}
        data-testid="email-change-password"
      />
      {error && (
        <p
          role="alert"
          className="rounded-md border border-status-high/30 bg-status-high/10 px-2 py-1 text-xs text-status-high"
        >
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={saving} data-testid="submit-email-change">
          {saving ? t('sendingChangeEmail') : t('submitChangeEmail')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          data-testid="cancel-email-change"
        >
          {t('cancel')}
        </Button>
      </div>
    </form>
  )
}

export function ProfileCard({
  status,
  user,
  anonId,
}: {
  status: AuthStatus
  user: CurrentUser | null
  anonId: string | null
}) {
  const router = useRouter()
  const t = useTranslations('settings.profile')
  const ta = useTranslations('settings.anonymous')
  const th = useTranslations('header')
  const [editingEmail, setEditingEmail] = useState(false)

  return (
    <Card className="p-6" data-testid="profile-card">
      <div className="mb-4 flex items-center gap-2">
        <User className="size-4 text-muted-foreground" />
        <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {t('title')}
        </h3>
      </div>

      {status === 'loading' ? (
        <div className="space-y-3" data-testid="profile-loading">
          <div className="h-5 w-40 animate-pulse rounded bg-muted" />
          <div className="h-5 w-56 animate-pulse rounded bg-muted" />
        </div>
      ) : user ? (
        <dl className="space-y-3">
          <div>
            <dt className="text-xs text-muted-foreground">{t('name')}</dt>
            <dd className="text-sm font-semibold text-foreground">{user.name}</dd>
          </div>
          <div className="flex items-center gap-2">
            <Mail className="size-3.5 text-muted-foreground" />
            <div>
              <dt className="text-xs text-muted-foreground">{t('email')}</dt>
              <dd className="text-sm font-semibold text-foreground">{user.email}</dd>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto text-xs"
              onClick={() => setEditingEmail((open) => !open)}
              data-testid="change-email-toggle"
            >
              {t('changeEmail')}
            </Button>
          </div>
          {editingEmail ? (
            <div className="rounded-md border border-border p-3">
              <p className="mb-2 text-xs font-semibold text-foreground">
                {t('changeEmailTitle')}
              </p>
              <ChangeEmailForm
                currentEmail={user.email}
                onCancel={() => setEditingEmail(false)}
              />
            </div>
          ) : null}
          {user.dob ? (
            <div className="flex items-center gap-2">
              <Calendar className="size-3.5 text-muted-foreground" />
              <div>
                <dt className="text-xs text-muted-foreground">{t('dob')}</dt>
                <dd className="text-sm font-semibold text-foreground">{user.dob}</dd>
              </div>
            </div>
          ) : null}
          {user.gender ? (
            <div>
              <dt className="text-xs text-muted-foreground">{t('gender')}</dt>
              <dd className="text-sm font-semibold text-foreground">
                {localizedGender(user.gender, (k) => th(k))}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <div className="space-y-4" data-testid="profile-anonymous">
          <div className="flex items-center gap-2">
            <ShieldQuestion className="size-4 text-muted-foreground" />
            <p className="text-sm font-semibold text-foreground">{ta('title')}</p>
          </div>
          {anonId ? (
            <p className="truncate font-mono text-xs text-muted-foreground">
              {ta('sessionId')}: {anonId}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">{ta('description')}</p>
          <Button size="sm" onClick={() => router.push('/register')}>
            {ta('registerCta')}
          </Button>
        </div>
      )}
    </Card>
  )
}
