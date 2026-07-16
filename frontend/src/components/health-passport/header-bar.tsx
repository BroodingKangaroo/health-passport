'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession, signIn, signOut } from "next-auth/react"
import {
  HeartPulse,
  ChevronDown,
  Plus,
  Printer,
  Sun,
  Moon,
  FlaskConical,
  ClipboardPlus,
  ScanLine,
  LogIn,
  LogOut,
  User,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTheme } from '@/providers/theme-provider'

const addOptions = [
  { label: 'Add Lab Result', icon: FlaskConical },
  { label: 'Log Doctor Visit', icon: ClipboardPlus },
  { label: 'Upload MRI Scan', icon: ScanLine },
]

export function HeaderBar() {
  const router = useRouter()
  const { data: session, status } = useSession()
  const [open, setOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [lang, setLang] = useState<'RU' | 'EN'>('EN')
  const { theme, toggleTheme } = useTheme()
  const menuRef = useRef<HTMLDivElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
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
            <span className="font-semibold text-foreground">{session?.user?.name ?? 'Alexey Ivanov'}</span>
            {' | DOB 14 Mar 1988 • Male • ID HP-2026-04417'}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex items-center" ref={menuRef}>
          <Button
            size="sm"
            onClick={() => router.push('/add-entry')}
            className="rounded-r-none"
          >
            <Plus className="size-3.5" />
            Add New Entry
          </Button>
          <Button
            size="sm"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label="Choose entry type"
            className="rounded-l-none border-l border-primary-foreground/20 px-2"
          >
            <ChevronDown className="size-3.5 opacity-80" />
          </Button>
          {open && (
            <div
              role="menu"
              className="absolute right-0 top-full z-20 mt-1.5 w-48 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-lg"
            >
              {addOptions.map((opt) => (
                <button
                  key={opt.label}
                  role="menuitem"
                  onClick={() => {
                    setOpen(false)
                    router.push('/add-entry')
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm text-popover-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <opt.icon className="size-4 text-muted-foreground" />
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

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

        {/* Auth section */}
        {status === 'loading' ? (
          <div className="flex items-center gap-2">
            <div className="w-20 h-8 animate-pulse bg-muted rounded" />
          </div>
        ) : session ? (
          <div className="relative" ref={userMenuRef}>
            <Button variant="outline" size="sm" onClick={() => setUserMenuOpen((v) => !v)} className="gap-1">
              <User className="size-3.5" />
              <span className="hidden sm:inline">{session.user?.name?.split(' ')[0] || session.user?.email}</span>
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