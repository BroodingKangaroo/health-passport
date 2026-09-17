'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { Info, Lock, Unlink } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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

/**
 * The unlock prompt for a passcode-protected link (Stage 4, S15).
 *
 * This is the FIRST PAINT of a protected link, and the only reason the public
 * surface has two of them: the server cannot read the record without the code,
 * so it renders this instead and the record arrives after a successful unlock.
 * An unprotected link never mounts this and keeps the server-rendered record
 * it has had since Stage 1.
 *
 * The two failure lines are deliberately different: a wrong code and a
 * rate-limited link are different situations for the person reading them, and
 * neither reveals anything about the link itself beyond what they typed.
 */
export function SharedPasscodePrompt({
  onSubmit,
  state,
}: {
  onSubmit: (passcode: string) => void
  state: 'idle' | 'checking' | 'failed' | 'throttled'
}) {
  const t = useTranslations('sharedView')
  const [passcode, setPasscode] = useState('')
  const busy = state === 'checking'

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!passcode || busy) return
    onSubmit(passcode)
  }

  return (
    <Shell icon={<Lock className="size-5" aria-hidden />}>
      <h1 className="text-lg font-semibold text-foreground">{t('passcode.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('passcode.body')}</p>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('passcode.label')}
          <Input
            type="password"
            value={passcode}
            autoFocus
            autoComplete="off"
            // Never spell-check or remember a clinical record's passcode.
            spellCheck={false}
            onChange={(event) => setPasscode(event.target.value)}
            disabled={busy}
            data-testid="share-passcode-input"
          />
        </label>
        {state === 'failed' && (
          <p className="text-sm text-destructive" role="alert">
            {t('passcode.failed')}
          </p>
        )}
        {state === 'throttled' && (
          <p className="text-sm text-destructive" role="alert">
            {t('passcode.throttled')}
          </p>
        )}
        <Button type="submit" size="sm" disabled={busy || !passcode}>
          {busy ? t('passcode.checking') : t('passcode.submit')}
        </Button>
      </form>
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
