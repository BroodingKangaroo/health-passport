'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import {
  Download,
  HeartPulse,
  Moon,
  Sun,
  Trash2,
  UserRound,
} from 'lucide-react'

import { Button, buttonVariants } from '@/components/ui/button'
import { LanguageSwitch } from '@/components/shared/language-switch'
import { useTheme } from '@/providers/theme-provider'
import { useAuthStatus } from '@/components/providers/AuthStatusProvider'
import { fetchUsageLimits } from '@/services/api'
import { cn } from '@/lib/utils'

const badges = [
  { icon: Trash2, titleKey: 'badgeDeleteTitle', textKey: 'badgeDeleteText' },
  { icon: Download, titleKey: 'badgeExportTitle', textKey: 'badgeExportText' },
  { icon: UserRound, titleKey: 'badgeTrialTitle', textKey: 'badgeTrialText' },
] as const

const steps = [
  { titleKey: 'howStep1Title', textKey: 'howStep1Text' },
  { titleKey: 'howStep2Title', textKey: 'howStep2Text' },
  { titleKey: 'howStep3Title', textKey: 'howStep3Text' },
] as const

// Fallback when /usage/limits is unreachable: matches ANONYMOUS_LIMITS in
// backend/config.py so the copy never over-promises.
const FALLBACK_TRIAL_LIMIT = 5

export function LandingHero() {
  const t = useTranslations('landing')
  const th = useTranslations('header')
  const { theme, toggleTheme } = useTheme()
  const { status, user } = useAuthStatus()
  const isRegistered = status === 'authenticated' && user !== null

  const { data: limits } = useQuery({
    queryKey: ['usage-limits'],
    queryFn: fetchUsageLimits,
    staleTime: Infinity,
    retry: false,
    enabled: !isRegistered,
  })
  const trialLimit = limits?.ai_extraction_limit ?? FALLBACK_TRIAL_LIMIT

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <HeartPulse className="size-5" aria-hidden />
          </div>
          <span className="text-sm font-bold text-foreground">HealthPassport</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon-sm" onClick={toggleTheme} aria-label={th('toggleTheme')}>
            {theme === 'light' ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
          </Button>
          <LanguageSwitch />
          {!isRegistered && (
            <Link
              href="/login"
              className={cn(
                buttonVariants({ variant: 'outline', size: 'sm' }),
                'hidden sm:inline-flex',
              )}
            >
              {th('signIn')}
            </Link>
          )}
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center px-4 py-12 sm:py-16">
        <section className="mx-auto max-w-2xl text-center">
          <h1 className="text-balance text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            {t('title')}
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
            {t('subtitle')}
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/add-entry"
              className={cn(buttonVariants({ size: 'lg' }), 'w-full px-6 sm:w-auto')}
            >
              {isRegistered ? t('ctaTryRegistered') : t('ctaTry')}
            </Link>
            {!isRegistered && (
              <Link
                href="/login"
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'lg' }),
                  'w-full px-6 sm:w-auto sm:hidden',
                )}
              >
                {th('signIn')}
              </Link>
            )}
          </div>
          {!isRegistered && (
            <p className="mt-3 text-xs text-muted-foreground">{t('ctaNote', { count: trialLimit })}</p>
          )}
        </section>

        <section aria-label={t('howTitle')} className="mt-14 w-full max-w-3xl">
          <h2 className="text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t('howTitle')}
          </h2>
          <ol className="mt-5 grid gap-4 sm:grid-cols-3">
            {steps.map((s, i) => (
              <li key={s.titleKey} className="rounded-xl border border-border bg-card p-5 text-center">
                <div className="mx-auto flex size-8 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                  {i + 1}
                </div>
                <p className="mt-3 text-sm font-semibold text-foreground">{t(s.titleKey)}</p>
                <p className="mt-1 text-pretty text-xs text-muted-foreground">{t(s.textKey)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-label={t('badgeSectionLabel')} className="mt-4 w-full max-w-3xl">
          <ul className="grid gap-4 sm:grid-cols-3">
            {badges.map((b) => (
              <li key={b.titleKey} className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <b.icon className="size-4" aria-hidden />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">{t(b.titleKey)}</p>
                  <p className="mt-0.5 text-pretty text-xs text-muted-foreground">
                    {b.textKey === 'badgeTrialText' ? t(b.textKey, { count: trialLimit }) : t(b.textKey)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-border bg-card px-4 py-4">
        <p className="mx-auto max-w-2xl text-center text-xs text-muted-foreground">
          {t('privacyNote')}
        </p>
      </footer>
    </div>
  )
}
