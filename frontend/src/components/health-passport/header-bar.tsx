'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
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

function formatDob(dob: string | undefined): string {
  if (!dob) return ''
  const d = new Date(dob)
  if (isNaN(d.getTime())) return dob
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

export function HeaderBar() {
  const router = useRouter()
  const { status, user, anonId } = useAuthStatus()
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [lang, setLang] = useState<'RU' | 'EN'>('EN')
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

  const handleLogout = () => {
    signOut({ callbackUrl: '/' })
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
                  const dob = formatDob(user.dob)
                  const gender = user.gender?.trim()
                  const ext = user.external_id
                  const parts: string[] = []
                  if (dob) parts.push(`DOB ${dob}`)
                  if (gender) parts.push(gender)
                  if (ext) parts.push(`ID ${ext}`)
                  return parts.length ? ` | ${parts.join(' • ')}` : ''
                })()}
              </>
            ) : (
              <span className="text-muted-foreground/80">
                Anonymous session
                {anonId ? <span className="font-mono text-foreground/70"> · {anonId}</span> : null}
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => router.push('/add-entry')}>
          <Plus className="size-3.5" />
          Add New Entry
        </Button>

        <div className="flex items-center overflow-hidden rounded-lg border border-border bg-secondary text-xs font-medium">
          <button
            onClick={() => setLang('RU')}
            className={
              lang === 'RU'
                ? 'bg-primary px-2.5 py-1.5 text-primary-foreground'
                : 'px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground'
            }
          >
            RU
          </button>
          <span className="px-1 text-muted-foreground">→</span>
          <button
            onClick={() => setLang('EN')}
            className={
              lang === 'EN'
                ? 'bg-primary px-2.5 py-1.5 text-primary-foreground'
                : 'px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground'
            }
          >
            EN MEDICAL
          </button>
        </div>

        <Button variant="outline" size="icon-sm" onClick={toggleTheme} aria-label="Toggle theme">
          {theme === 'light' ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
        </Button>

        <Button variant="outline" size="sm" onClick={() => router.push('/print-setup')}>
          <Printer className="size-3.5" />
          Print
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
                  Sign out
                </button>
              </div>
            )}
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => signIn('credentials', { callbackUrl: '/' })}>
            <LogIn className="size-3.5 mr-1" />
            Sign in
          </Button>
        )}
      </div>
    </header>
  )
}