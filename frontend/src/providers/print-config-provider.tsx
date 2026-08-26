'use client'

import { createContext, useState, useCallback, type ReactNode } from 'react'
import type { PrintLang } from '@/lib/types'
import type { CategoryTranslations } from '@/services/api'

type Mode = 'original' | 'translate' | 'bilingual'

// Category/panel heading translations are never persisted server-side; they
// live here for the current document render and in sessionStorage (keyed by
// language) so refreshing the print editor keeps its translated headings.
const CATEGORY_STORAGE_PREFIX = 'hp-cat-translations:'

function categoryStorageKey(lang: PrintLang): string {
  return `${CATEGORY_STORAGE_PREFIX}${lang}`
}

function readStoredTranslations(lang: PrintLang): CategoryTranslations {
  try {
    const raw = sessionStorage.getItem(categoryStorageKey(lang))
    return raw ? (JSON.parse(raw) as CategoryTranslations) : {}
  } catch {
    // SSR (no sessionStorage), private mode, or corrupt payload: no headings.
    return {}
  }
}

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
  categoryTranslations: CategoryTranslations
  setCategoryTranslations: (map: CategoryTranslations) => void
  // When a generate run fails we force the document to render the English /
  // source names and raw category headings for this navigation into the
  // editor, suppressing any previously-saved translations so the "failed ->
  // English fallback" contract actually holds (saved translations would
  // otherwise still render). Reset on each new attempt and on a successful
  // run.
  suppressSavedTranslations: boolean
  setSuppressSavedTranslations: (v: boolean) => void
}

export const PrintConfigContext = createContext<PrintConfigContextValue | null>(null)

export function PrintConfigProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>('original')
  const [targetLanguage, setTargetLanguageState] = useState<PrintLang>('en')
  const [layout, setLayout] = useState<'portrait' | 'landscape'>('portrait')
  const [textSize, setTextSize] = useState(10)
  const [selectedDates, setSelectedDates] = useState<string[]>([])
  const [selectedBiomarkers, setSelectedBiomarkers] = useState<string[]>([])
  const [showAbnormalOnly, setShowAbnormalOnly] = useState(false)
  const [showReferences, setShowReferences] = useState(true)
  const [compactNumbers, setCompactNumbers] = useState(false)
  // Hydration is folded into render (React's "adjust state when a prop
  // changes" pattern): whenever the target language changes, re-read its
  // stored map synchronously instead of in an effect.
  const [hydratedLang, setHydratedLang] = useState<PrintLang>(targetLanguage)
  const [categoryTranslations, setCategoryTranslationsState] =
    useState<CategoryTranslations>(() => readStoredTranslations(targetLanguage))
  const [suppressSavedTranslations, setSuppressSavedTranslations] =
    useState(false)
  if (hydratedLang !== targetLanguage) {
    setHydratedLang(targetLanguage)
    setCategoryTranslationsState(readStoredTranslations(targetLanguage))
    setSuppressSavedTranslations(false)
  }

  const setTargetLanguage = useCallback((lang: PrintLang) => {
    setTargetLanguageState(lang)
  }, [])

  const setCategoryTranslations = useCallback(
    (map: CategoryTranslations) => {
      setCategoryTranslationsState(map)
      // A successful run supersedes any prior failure suppression.
      setSuppressSavedTranslations(false)
      try {
        sessionStorage.setItem(categoryStorageKey(targetLanguage), JSON.stringify(map))
      } catch {
        // Storage unavailable (private mode/quota): in-memory copy still
        // covers navigation into the editor.
      }
    },
    [targetLanguage],
  )

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
        categoryTranslations,
        setCategoryTranslations,
        suppressSavedTranslations,
        setSuppressSavedTranslations,
      }}
    >
      {children}
    </PrintConfigContext.Provider>
  )
}
