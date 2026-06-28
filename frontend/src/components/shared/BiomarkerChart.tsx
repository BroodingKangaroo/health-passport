'use client'

import dynamic from 'next/dynamic'

import type { BiomarkerResult, Reading } from '@/lib/types'

const ChartInner = dynamic(
  () => import('./BiomarkerChartInner'),
  { ssr: false },
)

interface BiomarkerChartProps {
  biomarker: BiomarkerResult
  data?: Reading[]
  height?: number
  compact?: boolean
}

export function BiomarkerChart(props: BiomarkerChartProps) {
  return <ChartInner {...props} />
}
