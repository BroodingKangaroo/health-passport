'use client'

import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'

/** Sub-page nav strip under the HeaderBar: one ghost back button on a
 * card-colored bar (the shared pattern of the imports, review, settings and
 * add-entry pages). */
export function BackNav({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <nav className="border-b border-border bg-card px-5 print:hidden" aria-label={label}>
      <div className="flex items-center py-2">
        <Button
          variant="ghost"
          onClick={onBack}
          className="gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {label}
        </Button>
      </div>
    </nav>
  )
}
