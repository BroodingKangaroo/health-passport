'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { FlaskConical, HeartPulse, Info, Moon, Sun } from 'lucide-react'

import { Button, buttonVariants } from '@/components/ui/button'
import { LanguageSwitch } from '@/components/shared/language-switch'
import { useTheme } from '@/providers/theme-provider'
import { useAuthStatus } from '@/components/providers/AuthStatusProvider'
import { TimelineContent } from '@/views/TimelineView'
import { buildDemoTimeline, type DemoLocale } from '@/demo/demo-data'
import { cn } from '@/lib/utils'

/**
 * The /demo marketing surface: the real timeline components rendered from
 * the fictional demo fixture. No API calls, no session state, no persisted
 * data — the "show, don't ask for trust" surface. Data-view navigation
 * (NavBar, full-details) is intentionally absent: those views read real
 * backend state.
 */
export function DemoTimelineView() {
  const t = useTranslations('demo')
  const th = useTranslations('header')
  const locale = useLocale() as DemoLocale
  const { theme, toggleTheme } = useTheme()
  const { status } = useAuthStatus()

  const data = useMemo(() => buildDemoTimeline(locale), [locale])

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <HeartPulse className="size-5" aria-hidden />
          </div>
          <span className="text-sm font-bold text-foreground">HealthPassport</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
            <FlaskConical className="size-3" aria-hidden />
            {t('badge')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon-sm" onClick={toggleTheme} aria-label={th('toggleTheme')}>
            {theme === 'light' ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
          </Button>
          <LanguageSwitch />
          {status !== 'authenticated' && (
            <Link
              href="/login"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'hidden sm:inline-flex')}
            >
              {th('signIn')}
            </Link>
          )}
        </div>
      </header>

      <div className="border-b border-primary/20 bg-primary/5 px-5 py-3">
        <div className="mx-auto flex max-w-[1400px] flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5">
            <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-foreground">{t('bannerTitle')}</p>
              <p className="text-xs text-muted-foreground">{t('bannerText')}</p>
            </div>
          </div>
          <Link
            href="/add-entry"
            className={cn(buttonVariants({ size: 'sm' }), 'shrink-0')}
          >
            {t('bannerCta')}
          </Link>
        </div>
      </div>

      <TimelineContent data={data} isLoading={false} error={null} refetch={() => {}} />
    </div>
  )
}
