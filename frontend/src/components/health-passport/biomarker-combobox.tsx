'use client'

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Check, ChevronsUpDown, Plus, AlertTriangle } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command'
import { useBiomarkerDefinitions } from '@/lib/hooks/useBiomarkerDefinitions'
import { formatReference } from '@/lib/reference'
import type { Reference } from '@/lib/types'

interface Props {
  value: string
  originalName?: string
  definitionId?: string
  scope?: string
  onNameChange: (name: string) => void
  onUnitChange: (unit: string) => void
  onReferenceChange: (reference: Reference | null) => void
  onDefinitionIdChange: (id: string) => void
  onScopeChange: (scope: string) => void
}

function formatRangeHint(def: { unit: string; reference: Reference | null }): string {
  const ref = formatReference(def.reference)
  return ref === '—' ? `(${def.unit})` : `(${def.unit}, ref: ${ref})`
}

export function BiomarkerCombobox({
  value,
  originalName,
  definitionId,
  scope,
  onNameChange,
  onUnitChange,
  onReferenceChange,
  onDefinitionIdChange,
  onScopeChange,
}: Props) {
  const { definitions, loading, error } = useBiomarkerDefinitions()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState(value)
  const [debounced, setDebounced] = useState(search)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 150)
    return () => clearTimeout(t)
  }, [search])

  const MAX_RESULTS = 50
  const filtered = useMemo(() => {
    const q = debounced.trim().toLowerCase()
    if (!q) return []
    const matched = definitions.filter((d) => {
      if (d.names.en.toLowerCase().includes(q)) return true
      return (d.synonyms ?? []).some((s) => s.toLowerCase().includes(q))
    })
    return matched.slice(0, MAX_RESULTS)
  }, [definitions, debounced])

  const totalMatches = useMemo(() => {
    const q = debounced.trim().toLowerCase()
    if (!q) return 0
    return definitions.filter((d) => {
      if (d.names.en.toLowerCase().includes(q)) return true
      return (d.synonyms ?? []).some((s) => s.toLowerCase().includes(q))
    }).length
  }, [definitions, debounced])

  const selected = definitions.find((d) => d.names.en === value)

  const handleSelect = useCallback(
    (def: (typeof definitions)[number]) => {
      onNameChange(def.names.en)
      onUnitChange(def.reference?.kind === 'qualitative' ? 'Qualitative' : def.unit)
      // Emit the definition's structured reference straight through; the
      // backend consumes the {kind, low/high | expected} object directly.
      onReferenceChange(def.reference)
      onDefinitionIdChange(def.id)
      onScopeChange('global')
      setSearch(def.names.en)
      setOpen(false)
    },
    [onNameChange, onUnitChange, onReferenceChange, onDefinitionIdChange, onScopeChange],
  )

  const handleAddNew = useCallback(() => {
    onNameChange(search.trim())
    onUnitChange('')
    onReferenceChange(null)
    onDefinitionIdChange('')
    onScopeChange('local')
    setOpen(false)
  }, [search, onNameChange, onUnitChange, onReferenceChange, onDefinitionIdChange, onScopeChange])

  const showAddNew =
    search.trim().length > 0 &&
    !filtered.some((d) => d.names.en.toLowerCase() === search.trim().toLowerCase())

  if (error) {
    return (
      <div className="flex flex-col gap-0.5">
        <Input
          ref={inputRef}
          value={value}
          placeholder="Name"
          onChange={(e) => onNameChange(e.target.value)}
        />
        {originalName && (
          <span
            className="mt-1 truncate text-xs text-muted-foreground"
            title={originalName}
          >
            {originalName}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn(
              'h-8 w-full justify-between px-3 text-sm font-normal',
              !selected && 'text-muted-foreground',
            )}
          >
            <span className="flex items-center gap-1.5 truncate">
              {scope === 'local' && (
                <AlertTriangle className="size-3 shrink-0 text-amber-500" />
              )}
              {selected ? selected.names.en : value || 'Search biomarker…'}
            </span>
            <ChevronsUpDown className="ml-2 size-3 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search biomarker…"
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              {loading && (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  Loading definitions…
                </div>
              )}
              {!loading && debounced.trim().length === 0 && (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  Type to search biomarkers…
                </div>
              )}
              {!loading && debounced.trim().length > 0 && filtered.length === 0 && !showAddNew && (
                <CommandEmpty>No biomarker found.</CommandEmpty>
              )}
              {filtered.length > 0 && (
                <CommandGroup heading="Existing biomarkers">
                  {filtered.map((def) => (
                    <CommandItem
                      key={def.id}
                      value={def.names.en}
                      onSelect={() => handleSelect(def)}
                    >
                      <Check
                        className={cn(
                          'mr-2 size-3',
                          value === def.names.en ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      <span className="flex-1 truncate">{def.names.en}</span>
                      <span className="ml-2 truncate text-[11px] text-muted-foreground">
                        {formatRangeHint(def)}
                      </span>
                    </CommandItem>
                  ))}
                  {totalMatches > filtered.length && (
                    <div className="px-2 py-1.5 text-center text-[11px] text-muted-foreground">
                      Showing {filtered.length} of {totalMatches} — keep typing to narrow
                    </div>
                  )}
                </CommandGroup>
              )}
              {showAddNew && (
                <CommandItem
                  value={search.trim()}
                  onSelect={handleAddNew}
                  className="text-primary"
                >
                  <Plus className="mr-2 size-3" />
                  Add &lsquo;{search.trim()}&rsquo; as new
                </CommandItem>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {scope === 'local' && (
        <span className="mt-0.5 flex items-center gap-1 text-[11px] text-amber-600">
          <AlertTriangle className="size-3" />
          Unrecognized — not in global dictionary
        </span>
      )}
      {originalName && (
        <span
          className="mt-1 truncate text-xs text-muted-foreground"
          title={originalName}
        >
          {originalName}
        </span>
      )}
    </div>
  )
}
