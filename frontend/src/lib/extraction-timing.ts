// Wall-clock fallback estimates (seconds) powering the add-entry scan-screen
// progress bar. Only used when the backend doesn't send `estimate_s` in its
// SSE progress events (the backend's own Theil–Sen fit over recent runs is
// preferred — it tracks current provider latency; these constants can't).
// Fitted against recent app.log stage timings, not meant to be exact.

export function estimateExtractionTime(chars: number): number {
  return Math.max(2, 2 + chars * 0.0023)
}

export function estimateMatchingTime(biomarkers: number): number {
  // Matching latency is nearly flat in practice (weak biomarker-count
  // dependence) — a small per-biomarker term covers the largest panels.
  return Math.max(5, 3 + biomarkers * 0.04)
}
