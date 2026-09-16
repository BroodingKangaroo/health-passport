import { Suspense } from 'react'
import { ReviewImport } from '@/components/health-passport/review-import'

export default function ReviewImportPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* useSearchParams requires a Suspense boundary for static rendering. */}
      <Suspense>
        <ReviewImport />
      </Suspense>
    </div>
  )
}
