'use client'

import { useState, useRef, useCallback } from 'react'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'

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

interface Props {
  value: string
  originalName?: string
  onNameChange: (name: string) => void
  onUnitChange: (unit: string) => void
  onRangeChange: (range: string) => void
}

function formatRangeHint(def: {
  unit: string
  range_min: number | null
  range_max: number | null
}): string {
  if (!def.range_min && !def.range_max) return `(${def.unit})`
  return `(${def.unit}, range: ${def.range_min}–${def.range_max})`
}

export function BiomarkerCombobox({
  value,
  originalName,
  onNameChange,
  onUnitChange,
  onRangeChange,
}: Props) {
  const { definitions, loading, error } = useBiomarkerDefinitions()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = definitions.filter((d) =>
    d.name_en.toLowerCase().includes(search.toLowerCase()),
  )

  const selected = definitions.find((d) => d.name_en === value)

  const handleSelect = useCallback(
    (def: (typeof definitions)[number]) => {
      onNameChange(def.name_en)
      onUnitChange(def.unit)
      const rangeStr =
        def.range_min || def.range_max
          ? `${def.range_min}–${def.range_max}`
          : ''
      onRangeChange(rangeStr)
      setSearch(def.name_en)
      setOpen(false)
    },
    [onNameChange, onUnitChange, onRangeChange],
  )

  const handleAddNew = useCallback(() => {
    onNameChange(search.trim())
    onUnitChange('')
    onRangeChange('')
    setOpen(false)
  }, [search, onNameChange, onUnitChange, onRangeChange])

  const showAddNew =
    search.trim().length > 0 &&
    !filtered.some((d) => d.name_en.toLowerCase() === search.trim().toLowerCase())

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
            {selected ? selected.name_en : value || 'Search biomarker…'}
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
              {!loading && filtered.length === 0 && !showAddNew && (
                <CommandEmpty>No biomarker found.</CommandEmpty>
              )}
              {filtered.length > 0 && (
                <CommandGroup heading="Existing biomarkers">
                  {filtered.map((def) => (
                    <CommandItem
                      key={def.id}
                      value={def.name_en}
                      onSelect={() => handleSelect(def)}
                    >
                      <Check
                        className={cn(
                          'mr-2 size-3',
                          value === def.name_en ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      <span className="flex-1 truncate">{def.name_en}</span>
                      <span className="ml-2 truncate text-[11px] text-muted-foreground">
                        {formatRangeHint(def)}
                      </span>
                    </CommandItem>
                  ))}
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
