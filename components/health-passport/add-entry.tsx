'use client'

import { useEffect, useState } from 'react'
import {
  UploadCloud,
  Loader2,
  Sparkles,
  ZoomIn,
  FileText,
  Plus,
  X,
  Pencil,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

type UploadState = 'idle' | 'scanning' | 'editor'
type EntryMode = 'ai' | 'manual'

const docPills = [
  { emoji: '📄', label: 'Lab Results' },
  { emoji: '📝', label: 'Doctor Notes' },
  { emoji: '🩻', label: 'MRI / Scans' },
]

const mockFiles = ['Page_1.jpg', 'Page_2.jpg', 'Page_3.jpg']

interface BiomarkerRow {
  id: string
  name: string
  value: string
  unit: string
  range: string
}

interface Category {
  id: string
  name: string
  rows: BiomarkerRow[]
}

function newRow(): BiomarkerRow {
  return {
    id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    value: '',
    unit: '',
    range: '',
  }
}

const aiCategories: Category[] = [
  {
    id: 'cbc',
    name: 'Complete Blood Count',
    rows: [
      { id: 'hemoglobin', name: 'Hemoglobin', value: '142', unit: 'g/L', range: '130-170' },
      { id: 'ferritin', name: 'Ferritin', value: '22', unit: 'ng/mL', range: '30-400' },
    ],
  },
]

function manualCategories(): Category[] {
  return [{ id: 'cat-1', name: 'General', rows: [newRow()] }]
}

/** returns true when value is parseable and falls outside an `a-b` range */
function isOutOfRange(value: string, range: string) {
  const v = Number.parseFloat(value)
  const m = range.match(/(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/)
  if (Number.isNaN(v) || !m) return false
  const lo = Number.parseFloat(m[1])
  const hi = Number.parseFloat(m[2])
  return v < lo || v > hi
}

export function AddEntry({ onSave }: { onSave: () => void }) {
  const [uploadState, setUploadState] = useState<UploadState>('idle')
  const [entryMode, setEntryMode] = useState<EntryMode>('ai')
  const [categories, setCategories] = useState<Category[]>(aiCategories)
  const [activeFile, setActiveFile] = useState(0)

  useEffect(() => {
    if (uploadState !== 'scanning') return
    const t = setTimeout(() => {
      setEntryMode('ai')
      setCategories(aiCategories)
      setUploadState('editor')
    }, 2000)
    return () => clearTimeout(t)
  }, [uploadState])

  function startManual() {
    setEntryMode('manual')
    setCategories(manualCategories())
    setUploadState('editor')
  }

  function updateRow(catId: string, rowId: string, key: keyof BiomarkerRow, val: string) {
    setCategories((prev) =>
      prev.map((c) =>
        c.id === catId
          ? { ...c, rows: c.rows.map((r) => (r.id === rowId ? { ...r, [key]: val } : r)) }
          : c,
      ),
    )
  }

  function removeRow(catId: string, rowId: string) {
    setCategories((prev) =>
      prev.map((c) =>
        c.id === catId ? { ...c, rows: c.rows.filter((r) => r.id !== rowId) } : c,
      ),
    )
  }

  function addRow(catId: string) {
    setCategories((prev) =>
      prev.map((c) => (c.id === catId ? { ...c, rows: [...c.rows, newRow()] } : c)),
    )
  }

  function addCategory() {
    setCategories((prev) => [
      ...prev,
      { id: `cat-${Date.now()}`, name: 'New Group', rows: [newRow()] },
    ])
  }

  function updateCategoryName(catId: string, name: string) {
    setCategories((prev) => prev.map((c) => (c.id === catId ? { ...c, name } : c)))
  }

  /* ---------- IDLE + SCANNING ---------- */
  if (uploadState === 'idle' || uploadState === 'scanning') {
    return (
      <div className="mx-auto max-w-3xl py-4">
        <div className="mb-6 text-center">
          <h1 className="text-balance text-2xl font-bold text-foreground">
            Add New Medical Record
          </h1>
          <p className="mx-auto mt-2 max-w-xl text-pretty text-sm text-muted-foreground">
            Upload lab results, doctor notes, or imaging reports. Our AI will
            automatically extract and categorize the data.
          </p>
        </div>

        <button
          type="button"
          onClick={() => uploadState === 'idle' && setUploadState('scanning')}
          disabled={uploadState === 'scanning'}
          className={cn(
            'w-full rounded-xl border-2 border-dashed border-primary/30 bg-accent/40 p-12 text-center transition',
            uploadState === 'idle' && 'cursor-pointer hover:bg-accent/70',
          )}
        >
          {uploadState === 'idle' ? (
            <div className="flex flex-col items-center gap-4">
              <div className="flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
                <UploadCloud className="size-8" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Drag &amp; drop multiple documents here, or click to browse.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Supports PDF, JPG, PNG
                </p>
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                {docPills.map((p) => (
                  <span
                    key={p.label}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground"
                  >
                    <span aria-hidden>{p.emoji}</span>
                    {p.label}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-2">
              <Loader2 className="size-10 animate-spin text-primary" />
              <p className="text-sm font-semibold text-foreground">
                Scanning documents...
              </p>
              <p className="max-w-sm text-pretty text-xs text-muted-foreground">
                Identifying document type and extracting medical data from all
                pages using AI...
              </p>
            </div>
          )}
        </button>

        {/* Divider */}
        {uploadState === 'idle' && (
          <>
            <div className="relative my-6">
              <div className="border-t border-border" />
              <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 bg-background px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                OR
              </span>
            </div>

            <Button
              variant="outline"
              size="lg"
              onClick={startManual}
              className="w-full gap-2"
            >
              <Pencil className="size-4" />
              Skip Upload &amp; Enter Manually
            </Button>
          </>
        )}
      </div>
    )
  }

  /* ---------- EDITOR ---------- */
  const isManual = entryMode === 'manual'

  return (
    <div className="mx-auto max-w-6xl py-4">
      <div className="grid gap-5 lg:grid-cols-[1fr_1.5fr]">
        {/* LEFT: document viewer */}
        <Card className="flex h-fit flex-col overflow-hidden bg-muted/30">
          {isManual ? (
            <div className="p-4">
              <h2 className="mb-3 text-sm font-semibold text-foreground">
                Attachments (Optional)
              </h2>
              <div className="flex aspect-[3/4] flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border bg-background/60 px-4 text-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <ImagePlus className="size-6" />
                </div>
                <p className="text-xs font-medium text-foreground">
                  Add a photo or scan later
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Drag &amp; drop or click to attach
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-border p-4">
                <h2 className="text-sm font-semibold text-foreground">
                  Attached Documents ({mockFiles.length})
                </h2>
                <button
                  aria-label="Zoom document"
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <ZoomIn className="size-4" />
                </button>
              </div>

              {/* Thumbnail row */}
              <div className="flex gap-2 overflow-x-auto border-b border-border p-3">
                {mockFiles.map((file, i) => (
                  <button
                    key={file}
                    onClick={() => setActiveFile(i)}
                    className={cn(
                      'flex shrink-0 items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-xs font-medium transition-colors',
                      i === activeFile
                        ? 'border-primary text-foreground ring-1 ring-primary'
                        : 'border-border text-muted-foreground hover:border-primary/40',
                    )}
                  >
                    <FileText className="size-3.5" />
                    {file}
                  </button>
                ))}
                <button className="flex shrink-0 items-center gap-1 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">
                  <Plus className="size-3.5" />
                  Add File
                </button>
              </div>

              <div className="p-4">
                <div className="flex aspect-[3/4] flex-col items-center justify-center gap-3 rounded-lg border border-border bg-muted/60 text-center">
                  <FileText className="size-10 text-muted-foreground/60" />
                  <p className="text-xs font-medium text-muted-foreground">
                    📄 {mockFiles[activeFile]}
                  </p>
                </div>

                {/* Pagination */}
                <div className="mt-3 flex items-center justify-between">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={activeFile === 0}
                    onClick={() => setActiveFile((i) => Math.max(0, i - 1))}
                    className="gap-1 text-muted-foreground hover:text-foreground"
                  >
                    <ChevronLeft className="size-4" />
                    Prev
                  </Button>
                  <span className="text-xs font-medium text-muted-foreground">
                    {activeFile + 1} of {mockFiles.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={activeFile === mockFiles.length - 1}
                    onClick={() =>
                      setActiveFile((i) => Math.min(mockFiles.length - 1, i + 1))
                    }
                    className="gap-1 text-muted-foreground hover:text-foreground"
                  >
                    Next
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>

        {/* RIGHT: data form */}
        <Card className="flex flex-col overflow-hidden">
          <div className="p-4">
            {/* AI banner (AI mode only) */}
            {!isManual && (
              <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                <p className="text-xs text-foreground">
                  <span className="font-semibold">AI successfully identified</span>{' '}
                  a Blood Test Panel and extracted 14 biomarkers across 3 pages.
                  Please review for accuracy.
                </p>
              </div>
            )}

            {/* Meta data */}
            <div className={cn('grid gap-3 sm:grid-cols-2', !isManual && 'mt-5')}>
              <Field label="Document Type">
                <select
                  defaultValue={isManual ? 'blood' : 'blood'}
                  className="flex h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                >
                  <option value="blood">Blood Test Panel</option>
                  <option value="notes">Doctor Notes</option>
                  <option value="mri">MRI / Scan</option>
                </select>
              </Field>
              <Field label="Date">
                <Input type="date" defaultValue="2026-10-12" />
              </Field>
              <Field label="Clinic / Source">
                <Input defaultValue={isManual ? '' : 'Invitro Lab'} placeholder="e.g. Invitro Lab" />
              </Field>
              <Field label="Provider / Doctor">
                <Input placeholder="e.g. Dr. Ivanova" />
              </Field>
            </div>

            <div className="mt-3">
              <Field label="Patient Notes &amp; Context">
                <textarea
                  rows={2}
                  placeholder="e.g. Fasted for 12 hours, felt slight fatigue..."
                  className="flex w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                />
              </Field>
            </div>

            {/* Biomarkers */}
            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">
                  Biomarkers
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={addCategory}
                  className="gap-1.5 text-primary hover:text-primary"
                >
                  <Plus className="size-4" />
                  Add Category Group
                </Button>
              </div>

              <div className="flex flex-col gap-4">
                {categories.map((cat) => (
                  <div key={cat.id}>
                    <input
                      value={cat.name}
                      onChange={(e) => updateCategoryName(cat.id, e.target.value)}
                      aria-label="Category name"
                      className="mb-1.5 w-full bg-transparent text-[11px] font-semibold uppercase tracking-wide text-muted-foreground outline-none focus:text-foreground"
                    />
                    <div className="overflow-hidden rounded-lg border border-border">
                      <div className="grid grid-cols-[1.4fr_0.9fr_0.7fr_1fr_36px] items-center gap-x-2 border-b border-border bg-muted/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        <span>Biomarker</span>
                        <span>Value</span>
                        <span>Unit</span>
                        <span>Range</span>
                        <span aria-hidden />
                      </div>

                      {cat.rows.map((row) => {
                        const out = isOutOfRange(row.value, row.range)
                        return (
                          <div
                            key={row.id}
                            className="grid grid-cols-[1.4fr_0.9fr_0.7fr_1fr_36px] items-center gap-x-2 border-b border-border px-3 py-2 last:border-b-0"
                          >
                            <Input
                              value={row.name}
                              placeholder="Name"
                              onChange={(e) =>
                                updateRow(cat.id, row.id, 'name', e.target.value)
                              }
                            />
                            <div className="relative">
                              <Input
                                value={row.value}
                                placeholder="—"
                                className={cn(out && 'pr-6')}
                                onChange={(e) =>
                                  updateRow(cat.id, row.id, 'value', e.target.value)
                                }
                              />
                              {out && (
                                <span
                                  aria-label="Out of range"
                                  title="Out of range"
                                  className="absolute right-2 top-1/2 size-2 -translate-y-1/2 rounded-full bg-status-high"
                                />
                              )}
                            </div>
                            <Input
                              value={row.unit}
                              placeholder="—"
                              onChange={(e) =>
                                updateRow(cat.id, row.id, 'unit', e.target.value)
                              }
                            />
                            <Input
                              value={row.range}
                              placeholder="—"
                              onChange={(e) =>
                                updateRow(cat.id, row.id, 'range', e.target.value)
                              }
                            />
                            <button
                              aria-label={`Remove ${row.name || 'biomarker'}`}
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
                      Add biomarker
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="mt-auto flex items-center justify-end gap-2 border-t border-border p-4">
            <Button variant="ghost" onClick={onSave}>
              Cancel
            </Button>
            <Button onClick={onSave}>Save to HealthPassport</Button>
          </div>
        </Card>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  )
}
