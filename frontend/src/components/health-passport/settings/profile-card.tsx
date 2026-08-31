'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Calendar, Mail, User, ShieldQuestion } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import type { AuthStatus } from '@/components/providers/AuthStatusProvider'
import type { CurrentUser } from '@/lib/types'

function localizedGender(raw: string, t: (key: string) => string): string {
  const g = raw.trim().toLowerCase()
  if (g === 'male') return t('genderMale')
  if (g === 'female') return t('genderFemale')
  if (g === 'other') return t('genderOther')
  return raw
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
          </div>
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
