'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { signIn, signOut } from "next-auth/react"
import { useAuthStatus } from '@/components/providers/AuthStatusProvider'
import {
  HeartPulse,
  ChevronDown,
  Plus,
  Printer,
  Sun,
  Moon,
  LogIn,
  LogOut,
  User,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTheme } from '@/providers/theme-provider'
import { useLeaveGuard } from '@/providers/leave-guard-provider'
import { LanguageSwitch } from '@/components/shared/language-switch'

function formatDob(dob: string | undefined, locale: string): string {
  if (!dob) return ''
  const d = new Date(dob)
  if (isNaN(d.getTime())) return dob
  return d.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function HeaderBar() {
  const router = useRouter()
  const locale = useLocale()
  const t = useTranslations('header')
  const { confirmLeave } = useLeaveGuard()
  const { status, user, anonId } = useAuthStatus()
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const { theme, toggleTheme } = useTheme()
  const userMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  // Navigating away mid-process (AI extraction / translation) cancels it.
  function navigate(path: string) {
    void confirmLeave().then((ok) => {
      if (ok) router.push(path)
    })
  }

  function localizedGender(raw: string | undefined | null): string {
    const g = raw?.trim().toLowerCase()
    if (!g) return ''
    if (g === 'male') return t('genderMale')
    if (g === 'female') return t('genderFemale')
    if (g === 'other') return t('genderOther')
    return raw as string
  }

  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-card px-5 py-3 print:hidden">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <HeartPulse className="size-5" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-bold text-foreground">HealthPassport</p>
          <p className="text-xs text-muted-foreground">
            {user ? (
              <>
                <span className="font-semibold text-foreground">{user.name}</span>
                {(() => {
                  const dob = formatDob(user.dob, locale)
                  const gender = localizedGender(user.gender)
                  const ext = user.external_id
                  const parts: string[] = []
                  if (dob) parts.push(t('dob', { dob }))
                  if (gender) parts.push(gender)
                  if (ext) parts.push(t('id', { ext }))
                  return parts.length ? ` | ${parts.join(' • ')}` : ''
                })()}
              </>
            ) : (
              <span className="text-muted-foreground/80">
                {t('anonymousSession')}
                {anonId ? <span className="font-mono text-foreground/70"> · {anonId}</span> : null}
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => navigate('/add-entry')}>
          <Plus className="size-3.5" />
          {t('addNewEntry')}
        </Button>

        <Button variant="outline" size="icon-sm" onClick={toggleTheme} aria-label={t('toggleTheme')}>
          {theme === 'light' ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
        </Button>

        <LanguageSwitch />

        <Button variant="outline" size="sm" onClick={() => navigate('/print-setup')}>
          <Printer className="size-3.5" />
          {t('print')}
        </Button>

        {/* Auth section — driven by backend-verified auth status */}
        {status === 'loading' ? (
          <div className="flex items-center gap-2">
            <div className="w-20 h-8 animate-pulse bg-muted rounded" />
          </div>
        ) : user ? (
          <div className="relative" ref={userMenuRef}>
            <Button variant="outline" size="sm" onClick={() => setUserMenuOpen((v) => !v)} className="gap-1">
              <User className="size-3.5" />
              <span className="hidden sm:inline">{user.name?.split(' ')[0] || user.email}</span>
              <ChevronDown className="size-3.5 opacity-80" />
            </Button>
            {userMenuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-20 mt-1.5 w-40 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-lg"
              >
                <button
                  role="menuitem"
                  onClick={() => signOut({ callbackUrl: '/' })}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm text-popover-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <LogOut className="size-4" />
                  {t('signOut')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => signIn('credentials', { callbackUrl: '/' })}>
            <LogIn className="size-3.5 mr-1" />
            {t('signIn')}
          </Button>
        )}
      </div>
    </header>
  )
}
