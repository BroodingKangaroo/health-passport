'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Info, Unlink } from 'lucide-react'

import { Button } from '@/components/ui/button'

/**
 * The two non-record states of the public surface.
 *
 * `SharedUnavailable` covers every dead link — unknown, expired and revoked —
 * with ONE page and one message. It never confirms what the link was, when it
 * stopped working, or who shared it: a stranger who finds or guesses a dead
 * token learns nothing.
 */
export function SharedUnavailable() {
  const t = useTranslations('sharedView')
  return (
    <Shell icon={<Unlink className="size-5" aria-hidden />}>
      <h1 className="text-lg font-semibold text-foreground">{t('deadLink.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('deadLink.body')}</p>
    </Shell>
  )
}

/** The link may still be valid; the record could not be loaded. */
export function SharedLoadError() {
  const t = useTranslations('sharedView')
  return (
    <Shell icon={<Info className="size-5" aria-hidden />}>
      <h1 className="text-lg font-semibold text-foreground">{t('error.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('error.body')}</p>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        {t('error.retry')}
      </Button>
    </Shell>
  )
}

function Shell({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-5">
      <div className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-border bg-card px-6 py-8">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </span>
        {children}
      </div>
    </div>
  )
}

/**
 * Keeps `<html lang>` honest when `?lang=` overrides the Accept-Language the
 * layout rendered with. Layouts never receive `searchParams`, so the page
 * hands the final locale down here.
 */
export function DocumentLang({ locale }: { locale: string }) {
  useEffect(() => {
    if (document.documentElement.lang !== locale) {
      document.documentElement.lang = locale
    }
  }, [locale])
  return null
}
