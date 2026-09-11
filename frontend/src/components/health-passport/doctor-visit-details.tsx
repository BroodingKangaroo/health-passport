'use client'

import { useState, Fragment } from 'react'
import { useTranslations } from 'next-intl'
import {
  Stethoscope,
  Building,
  Activity,
  CheckCircle,
  FileText,
  Pill,
  Paperclip,
  Languages,
  Settings,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { TYPE_VISUALS } from '@/lib/event-visuals'
import { EntrySettings } from './entry-settings'
import { DocumentTab } from './document-tab'
import type { VisitData } from '@/lib/types'

export function DoctorVisitDetails({ visit, entryId, onDeleted }: { visit: VisitData; entryId: string; onDeleted?: () => void }) {
  const t = useTranslations('timeline.doctorVisit')
  const te = useTranslations('timeline.entrySettings')
  const TypeIcon = TYPE_VISUALS.doctor_visit.icon
  const [activeTab, setActiveTab] = useState<'summary' | 'document' | 'settings'>('summary')
  const [showOriginal, setShowOriginal] = useState(false)

  const verdictText = showOriginal ? visit.verdict.original : visit.verdict.translated_en
  const verdictLabel = showOriginal ? t('original') : t('translated')

  const eventForSettings = {
    id: entryId,
    date: visit.date,
    type: 'doctor_visit' as const,
    title: visit.specialty,
    clinic: visit.clinic,
    attachments: visit.attachments,
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-background print:block print:h-auto">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
              TYPE_VISUALS.doctor_visit.chipClass,
            )}
          >
            <TypeIcon className="size-3.5" />
            {te('typeDoctorVisit')}
          </span>
          <span aria-hidden className="text-sm text-muted-foreground/20">|</span>
          <button
            onClick={() => setActiveTab('summary')}
            className={
              activeTab === 'summary'
                ? 'inline-flex items-center gap-1.5 text-sm font-semibold text-foreground'
                : 'inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground'
            }
          >
            <FileText className="size-4" />
            {showOriginal ? t('originalSummary') : t('translatedSummary')}
          </button>
          <span className="text-sm text-muted-foreground/20">|</span>
          <button
            onClick={() => setActiveTab('document')}
            className={
              activeTab === 'document'
                ? 'inline-flex items-center gap-1.5 text-sm font-semibold text-foreground'
                : 'inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground'
            }
          >
            <Paperclip className="size-4" />
            {t('originalDocument', { count: visit.attachments.length })}
          </button>
          <span className="text-sm text-muted-foreground/20">|</span>
          <button
            onClick={() => setActiveTab('settings')}
            className={
              activeTab === 'settings'
                ? 'inline-flex items-center gap-1.5 text-sm font-semibold text-foreground'
                : 'inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground'
            }
          >
            <Settings className="size-4" />
            {t('settings')}
          </button>
        </div>

        {activeTab === 'summary' && (
          <button
            onClick={() => setShowOriginal(!showOriginal)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
              showOriginal
                ? 'border-blue-500/30 bg-blue-500/10 text-blue-600'
                : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted',
            )}
          >
            <Languages className="size-3.5" />
            {showOriginal ? t('showingOriginal') : t('viewOriginalLanguage')}
          </button>
        )}
      </div>

      {activeTab === 'summary' ? (
        <div className="scrollbar-none mt-5 flex-1 space-y-6 overflow-y-auto">
          <div className="flex items-center gap-4 border-b border-border/40 pb-3 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Stethoscope className="size-4" />
              {visit.provider}
            </span>
            <span className="flex items-center gap-1.5">
              <Building className="size-4" />
              {visit.clinic}
            </span>
          </div>

          <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-6">
            <div className="mb-1 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="size-4 text-blue-500" />
                <span className="text-xs font-semibold uppercase tracking-wide text-blue-500">
                  {t('primaryDiagnosis')}
                </span>
              </div>
              <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                {verdictLabel}
              </span>
            </div>
            {verdictText ? (
              <p className="text-sm leading-relaxed text-foreground">
                {verdictText}
              </p>
            ) : (
              <p className="text-sm italic text-muted-foreground/50">
                {t('noDiagnosis')}
              </p>
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                {t('clinicalNotes')}
              </h3>
              <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                {verdictLabel}
              </span>
            </div>
            <div className="space-y-6">
            {visit.notes.length > 0 ? visit.notes.map((note, i) => (
              <Fragment key={i}>
                <div>
                  {note.heading && (
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-foreground">
                        {note.heading}
                      </h3>
                      <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                        {verdictLabel}
                      </span>
                    </div>
                  )}
                  {(() => {
                    const noteText = showOriginal ? note.text_original : note.text_translated
                    return noteText ? (
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        {noteText}
                      </p>
                    ) : (
                      <p className="mt-1 text-sm italic text-muted-foreground/50">
                        {t('noSectionRecorded', {
                          section: note.heading?.toLowerCase() || 'information',
                        })}
                      </p>
                    )
                  })()}
                </div>
                {i === 1 && <div className="h-px bg-border/50" />}
              </Fragment>
            )) : (
              <p className="text-sm italic text-muted-foreground/50">
                {t('noClinicalNotes')}
              </p>
            )}
            </div>
          </div>

          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                {t('prescriptions')}
              </h3>
              <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                {verdictLabel}
              </span>
            </div>
            {visit.prescriptions.length > 0 ? visit.prescriptions.map((p) => (
              <div
                key={p.id}
                className="mb-2 flex items-start gap-3 rounded-xl border border-border/50 bg-background p-3 transition-all hover:bg-background/80 cursor-pointer"
              >
                <Pill className="mt-0.5 size-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium text-foreground">
                      {showOriginal ? p.name.original : p.name.translated_en}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {showOriginal ? p.dose.original : p.dose.translated_en}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {showOriginal ? p.instruction.original : p.instruction.translated_en}
                  </p>
                </div>
              </div>
            )) : (
              <p className="text-sm italic text-muted-foreground/50">
                {t('noPrescriptions')}
              </p>
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                {t('recommendations')}
              </h3>
              <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                {verdictLabel}
              </span>
            </div>
            {visit.recommendations.length > 0 ? (
              <ul className="space-y-2">
                {visit.recommendations.map((rec, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <CheckCircle className="mt-0.5 size-4 shrink-0 text-green-500" />
                    <span className="text-sm text-muted-foreground">
                      {showOriginal ? rec.original : rec.translated_en}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm italic text-muted-foreground/50">
                {t('noRecommendations')}
              </p>
            )}
          </div>
        </div>
      ) : activeTab === 'document' ? (
        <div className="mt-5 flex w-full min-w-0 flex-1 flex-col min-h-0">
          <DocumentTab attachments={visit.attachments} />
        </div>
      ) : (
        <div className="scrollbar-none mt-5 min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <EntrySettings
            event={eventForSettings}
            visit={visit}
            onDeleted={onDeleted ?? (() => {})}
          />
        </div>
      )}
    </div>
  )
}