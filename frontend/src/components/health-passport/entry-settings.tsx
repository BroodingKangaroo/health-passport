'use client'

import { useMemo, useState } from 'react'
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

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
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
    switch (event.type) {
      case 'blood_test':
        return 'Blood Test'
      case 'doctor_visit':
        return 'Doctor Visit'
      case 'imaging':
        return 'Imaging'
      case 'procedure':
        return 'Procedure'
      default:
        return 'Entry'
    }
  }, [event.type])

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
      const msg = e instanceof Error ? e.message : 'Failed to delete entry'
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
            Entry Details
          </h3>
        </div>

        <div className="divide-y divide-border/60">
          <StatRow
            icon={FileText}
            label="Type"
            value={typeLabel}
            hint={event.clinic || undefined}
          />
          <StatRow
            icon={Calendar}
            label="Date"
            value={formatDate(event.date)}
            hint={
              ageDays === 0
                ? 'Today'
                : ageDays === 1
                  ? '1 day ago'
                  : `${ageDays} days ago`
            }
          />
          <StatRow
            icon={HardDrive}
            label="Documents"
            value={
              attachmentCount === 0
                ? 'None'
                : `${attachmentCount} (${formatBytes(totalSizeBytes)})`
            }
          />
          <StatRow
            icon={FlaskConical}
            label="Biomarkers"
            value={(biomarkers?.length ?? 0).toString()}
            hint={
              biomarkers && biomarkers.length > 0
                ? `${biomarkerCounts.normal} normal · ${biomarkerCounts.low} low · ${biomarkerCounts.high} high · ${biomarkerCounts.abnormal} abnormal`
                : undefined
            }
          />
          {visitCounts && (
            <>
              <StatRow
                icon={ClipboardList}
                label="Clinical Notes"
                value={visitCounts.notes.toString()}
              />
              <StatRow
                icon={Pill}
                label="Prescriptions"
                value={visitCounts.prescriptions.toString()}
              />
              <StatRow
                icon={CheckCircle}
                label="Recommendations"
                value={visitCounts.recommendations.toString()}
              />
            </>
          )}
        </div>
      </div>

      <Card className="p-6">
        <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          Technical
        </h3>
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background p-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Entry ID</p>
            <p className="truncate font-mono text-xs text-foreground">{event.id}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            aria-label="Copy entry ID"
          >
            <Copy className="size-3.5" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </Card>

      <div className="rounded-xl border border-status-high/30 bg-status-high/5 p-6">
        <div className="mb-2 flex items-center gap-2">
          <AlertTriangle className="size-4 text-status-high" />
          <h3 className="text-sm font-semibold text-status-high">Danger Zone</h3>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Permanently delete this entry and all of its data, including biomarkers,
          visit notes, and uploaded documents. This action cannot be undone.
        </p>
        <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
          <PopoverTrigger asChild>
            <Button variant="destructive" disabled={deleting}>
              <Trash2 className="size-4" />
              Delete this entry
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
                  Delete {typeLabel.toLowerCase()}?
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {event.title}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                This will remove all biomarkers, visit data, and attachments
                associated with this entry. The file storage quota will be
                adjusted accordingly.
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
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting}
                  data-testid="delete-confirm-button"
                >
                  {deleting ? 'Deleting…' : 'Delete'}
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
