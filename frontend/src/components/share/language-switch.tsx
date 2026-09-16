'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'

import { cn } from '@/lib/utils'
import type { AppLocale } from '@/i18n/messages'

interface LanguageSwitchProps {
  token: string
  locale: string
}

/**
 * The recipient's EN | RU chrome switch (Stage 3, S9/S10).
 *
 * Two plain links: the switch works without JavaScript, never writes the
 * `NEXT_LOCALE` cookie (the shared tree must not touch the recipient's own
 * app locale), and navigating keeps the token where it belongs — in the URL
 * path, with `lang` as the only query parameter. Hidden from print: the
 * printed shared view is the record, nothing else (S12).
 */
export function LanguageSwitch({ token, locale }: LanguageSwitchProps) {
  const t = useTranslations('sharedView.language')
  const options: { value: AppLocale; label: string }[] = [
    { value: 'en', label: t('en') },
    { value: 'ru', label: t('ru') },
  ]
  return (
    <div
      role="group"
      aria-label={t('label')}
      className="flex items-center gap-1 rounded-lg border border-border p-0.5 print:hidden"
    >
      {options.map((option) => {
        const active = option.value === locale
        return (
          <Link
            key={option.value}
            href={`/s/${token}?lang=${option.value}`}
            data-state={active ? 'active' : 'idle'}
            lang={option.value}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </Link>
        )
      })}
    </div>
  )
}
