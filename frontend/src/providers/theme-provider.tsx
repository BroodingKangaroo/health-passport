'use client'

import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'

type Theme = 'light' | 'dark'

// External store for the theme. Kept outside React (localStorage + <html> class)
// so initializing from persisted state never needs a setState-during-effect.
let cached: Theme = 'light'
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribeTheme(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getThemeSnapshot(): Theme {
  return cached
}

function getThemeServerSnapshot(): Theme {
  return 'light'
}

function initTheme(): Theme {
  const stored = localStorage.getItem('theme-preference') as Theme | null
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: Theme) {
  cached = theme
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.classList.toggle('light', theme === 'light')
  localStorage.setItem('theme-preference', theme)
  emit()
}

const ThemeContext = createContext<{
  theme: Theme
  toggleTheme: () => void
} | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeServerSnapshot)

  useEffect(() => {
    applyTheme(initTheme())
  }, [])

  const toggleTheme = () => applyTheme(theme === 'light' ? 'dark' : 'light')

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}