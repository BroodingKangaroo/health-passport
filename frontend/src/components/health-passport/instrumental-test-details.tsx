'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Activity,
  Paperclip,
  Settings,
  ScanLine,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { TYPE_VISUALS } from '@/lib/event-visuals'
import { EntrySettings } from './entry-settings'
import { DocumentTab } from './document-tab'
import type { InstrumentalData, MedicalEvent } from '@/lib/types'

export function InstrumentalTestDetails({
  event,
  data,
  onDeleted,
}: {
  event: MedicalEvent
  data: InstrumentalData
  onDeleted?: () => void
}) {
  const t = useTranslations('timeline.instrumentalTest')
  const te = useTranslations('timeline.entrySettings')
  const TypeIcon = TYPE_VISUALS.instrumental_test.icon
  const [activeTab, setActiveTab] = useState<'summary' | 'document' | 'settings'>('summary')

  const eventForSettings = {
    id: event.id,
    date: event.date,
    type: event.type,
    title: event.title,
    clinic: event.clinic,
    attachments: data.attachments,
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-background print:block print:h-auto">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
              TYPE_VISUALS.instrumental_test.chipClass,
            )}
          >
            <TypeIcon className="size-3.5" />
            {te('typeInstrumentalTest')}
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
            <Activity className="size-4" />
            {t('summary')}
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
            {t('originalDocument', { count: data.attachments.length })}
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
      </div>

      {activeTab === 'summary' ? (
        <div className="scrollbar-none mt-5 flex-1 space-y-6 overflow-y-auto">
          {data.modality && (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
                <ScanLine className="size-3.5" />
                {data.modality}
              </span>
            </div>
          )}

          <div className="bg-card border border-border rounded-xl p-6">
            <div className="mb-3">
              <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                {t('findings')}
              </h3>
            </div>
            {data.findings ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {data.findings}
              </p>
            ) : (
              <p className="text-sm italic text-muted-foreground/50">
                {t('noFindings')}
              </p>
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-6">
            <div className="mb-3">
              <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                {t('conclusion')}
              </h3>
            </div>
            {data.conclusion ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                {data.conclusion}
              </p>
            ) : (
              <p className="text-sm italic text-muted-foreground/50">
                {t('noConclusion')}
              </p>
            )}
          </div>
        </div>
      ) : activeTab === 'document' ? (
        <div className="mt-5 flex w-full min-w-0 flex-1 flex-col min-h-0">
          <DocumentTab attachments={data.attachments} />
        </div>
      ) : (
        <div className="scrollbar-none mt-5 min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <EntrySettings
            event={eventForSettings}
            onDeleted={onDeleted ?? (() => {})}
          />
        </div>
      )}
    </div>
  )
}
