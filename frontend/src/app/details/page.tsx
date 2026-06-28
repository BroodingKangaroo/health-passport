import { Suspense } from 'react'
import { BiomarkerDetailsView } from '@/views/BiomarkerDetailsView'

export default function Page() {
  return (
    <Suspense fallback={<div className="p-5 text-sm text-muted-foreground">Loading...</div>}>
      <BiomarkerDetailsView />
    </Suspense>
  )
}
