'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'

import { useLeaveGuard } from '@/providers/leave-guard-provider'
import { extractMedicalData, UsageLimitError } from '@/services/api'
import { estimateExtractionTime, estimateMatchingTime } from '@/lib/extraction-timing'
import type { UploadState, ProgressStage, StandardizedMedicalRecord } from '@/lib/types'

interface UseExtractionOptions {
  // Applied to the form state while the "Done! Reviewing results..." stage is
  // still showing; the editor itself only appears once the hook flips to it.
  onSuccess: (record: StandardizedMedicalRecord) => void
  onFailure: () => void
}

export function useExtraction({ onSuccess, onFailure }: UseExtractionOptions) {
  const t = useTranslations('extraction')
  const [uploadState, setUploadState] = useState<UploadState>('idle')
  const [progressStage, setProgressStage] = useState<ProgressStage>('ocr_scanning')
  const [markdownChars, setMarkdownChars] = useState<number | null>(null)
  const [biomarkerCount, setBiomarkerCount] = useState<number | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [aiError, setAiError] = useState<string | null>(null)
  // Stage progress bookkeeping kept as state (not refs) so the render can
  // read it to draw the progress bar — React 19 forbids ref reads during render.
  const [stageStart, setStageStart] = useState(0)
  const [stageEstimate, setStageEstimate] = useState(0)

  const elapsedRef = useRef(0)
  const extractionStartRef = useRef(0)
  const stageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasLeftOcrRef = useRef(false)
  const markdownCharsRef = useRef<number | null>(null)
  const extractionAbortRef = useRef<AbortController | null>(null)

  // Guard against accidental back-navigation while the AI extraction is
  // running: leaving cancels the extraction and nothing gets saved.
  const { arm, disarm } = useLeaveGuard()
  useEffect(() => {
    if (uploadState !== 'scanning') return
    // A confirmed leave must abort the SSE fetch so the browser drops the
    // connection and the backend takes its client-disconnect path (quota
    // refund) — mirroring print-setup's translation abort.
    arm(t('leaveGuard'), () => extractionAbortRef.current?.abort())
    return () => disarm()
  }, [uploadState, arm, disarm, t])

  useEffect(() => {
    if (uploadState !== 'scanning') return
    const interval = setInterval(() => {
      setElapsedSeconds((s) => {
        const n = s + 1
        elapsedRef.current = n
        return n
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [uploadState])

  const runExtraction = useCallback(
    async (file: File) => {
      // Cancel any in-flight extraction so its late-arriving result can't
      // overwrite state the user has since edited.
      extractionAbortRef.current?.abort()
      const controller = new AbortController()
      extractionAbortRef.current = controller

      setAiError(null)
      setUploadState('scanning')
      setProgressStage('ocr_scanning')
      setMarkdownChars(null)
      setBiomarkerCount(null)
      setElapsedSeconds(0)
      setStageStart(0)
      setStageEstimate(0)
      elapsedRef.current = 0
      extractionStartRef.current = performance.now()
      if (stageTimeoutRef.current !== null) clearTimeout(stageTimeoutRef.current)
      stageTimeoutRef.current = null
      hasLeftOcrRef.current = false
      markdownCharsRef.current = null
      const setStage = (stage: string) => {
        setProgressStage(stage as ProgressStage)
      }

      try {
        const result = await extractMedicalData(
          file,
          (payload) => {
            const now = elapsedRef.current
            if (payload.markdown_chars != null) {
              markdownCharsRef.current = payload.markdown_chars
              setMarkdownChars(payload.markdown_chars)
              setStageStart(now)
              // Preferred: the backend's measured estimate (median of recent
              // runs). The local heuristic only covers an older backend that
              // doesn't send estimate_s yet.
              const estExt = payload.estimate_s ?? estimateExtractionTime(payload.markdown_chars)
              const estBm = Math.round(payload.markdown_chars * 0.007)
              const estMatch = estimateMatchingTime(estBm)
              setStageEstimate(Math.round(payload.estimate_s != null ? estExt : estExt + estMatch))
            }
            if (payload.biomarker_count != null) {
              setBiomarkerCount(payload.biomarker_count)
              setStageStart(now)
              setStageEstimate(
                Math.round(payload.estimate_s ?? estimateMatchingTime(payload.biomarker_count))
              )
            }
            if (stageTimeoutRef.current !== null) clearTimeout(stageTimeoutRef.current)
            stageTimeoutRef.current = null
            if (!hasLeftOcrRef.current && payload.stage !== 'ocr_scanning') {
              hasLeftOcrRef.current = true
              const took = performance.now() - extractionStartRef.current
              if (took < 1200) {
                stageTimeoutRef.current = setTimeout(() => setStage(payload.stage), 1200 - took)
                return
              }
            }
            setStage(payload.stage)
          },
          controller.signal,
        )
        onSuccess(result)
        setProgressStage('completed')
        await new Promise((r) => setTimeout(r, 1500))
        setUploadState('editor')
      } catch (err: unknown) {
        // Ignore aborts from a superseding extraction — the new run is in charge.
        if (err instanceof Error && err.name === 'AbortError') return
        if (err instanceof UsageLimitError) {
          toast.error(t('limitTitle'), {
            description: err.message,
          })
        }
        const msg =
          typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : t('failed')
        setAiError(msg)
        onFailure()
        setUploadState('editor')
      }
    },
    [onSuccess, onFailure, t],
  )

  const clearError = useCallback(() => setAiError(null), [])

  return {
    uploadState,
    setUploadState,
    progressStage,
    markdownChars,
    biomarkerCount,
    elapsedSeconds,
    stageStart,
    stageEstimate,
    aiError,
    clearError,
    runExtraction,
  }
}
