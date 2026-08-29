'use client'

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  Settings,
  Trash2,
  FileText,
  Calendar,
  Pill,
  ClipboardList,
  FlaskConical,
  CheckCircle,
  AlertTriangle,
  Copy,
  HardDrive,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDate } from '@/lib/utils'
import { deleteEntry } from '@/services/api'
import type {
  BiomarkerResult,
  MedicalEvent,
  Status,
  VisitData,
} from '@/lib/types'

interface EntrySettingsProps {
  event: MedicalEvent
  biomarkers?: BiomarkerResult[]
  visit?: VisitData | null
  onDeleted: () => void
}

// Data values → message keys; unknown values fall back to the raw value.
const TYPE_LABEL_KEYS: Record<string, string> = {
  blood_test: 'typeBloodTest',
  doctor_visit: 'typeDoctorVisit',
  instrumental_test: 'typeInstrumentalTest',
  procedure: 'typeProcedure',
}

function parseSizeToBytes(size: string | undefined): number {
  if (!size) return 0
  const m = /^([\d.]+)\s*(B|KB|MB|GB)?$/i.exec(size.trim())
  if (!m) return 0
  const value = parseFloat(m[1])
  const unit = (m[2] || 'B').toUpperCase()
  if (unit === 'KB') return value * 1024
  if (unit === 'MB') return value * 1024 * 1024
  if (unit === 'GB') return value * 1024 * 1024 * 1024
  return value
}

const BYTE_UNITS_EN = ['B', 'KB', 'MB', 'GB'] as const
const BYTE_UNITS_RU = ['Б', 'КБ', 'МБ', 'ГБ'] as const

function formatBytes(bytes: number, locale: string): string {
  const units = locale.toLowerCase().startsWith('ru') ? BYTE_UNITS_RU : BYTE_UNITS_EN
  if (bytes <= 0) return `0 ${units[0]}`
  if (bytes < 1024) return `${bytes} ${units[0]}`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${units[1]}`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} ${units[2]}`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ${units[3]}`
}

function daysSince(iso: string): number {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return 0
  const ms = Date.now() - d.getTime()
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)))
}

function StatRow({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string | number
  hint?: string
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="size-4" />
        <span>{label}</span>
      </div>
      <div className="min-w-0 text-right">
        <div className="text-sm font-semibold text-foreground">{value}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
    </div>
  )
}

export function EntrySettings({
  event,
  biomarkers,
  visit,
  onDeleted,
}: EntrySettingsProps) {
  const t = useTranslations('timeline.entrySettings')
  const tc = useTranslations('common')
  const locale = useLocale()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const attachments = useMemo(() => event.attachments ?? [], [event.attachments])
  const attachmentCount = attachments.length
  const totalSizeBytes = useMemo(
    () => attachments.reduce((sum, a) => sum + parseSizeToBytes(a.size), 0),
    [attachments],
  )
  const ageDays = daysSince(event.date)

  const biomarkerCounts = useMemo(() => {
    const counts: Record<Status, number> = {
      normal: 0,
      low: 0,
      high: 0,
      abnormal: 0,
    }
    for (const b of biomarkers ?? []) {
      counts[b.status] += 1
    }
    return counts
  }, [biomarkers])

  const visitCounts = useMemo(() => {
    if (!visit) return null
    return {
      notes: visit.notes.length,
      prescriptions: visit.prescriptions.length,
      recommendations: visit.recommendations.length,
    }
  }, [visit])

  const typeLabel = useMemo(() => {
    const key = TYPE_LABEL_KEYS[event.type]
    return key ? t(key) : event.type
  }, [event.type, t])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(event.id)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard may be blocked in some contexts; ignore */
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    setError(null)
    try {
      await deleteEntry(event.id)
      setConfirmOpen(false)
      onDeleted()
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('deleteFailed')
      setError(msg)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex-1 space-y-6 overflow-y-auto">
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-4 flex items-center gap-2">
          <Settings className="size-4 text-muted-foreground" />
          <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            {t('entryDetails')}
          </h3>
        </div>

        <div className="divide-y divide-border/60">
          <StatRow
            icon={FileText}
            label={t('type')}
            value={typeLabel}
            hint={event.clinic || undefined}
          />
          <StatRow
            icon={Calendar}
            label={t('date')}
            value={formatDate(event.date, locale)}
            hint={
              ageDays === 0
                ? t('today')
                : t('daysAgo', { count: ageDays })
            }
          />
          <StatRow
            icon={HardDrive}
            label={t('documents')}
            value={
              attachmentCount === 0
                ? t('none')
                : t('documentsValue', {
                    count: attachmentCount,
                    size: formatBytes(totalSizeBytes, locale),
                  })
            }
          />
          {/* Blood tests are the only entry type that can carry biomarker
              readings — visits and instrumental tests always have zero. */}
          {event.type === 'blood_test' && (
            <StatRow
              icon={FlaskConical}
              label={t('biomarkers')}
              value={(biomarkers?.length ?? 0).toString()}
              hint={
                biomarkers && biomarkers.length > 0
                  ? t('statusBreakdown', {
                      normal: biomarkerCounts.normal,
                      low: biomarkerCounts.low,
                      high: biomarkerCounts.high,
                      abnormal: biomarkerCounts.abnormal,
                    })
                  : undefined
              }
            />
          )}
          {visitCounts && (
            <>
              <StatRow
                icon={ClipboardList}
                label={t('clinicalNotes')}
                value={visitCounts.notes.toString()}
              />
              <StatRow
                icon={Pill}
                label={t('prescriptions')}
                value={visitCounts.prescriptions.toString()}
              />
              <StatRow
                icon={CheckCircle}
                label={t('recommendations')}
                value={visitCounts.recommendations.toString()}
              />
            </>
          )}
        </div>
      </div>

      <Card className="p-6">
        <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {t('technical')}
        </h3>
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background p-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{t('entryId')}</p>
            <p className="truncate font-mono text-xs text-foreground">{event.id}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            aria-label={t('copyIdAria')}
          >
            <Copy className="size-3.5" />
            {copied ? t('copied') : t('copy')}
          </Button>
        </div>
      </Card>

      <div className="rounded-xl border border-status-high/30 bg-status-high/5 p-6">
        <div className="mb-2 flex items-center gap-2">
          <AlertTriangle className="size-4 text-status-high" />
          <h3 className="text-sm font-semibold text-status-high">{t('dangerZone')}</h3>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          {t('dangerWarning')}
        </p>
        <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
          <PopoverTrigger asChild>
            <Button variant="destructive" disabled={deleting}>
              <Trash2 className="size-4" />
              {t('deleteEntry')}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side="top"
            className="w-80"
            data-testid="delete-confirm"
          >
            <div className="space-y-3">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {t('deleteConfirmTitle', { type: typeLabel.toLowerCase() })}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {event.title}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('deleteConfirmBody')}
              </p>
              {error && (
                <p className="rounded-md border border-status-high/30 bg-status-high/10 px-2 py-1 text-xs text-status-high">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmOpen(false)}
                  disabled={deleting}
                >
                  {tc('cancel')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting}
                  data-testid="delete-confirm-button"
                >
                  {deleting ? t('deleting') : tc('delete')}
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
