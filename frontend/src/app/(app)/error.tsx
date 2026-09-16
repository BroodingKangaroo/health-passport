'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { AlertCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'

// Route-level error boundary (Next.js app router). Catches render/data
// errors in the page tree below the root layout, so the i18n provider and
// theme are intact — next-intl hooks are safe here.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = useTranslations('shared.errors')

  useEffect(() => {
    // Report-only (no error tracker wired yet): the API-side half of the
    // failure is correlated in app.log via the request middleware.
    console.error('App route error', error)
  }, [error])

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <AlertCircle className="size-8 text-status-high" />
      <h1 className="text-lg font-semibold">{t('title')}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{t('description')}</p>
      <Button onClick={() => reset()}>{t('retry')}</Button>
    </div>
  )
}
