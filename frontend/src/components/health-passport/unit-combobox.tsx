'use client'

import { useState, useCallback } from 'react'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { cn } from '@/lib/utils'
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
import { qualitativeUnitLabel } from '@/lib/qualitative-labels'
import { unitLabelRu } from '@/lib/unit-labels'

const QUALITATIVE_UNIT = 'Qualitative'
const ALWAYS_SHOWN = [QUALITATIVE_UNIT]

interface UnitComboboxProps {
  value: string
  onChange: (unit: string) => void
  placeholder?: string
}

export function UnitCombobox({
  value,
  onChange,
  placeholder,
}: UnitComboboxProps) {
  const t = useTranslations('unitCombobox')
  const locale = useLocale()
  const resolvedPlaceholder = placeholder ?? t('searchPlaceholder')
  const { definitions, loading } = useBiomarkerDefinitions()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState(value)
  // Keep the search text in sync when the value changes externally (e.g. a
  // re-extraction resets the row) — previously the stale search persisted
  // and filtered out the newly selected unit (ISSUES.md #75).
  const [prevValue, setPrevValue] = useState(value)
  if (prevValue !== value) {
    setPrevValue(value)
    setSearch(value)
  }

  // Display-only localization: the 'Qualitative' sentinel (compared verbatim
  // by callers) renders localized, and in RU known units render Russian
  // (unknown units pass through). The row's stored/typed value is never
  // rewritten — search and "add new" still operate on the canonical string.
  const displayUnitLabel = (u: string) => {
    if (u === 'Qualitative') return qualitativeUnitLabel(locale)
    return locale === 'ru' ? unitLabelRu(u) : u
  }

  const units = [...new Set([...ALWAYS_SHOWN, ...definitions.map((d) => d.unit).filter(Boolean)])]

  const filtered = units.filter((u) =>
    u.toLowerCase().includes(search.toLowerCase()),
  )

  const showAddNew =
    search.trim().length > 0 &&
    !units.some((u) => u.toLowerCase() === search.trim().toLowerCase())

  const handleSelect = useCallback(
    (unit: string) => {
      onChange(unit)
      setSearch(unit)
      setOpen(false)
    },
    [onChange],
  )

  const handleAddNew = useCallback(() => {
    onChange(search.trim())
    setSearch(search.trim())
    setOpen(false)
  }, [search, onChange])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'h-8 w-full justify-between px-3 text-sm font-normal',
            !value && 'text-muted-foreground',
          )}
        >
          {value ? displayUnitLabel(value) : resolvedPlaceholder}
          <ChevronsUpDown className="ml-2 size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={resolvedPlaceholder}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loading && (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {t('loading')}
              </div>
            )}
            {!loading && filtered.length === 0 && !showAddNew && (
              <CommandEmpty>{t('notFound')}</CommandEmpty>
            )}
            {filtered.length > 0 && (
              <CommandGroup heading={t('standardGroup')}>
                {filtered.map((unit) => (
                  <CommandItem
                    key={unit}
                    value={unit}
                    onSelect={() => handleSelect(unit)}
                  >
                    <Check
                      className={cn(
                        'mr-2 size-3',
                        value === unit ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="flex-1 truncate">{displayUnitLabel(unit)}</span>
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
                {t('addNew', { name: search.trim() })}
              </CommandItem>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
