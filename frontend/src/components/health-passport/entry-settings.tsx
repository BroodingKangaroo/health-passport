'use client'

import dynamic from 'next/dynamic'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  Settings,
  Calendar,
  FileText,
  Pill,
  ClipboardList,
  FlaskConical,
  CheckCircle,
  Copy,
  HardDrive,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn, formatDate } from '@/lib/utils'
import { TYPE_VISUALS } from '@/lib/event-visuals'
import { useViewer } from '@/providers/viewer-provider'
import type {
  BiomarkerResult,
  MedicalEvent,
  Status,
  VisitData,
} from '@/lib/types'

// The danger zone is the only piece here that reaches the write API and
// react-query, so it is loaded on demand (see entry-delete.tsx). Importing it
// statically would put `services/api` in the shared recipient graph, which the
// import-graph test forbids.
const EntryDelete = dynamic(
  () => import('./entry-delete').then((m) => m.EntryDelete),
  { ssr: false },
)

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

export function formatBytes(bytes: number, locale: string): string {
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
  iconClassName,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string | number
  hint?: string
  // Optional color override for the icon (type channel in the type row).
  iconClassName?: string
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className={cn('size-4', iconClassName)} />
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
  const locale = useLocale()
  // Which kind of viewer is this? The demo fixture has nothing to delete and
  // a share recipient is reading someone else's record, so both hide the
  // owner-only half. That half is the danger zone (a real write) and the
  // entry id (a support/debugging handle, not information about the record).
  const { isOwner, isShared } = useViewer()

  const attachments = useMemo(() => event.attachments ?? [], [event.attachments])
  const attachmentCount = attachments.length
  // Defensive fallback: an unrecognized runtime type must not crash the tab.
  const typeVisual =
    TYPE_VISUALS[event.type as keyof typeof TYPE_VISUALS] ?? null
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
      '': 0,
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

  // A recipient never sees this component's body: the shared full view drops
  // the settings tab entirely. This guard is the second layer for the case
  // where a future surface renders it over someone else's record.
  if (isShared) return null

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-4 flex items-center gap-2">
          <Settings className="size-4 text-muted-foreground" />
          <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            {t('entryDetails')}
          </h3>
        </div>

        <div className="divide-y divide-border/60">
          <StatRow
            icon={typeVisual?.icon ?? FileText}
            iconClassName={typeVisual?.textClass}
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
                  ? biomarkerCounts[''] > 0
                    ? t('statusBreakdownUnknown', {
                        normal: biomarkerCounts.normal,
                        low: biomarkerCounts.low,
                        high: biomarkerCounts.high,
                        abnormal: biomarkerCounts.abnormal,
                        unknown: biomarkerCounts[''],
                      })
                    : t('statusBreakdown', {
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

      {/* The entry id is a support/debugging handle: it belongs to the owner,
          and /demo shows it too — the marketing surface is meant to show the
          product's real affordances, and only the DESTRUCTIVE one is demo-
          gated. A recipient reading someone else's record gets neither. */}
      {!isShared && <EntryTechnicalCard eventId={event.id} />}

      {isOwner && (
        <EntryDelete
          event={event}
          typeLabel={typeLabel}
          onDeleted={onDeleted}
        />
      )}
    </div>
  )
}

/**
 * The owner's copy-the-entry-id card. Holds its own copy state so the
 * component above stays a plain render of records and stats.
 */
function EntryTechnicalCard({ eventId }: { eventId: string }) {
  const t = useTranslations('timeline.entrySettings')
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clean up a pending copy-timer so a late setCopied can't fire after
  // unmount (ISSUES.md #75).
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(eventId)
      setCopied(true)
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard may be blocked in some contexts; ignore */
    }
  }

  return (
    <Card className="p-6">
      <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {t('technical')}
      </h3>
      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background p-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{t('entryId')}</p>
          <p className="truncate font-mono text-xs text-foreground">{eventId}</p>
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
  )
}
