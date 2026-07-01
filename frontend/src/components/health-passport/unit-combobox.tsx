'use client'

import { useState, useCallback } from 'react'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'

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

interface UnitComboboxProps {
  value: string
  onChange: (unit: string) => void
  placeholder?: string
}

export function UnitCombobox({
  value,
  onChange,
  placeholder = 'Search unit…',
}: UnitComboboxProps) {
  const { definitions, loading } = useBiomarkerDefinitions()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState(value)

  const units = [...new Set(definitions.map((d) => d.unit).filter(Boolean))]

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
          {value || placeholder}
          <ChevronsUpDown className="ml-2 size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={placeholder}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loading && (
              <div className="py-6 text-center text-sm text-muted-foreground">
                Loading units…
              </div>
            )}
            {!loading && filtered.length === 0 && !showAddNew && (
              <CommandEmpty>No unit found.</CommandEmpty>
            )}
            {filtered.length > 0 && (
              <CommandGroup heading="Standard units">
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
                    <span className="flex-1 truncate">{unit}</span>
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
  )
}
