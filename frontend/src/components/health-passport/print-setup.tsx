'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Languages, FileOutput, ChevronDown } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { usePrintConfig } from '@/hooks/usePrintConfig'
import { fetchFlowsheetData, translateBiomarkerNames } from '@/services/api'
import type { PrintLang, TranslateLang } from '@/lib/types'

type Mode = 'original' | 'translate' | 'bilingual'

const TARGETS: { id: PrintLang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'de', label: 'German' },
  { id: 'fr', label: 'French' },
  { id: 'es', label: 'Spanish' },
  { id: 'he', label: 'Hebrew' },
  { id: 'pl', label: 'Polish' },
]

const MODES: { id: Mode; title: string; desc: string }[] = [
  {
    id: 'original',
    title: 'Keep Original (Russian)',
    desc: 'No translation \u2014 fastest export.',
  },
  {
    id: 'translate',
    title: 'Translate to\u2026',
    desc: 'Convert all terminology into a single language.',
  },
  {
    id: 'bilingual',
    title: 'Bilingual Format',
    desc: 'Show the original alongside the target language.',
  },
]

export function PrintSetup() {
  const router = useRouter()
  const { mode, targetLanguage, setMode, setTargetLanguage } = usePrintConfig()
  const [translating, setTranslating] = useState(false)

  async function handleGenerate() {
    if (mode === 'original' || targetLanguage === 'en') {
      router.push('/print-editor')
      return
    }
    // The document promises an AI translation: actually perform it before
    // navigating. The backend persists names[lang] on the definitions, so
    // repeated generates of an already-translated document are free.
    setTranslating(true)
    try {
      const data = await fetchFlowsheetData()
      const unique = new Map<string, string>()
      for (const cat of data.matrix) {
        for (const row of cat.rows) {
          const name = row.name.trim()
          // Never ask the LLM to translate an empty name (a def without an
          // English name) — it would hallucinate one.
          if (name) unique.set(row.id, name)
        }
      }
      const names = [...unique].map(([id, name]) => ({ id, name }))
      if (names.length > 0) {
        await translateBiomarkerNames(targetLanguage as TranslateLang, names)
      }
    } catch (err) {
      // Best-effort translation: never block the export. Fall back to the
      // English document (the pre-fix behavior) and explain why.
      const reason = err instanceof Error ? err.message : 'unknown error'
      toast.error(`AI translation failed (${reason}) — the document will use English names.`)
    } finally {
      setTranslating(false)
      router.push('/print-editor')
    }
  }

  return (
    <div className="mx-auto mt-12 max-w-xl px-5">
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="border-b border-border px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <FileOutput className="size-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground">
                Prepare Document for Print/Export
              </h1>
              <p className="text-sm text-muted-foreground">
                AI translation of medical terminology may take a few moments.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3 px-6 py-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Translation Mode
          </p>
          {MODES.map((m) => {
            const selected = mode === m.id
            return (
              <label
                key={m.id}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors',
                  selected
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent',
                )}
              >
                <input
                  type="radio"
                  name="mode"
                  checked={selected}
                  onChange={() => setMode(m.id)}
                  className="mt-0.5 size-4 accent-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {m.title}
                    </span>
                    {m.id !== 'original' && selected && (
                      <div className="relative inline-flex">
                        <select
                          value={targetLanguage}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            setTargetLanguage(e.target.value as PrintLang)
                            setMode(m.id)
                          }}
                          className="appearance-none rounded-md border border-border bg-background py-1 pl-2.5 pr-7 text-xs font-medium text-foreground outline-none focus:border-primary"
                        >
                          {TARGETS.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {m.desc}
                  </p>
                </div>
              </label>
            )
          })}
        </div>

        <div className="border-t border-border px-6 py-4">
          <Button className="h-11 w-full text-sm" onClick={handleGenerate} disabled={translating}>
            <Languages className="size-4" />
            {translating ? 'Translating terminology\u2026' : 'Generate Document'}
          </Button>
        </div>
      </div>
    </div>
  )
}
