'use client'

import { Plus, X, ChevronDown } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { BiomarkerCombobox } from './biomarker-combobox'
import { ReferenceInput } from './reference-input'
import { UnitCombobox } from './unit-combobox'
import { isOutsideReference, QUALITATIVE_VALUES } from '@/lib/reference'
import { qualitativeLabel } from '@/lib/qualitative-labels'
import type { FormCategory, FormBiomarkerRow, Reference } from '@/lib/types'

export function LabResultForm({
  categories,
  addCategory,
  updateCategoryName,
  updateRow,
  removeRow,
  addRow,
}: {
  categories: FormCategory[]
  addCategory: () => void
  updateCategoryName: (catId: string, name: string) => void
  updateRow: (catId: string, rowId: string, key: keyof FormBiomarkerRow, val: string | Reference | null) => void
  removeRow: (catId: string, rowId: string) => void
  addRow: (catId: string) => void
}) {
  const t = useTranslations('labForm')
  const locale = useLocale()
  // <option value> stays the canonical English enum (what the backend stores
  // and what isOutsideReference compares); only the visible label translates.
  const qualOption = (v: string) => <option key={v} value={v}>{qualitativeLabel(v, locale)}</option>
  return (
    <div className="mt-5">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          {t('title')}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={addCategory}
          className="gap-1.5 text-primary hover:text-primary"
        >
          <Plus className="size-4" />
          {t('addCategory')}
        </Button>
      </div>

      <div className="flex flex-col gap-4">
        {categories.map((cat) => (
          <div key={cat.id}>
            <input
              value={cat.name}
              onChange={(e) => updateCategoryName(cat.id, e.target.value)}
              aria-label={t('categoryName')}
              className="mb-1.5 w-full bg-transparent text-[11px] font-semibold uppercase tracking-wide text-muted-foreground outline-none focus:text-foreground"
            />
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="grid grid-cols-[minmax(220px,3fr)_minmax(150px,1.2fr)_120px_minmax(200px,2fr)_auto] items-center gap-x-2 border-b border-border bg-muted/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span>{t('headerBiomarker')}</span>
                <span>{t('headerValue')}</span>
                <span>{t('headerUnit')}</span>
                <span>{t('headerReference')}</span>
                <span aria-hidden />
              </div>

              {cat.rows.map((row) => {
                const qualitative = row.unit === 'Qualitative' || row.reference?.kind === 'qualitative'
                const out = isOutsideReference(row.value, row.reference)
                return (
                  <div
                    key={row.id}
                    className="grid grid-cols-[minmax(220px,3fr)_minmax(150px,1.2fr)_120px_minmax(200px,2fr)_auto] items-start gap-x-2 border-b border-border px-3 py-2 last:border-b-0"
                  >
                    <BiomarkerCombobox
                      value={row.name}
                      originalName={row.original_name}
                      definitionId={row.definition_id}
                      scope={row.scope}
                      onNameChange={(name) => updateRow(cat.id, row.id, 'name', name)}
                      onUnitChange={(unit) => updateRow(cat.id, row.id, 'unit', unit)}
                      onReferenceChange={(reference) => updateRow(cat.id, row.id, 'reference', reference)}
                      onDefinitionIdChange={(id) => updateRow(cat.id, row.id, 'definition_id', id)}
                      onScopeChange={(s) => updateRow(cat.id, row.id, 'scope', s)}
                    />
                    <div className="relative min-w-0">
                      {qualitative ? (
                        <>
                          <select
                            value={row.value}
                            onChange={(e) => updateRow(cat.id, row.id, 'value', e.target.value)}
                            title={row.value || ''}
                            className={cn(
                              'h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-background pl-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30',
                              out ? 'pr-10' : 'pr-7',
                            )}
                          >
                            <option value="">—</option>
                            {QUALITATIVE_VALUES.map(qualOption)}
                          </select>
                          {out && (
                            <span
                              aria-label={t('outsideReference')}
                              title={t('outsideReference')}
                              className="pointer-events-none absolute right-6 top-1/2 size-2 -translate-y-1/2 rounded-full bg-status-high"
                            />
                          )}
                          <ChevronDown
                            aria-hidden
                            className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                          />
                        </>
                      ) : (
                        <>
                          <Input
                            value={row.value}
                            placeholder="—"
                            className={cn(out && 'pr-7')}
                            onChange={(e) =>
                              updateRow(cat.id, row.id, 'value', e.target.value)
                            }
                          />
                          {out && (
                            <span
                              aria-label={t('outsideReference')}
                              title={t('outsideReference')}
                              className="pointer-events-none absolute right-2 top-1/2 size-2 -translate-y-1/2 rounded-full bg-status-high"
                            />
                          )}
                        </>
                      )}
                    </div>
                    <div
                      className={cn(
                        'relative flex items-center gap-1 rounded-md transition-shadow',
                        row.canonical_unit_inferred
                          ? 'ring-2 ring-blue-400/80 bg-blue-50/60 shadow-[0_0_6px_rgba(96,165,250,0.4)] dark:bg-blue-500/10 dark:shadow-[0_0_6px_rgba(96,165,250,0.25)] group'
                          : '',
                      )}
                    >
                      <UnitCombobox
                        value={row.unit}
                        placeholder="—"
                        onChange={(unit) => {
                          updateRow(cat.id, row.id, 'unit', unit)
                          if (unit === 'Qualitative') {
                            updateRow(cat.id, row.id, 'reference', { kind: 'qualitative', expected: null })
                            updateRow(cat.id, row.id, 'value', '')
                          } else if (row.reference?.kind === 'qualitative') {
                            updateRow(cat.id, row.id, 'reference', null)
                            updateRow(cat.id, row.id, 'value', '')
                          }
                        }}
                      />
                      {row.canonical_unit_inferred && (
                        <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-sm opacity-0 transition-opacity group-hover:opacity-100">
                          {t('unitGuessed')}
                        </span>
                      )}
                    </div>
                    {qualitative ? (
                      <select
                        value={(row.reference as { expected?: string | null } | null)?.expected ?? ''}
                        onChange={(e) => {
                          const v = e.target.value
                          updateRow(cat.id, row.id, 'reference', v ? { kind: 'qualitative', expected: v } : null)
                        }}
                        className="h-8 w-full rounded-lg border border-input bg-background px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                      >
                        <option value="">—</option>
                        {QUALITATIVE_VALUES.map(qualOption)}
                      </select>
                    ) : (
                      <ReferenceInput
                        value={row.reference}
                        onChange={(ref) => updateRow(cat.id, row.id, 'reference', ref)}
                      />
                    )}
                    <button
                      aria-label={t('removeRow', { name: row.name || t('biomarkerFallback') })}
                      onClick={() => removeRow(cat.id, row.id)}
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-status-high-bg hover:text-status-high"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                )
              })}
            </div>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => addRow(cat.id)}
              className="mt-1.5 gap-1.5 text-primary hover:text-primary"
            >
              <Plus className="size-4" />
              {t('addBiomarker')}
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
