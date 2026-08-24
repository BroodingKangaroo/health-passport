'use client'

import { createContext, useState, useCallback, type ReactNode } from 'react'
import type { PrintLang } from '@/lib/types'

type Mode = 'original' | 'translate' | 'bilingual'

interface PrintConfigState {
  mode: Mode
  targetLanguage: PrintLang
  layout: 'portrait' | 'landscape'
  textSize: number
  selectedDates: string[]
  selectedBiomarkers: string[]
  showAbnormalOnly: boolean
  showReferences: boolean
  compactNumbers: boolean
}

interface PrintConfigContextValue extends PrintConfigState {
  setMode: (mode: Mode) => void
  setTargetLanguage: (lang: PrintLang) => void
  setLayout: (layout: 'portrait' | 'landscape') => void
  setTextSize: (size: number) => void
  setSelectedDates: (dates: string[]) => void
  setSelectedBiomarkers: (biomarkers: string[]) => void
  setShowAbnormalOnly: (v: boolean) => void
  setShowReferences: (v: boolean) => void
  setCompactNumbers: (v: boolean) => void
  initFilters: (dates: string[], biomarkers: string[]) => void
}

export const PrintConfigContext = createContext<PrintConfigContextValue | null>(null)

export function PrintConfigProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>('original')
  const [targetLanguage, setTargetLanguage] = useState<PrintLang>('en')
  const [layout, setLayout] = useState<'portrait' | 'landscape'>('portrait')
  const [textSize, setTextSize] = useState(10)
  const [selectedDates, setSelectedDates] = useState<string[]>([])
  const [selectedBiomarkers, setSelectedBiomarkers] = useState<string[]>([])
  const [showAbnormalOnly, setShowAbnormalOnly] = useState(false)
  const [showReferences, setShowReferences] = useState(true)
  const [compactNumbers, setCompactNumbers] = useState(false)

  const initFilters = useCallback((dates: string[], biomarkers: string[]) => {
    setSelectedDates(dates)
    setSelectedBiomarkers(biomarkers)
  }, [])

  return (
    <PrintConfigContext.Provider
      value={{
        mode,
        targetLanguage,
        layout,
        textSize,
        selectedDates,
        selectedBiomarkers,
        showAbnormalOnly,
        showReferences,
        compactNumbers,
        setMode,
        setTargetLanguage,
        setLayout,
        setTextSize,
        setSelectedDates,
        setSelectedBiomarkers,
        setShowAbnormalOnly,
        setShowReferences,
        setCompactNumbers,
        initFilters,
      }}
    >
      {children}
    </PrintConfigContext.Provider>
  )
}
