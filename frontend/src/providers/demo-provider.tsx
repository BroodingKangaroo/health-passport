'use client'

import { createContext, useContext } from 'react'

interface DemoModeContextValue {
  isDemo: boolean
}

// Default false: every surface outside /demo behaves exactly as before. The
// demo page wraps its content with DemoModeProvider so real components can
// hide stateful affordances (entry deletion) that have nothing to act on
// when the data is a static fixture.
const DemoModeContext = createContext<DemoModeContextValue>({ isDemo: false })

export function DemoModeProvider({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <DemoModeContext.Provider value={{ isDemo: true }}>
      {children}
    </DemoModeContext.Provider>
  )
}

export function useDemoMode(): DemoModeContextValue {
  return useContext(DemoModeContext)
}
