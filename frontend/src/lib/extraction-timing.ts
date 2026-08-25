// Wall-clock estimates (seconds) powering the add-entry scan-screen progress
// bar. Pure heuristics calibrated against typical OCR/LLM latencies — not
// meant to be exact, only to keep the wait from feeling stuck.

export function estimateExtractionTime(chars: number): number {
  return Math.max(5, chars * 0.006)
}

export function estimateMatchingTime(biomarkers: number, chars: number): number {
  if (biomarkers > 0) return Math.max(12, biomarkers * 1.2 + 8)
  return Math.max(15, chars * 0.025)
}
