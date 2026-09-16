import { Suspense } from 'react'
import { PrintEditorView } from '@/views/PrintEditorView'

export default function Page() {
  return (
    <Suspense fallback={<div className="p-5 text-sm text-muted-foreground">Loading...</div>}>
      <PrintEditorView />
    </Suspense>
  )
}
