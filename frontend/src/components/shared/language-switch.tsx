'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { cn } from '@/lib/utils'
import { setLocaleCookie } from '@/i18n/api-locale'

const LOCALES = [
  { id: 'en', label: 'EN' },
  { id: 'ru', label: 'RU' },
] as const

/**
 * EN | RU switch. Sets the `NEXT_LOCALE` cookie (the single source of truth,
 * read by `src/i18n/request.ts` and by the Accept-Language header in
 * services/api.ts) and re-renders the server tree via `router.refresh()` so
 * `<html lang>` and the active message set swap without a full page reload.
 */
export function LanguageSwitch({ className }: { className?: string }) {
  const locale = useLocale()
  const router = useRouter()
  const t = useTranslations('languageSwitch')
  const [pending, startTransition] = useTransition()

  function switchTo(next: string) {
    if (next === locale || pending) return
    setLocaleCookie(next === 'ru' ? 'ru' : 'en')
    startTransition(() => router.refresh())
  }

  return (
    <div
      role="group"
      aria-label={t('label')}
      className={cn(
        'inline-flex items-center rounded-md border border-border bg-background p-0.5',
        pending && 'opacity-60',
        className,
      )}
    >
      {LOCALES.map((l) => (
        <button
          key={l.id}
          type="button"
          onClick={() => switchTo(l.id)}
          aria-pressed={locale === l.id}
          disabled={pending}
          className={cn(
            'rounded px-2 py-1 text-xs font-medium transition-colors',
            locale === l.id
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {l.label}
        </button>
      ))}
    </div>
  )
}
