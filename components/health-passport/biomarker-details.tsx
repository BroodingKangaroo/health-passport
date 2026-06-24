'use client'

import { ArrowDown, Sparkles, BookOpen } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { BiomarkerChart } from './biomarker-chart'
import {
  biomarkers,
  ferritinTrend,
  ferritinLog,
  type Status,
} from './data'

const ferritin = biomarkers.find((b) => b.id === 'ferritin')!

const deltaTone = (delta: string) => {
  if (delta.startsWith('-')) return 'text-status-low'
  if (delta.startsWith('+')) return 'text-status-normal'
  return 'text-muted-foreground'
}

const logStatus = (value: number): Status =>
  value < ferritin.rangeMin
    ? 'low'
    : value > ferritin.rangeMax
      ? 'high'
      : 'normal'

const statusText: Record<Status, string> = {
  normal: 'text-status-normal',
  low: 'text-status-low',
  high: 'text-status-high',
}

export function BiomarkerDetails() {
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {/* Page header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="leading-tight">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Ferritin <span className="text-muted-foreground/70">/ Ферритин</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Iron storage protein • Measured in ng/mL
          </p>
        </div>
        <div className="rounded-lg border border-status-low/30 bg-status-low-bg px-4 py-2 text-right">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-status-low">
            Current
          </p>
          <p className="text-lg font-bold text-status-low">
            22 ng/mL <span className="text-sm font-semibold">(Low)</span>
          </p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        {/* LEFT column */}
        <div className="space-y-5">
          {/* All-Time Dynamics */}
          <Card className="border-border p-4">
            <h2 className="text-sm font-semibold text-foreground">
              All-Time Dynamics
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              3-year trend · reference band 30 – 400 ng/mL
            </p>
            <BiomarkerChart biomarker={ferritin} data={ferritinTrend} height={350} />
          </Card>

          {/* Historical Log */}
          <Card className="overflow-hidden border-border">
            <div className="border-b border-border p-4">
              <h2 className="text-sm font-semibold text-foreground">
                Historical Log
              </h2>
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-[560px]">
                <div className="grid grid-cols-[1.2fr_0.8fr_1fr_1.2fr_1.2fr] gap-x-3 border-b border-border bg-muted/40 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>Date</span>
                  <span>Value</span>
                  <span>Reference</span>
                  <span>Lab / Source</span>
                  <span>Delta</span>
                </div>
                {ferritinLog.map((entry) => (
                  <div
                    key={entry.date}
                    className="grid grid-cols-[1.2fr_0.8fr_1fr_1.2fr_1.2fr] items-center gap-x-3 border-b border-border px-4 py-3 text-sm transition-colors last:border-0 hover:bg-muted/40"
                  >
                    <span className="text-muted-foreground">{entry.date}</span>
                    <span
                      className={cn(
                        'font-semibold tabular-nums',
                        statusText[logStatus(entry.value)],
                      )}
                    >
                      {entry.value}
                    </span>
                    <span className="text-muted-foreground">{entry.reference}</span>
                    <span className="text-foreground">{entry.source}</span>
                    <span className={cn('font-medium', deltaTone(entry.delta))}>
                      {entry.delta}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>

        {/* RIGHT column */}
        <div className="space-y-5">
          {/* About */}
          <Card className="border-border p-4">
            <div className="mb-2 flex items-center gap-2">
              <BookOpen className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">
                About this Biomarker
              </h2>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Ferritin is a blood protein that contains iron. Low levels indicate
              iron deficiency, often before anemia develops, and may cause fatigue,
              weakness, and reduced concentration.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground/70">
              Ферритин — белок крови, содержащий железо. Низкий уровень указывает на
              дефицит железа, нередко ещё до развития анемии.
            </p>
          </Card>

          {/* AI Insights */}
          <Card className="border-primary/20 bg-accent p-4">
            <div className="mb-3 flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <h2 className="text-sm font-semibold text-accent-foreground">
                Clinical Notes & AI Insights
              </h2>
            </div>
            <ul className="space-y-3 text-sm text-accent-foreground">
              <li className="flex gap-2">
                <ArrowDown className="mt-0.5 size-4 shrink-0 text-status-low" />
                <span>Ferritin levels dropped by 30% since August.</span>
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                <span>
                  Correlates with recent fatigue reported in Cardiologist visit.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                <span>
                  <span className="font-semibold">Action recommended:</span>{' '}
                  Discuss IV Iron infusion or oral supplements with your physician.
                </span>
              </li>
            </ul>
            <div className="mt-4">
              <Badge variant="low">Requires follow-up</Badge>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
