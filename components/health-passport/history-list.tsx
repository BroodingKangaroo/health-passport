'use client'

import { Paperclip, SlidersHorizontal } from 'lucide-react'

import { cn } from '@/lib/utils'
import { historyEvents } from './data'

interface HistoryListProps {
  selectedId: string
  onSelect: (id: string) => void
}

export function HistoryList({ selectedId, onSelect }: HistoryListProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold text-foreground">History</h2>
        <button
          aria-label="Filter history"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <SlidersHorizontal className="size-4" />
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {historyEvents.map((event) => {
          const active = event.id === selectedId
          const Icon = event.icon
          return (
            <button
              key={event.id}
              onClick={() => onSelect(event.id)}
              className={cn(
                'flex items-center gap-3 rounded-xl border p-3 text-left transition-all',
                active
                  ? 'border-primary/30 bg-accent shadow-sm'
                  : 'border-border bg-card hover:border-primary/20 hover:bg-accent/40',
              )}
            >
              <div
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-full',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-primary',
                )}
              >
                <Icon className="size-4" />
              </div>
              <div className="min-w-0 leading-tight">
                <p className="truncate text-sm font-semibold text-foreground">
                  {event.title}
                </p>
                <p className="text-xs text-muted-foreground">{event.date}</p>
                <p className="text-xs text-muted-foreground/80">{event.subtext}</p>
                {event.attachments ? (
                  <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    <Paperclip className="size-3" />
                    {event.attachments}{' '}
                    {event.attachments === 1 ? 'Attachment' : 'Attachments'}
                  </span>
                ) : null}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
