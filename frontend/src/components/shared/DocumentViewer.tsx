'use client'

import { useRef, useLayoutEffect, useEffect, useState, useCallback } from 'react'
import * as pdfjs from 'pdfjs-dist'
import { useTranslations } from 'next-intl'
import { RotateCw } from 'lucide-react'
import { getAccessToken } from '@/lib/auth-token'
import { cn } from '@/lib/utils'

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

// p-4 padding around the image scroll area; subtracted from clientWidth/Height
// when computing the fit size.
const IMAGE_VIEWER_PADDING = 32

function ZoomControls({
  scale,
  onZoom,
  onReset,
  resetTitle,
}: {
  scale: number
  onZoom: (direction: 1 | -1) => void
  onReset: () => void
  resetTitle: string
}) {
  const t = useTranslations('misc.documentViewer')
  return (
    <>
      <button
        onClick={() => onZoom(-1)}
        className="flex size-6 items-center justify-center rounded text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        title={t('zoomOut')}
        aria-label={t('zoomOut')}
      >
        -
      </button>
      <span className="min-w-[36px] text-center text-xs tabular-nums text-muted-foreground">
        {Math.round(scale * 100)}%
      </span>
      <button
        onClick={() => onZoom(1)}
        className="flex size-6 items-center justify-center rounded text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        title={t('zoomIn')}
        aria-label={t('zoomIn')}
      >
        +
      </button>
      <button
        onClick={onReset}
        className="ml-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        title={resetTitle}
      >
        {t('reset')}
      </button>
    </>
  )
}

interface DocumentViewerProps {
  url?: string
  // Timeline detail panes are height-constrained at lg: the viewer fills the
  // pane and scrolls internally. Other callers (add-entry preview) keep the
  // intrinsic sizing.
  fill?: boolean
  // Per-document actions (print/download) rendered in the viewer toolbar so
  // they are visibly scoped to the document on screen; omitted by callers
  // that only preview an unsaved attachment.
  actions?: React.ReactNode
}

export function DocumentViewer({ url, fill = false, actions }: DocumentViewerProps) {
  const t = useTranslations('misc.documentViewer')
  const isImage =
    typeof url === 'string' &&
    /\.(jpg|jpeg|png|gif|webp|tiff|tif|bmp)$/i.test(url)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null)
  // The live pdf.js loading task (owns the document + worker transport):
  // effect cleanup destroys it, so no document survives a url change or
  // unmount and a load cancelled mid-flight still releases its resources.
  const pdfLoadingTaskRef = useRef<pdfjs.PDFDocumentLoadingTask | null>(null)
  const isDragging = useRef(false)
  const dragStartX = useRef(0)
  const dragStartY = useRef(0)
  const dragScrollLeft = useRef(0)
  const dragScrollTop = useRef(0)
  const fitScaleRef = useRef(1)
  const scaleRef = useRef(1)
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null)
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [pageNum, setPageNum] = useState(1)
  const [scale, setScale] = useState(1)
  // Clockwise rotation in 90° steps, applied on top of each PDF page's own
  // rotation (or as a CSS transform for images).
  const [rotation, setRotation] = useState(0)
  const [loading, setLoading] = useState(() => !url)
  const [loadFailed, setLoadFailed] = useState(false)
  const [imgSrc, setImgSrc] = useState<string | null>(null)
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null)
  const [imgViewport, setImgViewport] = useState<{ w: number; h: number } | null>(null)
  const imgUrlRef = useRef<string | undefined>(undefined)

  // Reset the viewer whenever the requested document changes — adjusted during
  // render (React 19's "storing info from previous renders" pattern) so the
  // effect only performs the asynchronous loading work.
  const [prevUrl, setPrevUrl] = useState<string | null>(null)
  const urlKey = url ?? null
  if (prevUrl !== urlKey) {
    setPrevUrl(urlKey)
    setPdf(null)
    setImgSrc(null)
    setImgNatural(null)
    setNumPages(0)
    setPageNum(1)
    setScale(1)
    setRotation(0)
    setLoading(true)
    setLoadFailed(false)
  }

  useEffect(() => {
    if (!url) return
    let cancelled = false
    const token = getAccessToken()
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {}

    if (isImage) {
      fetch(url, { headers })
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to load image: ${res.status}`)
          return res.blob()
        })
        .then((blob) => {
          if (cancelled) return
          const u = URL.createObjectURL(blob)
          imgUrlRef.current = u
          setImgSrc(u)
          setLoading(false)
        })
        .catch(() => {
          if (!cancelled) setLoading(false)
        })
      return () => {
        cancelled = true
        if (imgUrlRef.current) {
          URL.revokeObjectURL(imgUrlRef.current)
          imgUrlRef.current = undefined
        }
      }
    }

    fetch(url, { headers })
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load PDF: ${res.status}`)
        return res.arrayBuffer()
      })
      .then(async (buf) => {
        if (cancelled) return
        const task = pdfjs.getDocument({ data: new Uint8Array(buf) })
        pdfLoadingTaskRef.current = task
        const doc = await task.promise
        // Cleanup already destroyed the loading task (unmount/url change).
        if (cancelled) return
        setPdf(doc)
        setNumPages(doc.numPages)
        setPageNum(1)
        if (scrollRef.current) {
          const page = await doc.getPage(1)
          const { width } = page.getViewport({ scale: 1 })
          const rect = scrollRef.current.getBoundingClientRect()
          fitScaleRef.current = Math.max(0.5, Math.min(3, (rect.width - 32) / width))
          setScale(fitScaleRef.current)
        }
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) {
          // Surface the failure instead of a blank canvas (ISSUES.md #75) —
          // the image path already degrades to 'Preview unavailable'.
          setLoadFailed(true)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
      // Cancel the render and destroy the pdf.js loading task (document +
      // worker/transport); pdf.js otherwise keeps it alive for the page.
      try { renderTaskRef.current?.cancel() } catch {}
      renderTaskRef.current = null
      const task = pdfLoadingTaskRef.current
      pdfLoadingTaskRef.current = null
      if (task) {
        try {
          // destroy() rejects when the worker was already torn down; that is
          // an expected teardown outcome, not an unhandled rejection.
          void task.destroy().catch(() => {})
        } catch {}
      }
    }
  }, [url, isImage])

  const renderPage = useCallback(async () => {
    if (!pdf || !canvasRef.current) return
    try {
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel() } catch {}
        renderTaskRef.current = null
      }
      const page = await pdf.getPage(pageNum)
      const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 })
      const canvas = canvasRef.current
      const ctx = canvas.getContext('2d')!
      canvas.width = viewport.width
      canvas.height = viewport.height
      if (pendingScrollRef.current && scrollRef.current) {
        scrollRef.current.scrollLeft = pendingScrollRef.current.left
        scrollRef.current.scrollTop = pendingScrollRef.current.top
        pendingScrollRef.current = null
      }
      const task = page.render({ canvas, canvasContext: ctx, viewport })
      renderTaskRef.current = task
      await task.promise
      renderTaskRef.current = null
    } catch {}
  }, [pdf, pageNum, scale, rotation])

  useLayoutEffect(() => {
    renderPage()
    return () => {
      try { renderTaskRef.current?.cancel() } catch {}
    }
  }, [renderPage])

  useEffect(() => {
    scaleRef.current = scale
  }, [scale])

  // Track the image scroll area so the picture can be laid out at an explicit
  // pixel size (fit-to-view scaled by the zoom factor) instead of relying on
  // percentage heights inside the flex scroller.
  useEffect(() => {
    if (!imgSrc) return
    const el = scrollRef.current
    if (!el) return
    const measure = () =>
      setImgViewport({
        w: Math.max(0, el.clientWidth - IMAGE_VIEWER_PADDING),
        h: Math.max(0, el.clientHeight - IMAGE_VIEWER_PADDING),
      })
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [imgSrc])

  useEffect(() => {
    if (isImage) return
    const el = scrollRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = el.getBoundingClientRect()
        const cx = e.clientX - rect.left
        const cy = e.clientY - rect.top
        const x = cx + el.scrollLeft
        const y = cy + el.scrollTop
        const factor = e.deltaY > 0 ? 0.98 : 1.02
      const cur = scaleRef.current
      const next = Math.max(0.5, Math.min(3, +(cur * factor).toFixed(2)))
      const ratio = next / cur
      scaleRef.current = next
      pendingScrollRef.current = {
        left: x * ratio - cx,
        top: y * ratio - cy,
      }
      setScale(next)
      return
      }
      if (e.deltaX !== 0) {
        const maxScroll = el.scrollWidth - el.clientWidth
        if (maxScroll <= 0) {
          e.preventDefault()
        } else if (
          (el.scrollLeft <= 0 && e.deltaX < 0) ||
          (el.scrollLeft >= maxScroll && e.deltaX > 0)
        ) {
          e.preventDefault()
        }
      }
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [isImage])

  const zoomAtCenter = useCallback((direction: 1 | -1) => {
    const el = scrollRef.current
    if (!el) return
    const cx = el.clientWidth / 2
    const cy = el.clientHeight / 2
    const x = cx + el.scrollLeft
    const y = cy + el.scrollTop
    setScale((s) => {
      const next = Math.max(0.5, Math.min(3, +(s + direction * 0.05).toFixed(2)))
      if (next === s) return s
      const ratio = next / s
      pendingScrollRef.current = { left: x * ratio - cx, top: y * ratio - cy }
      return next
    })
  }, [])

  const zoomBy = useCallback((direction: 1 | -1) => {
    setScale((s) => Math.max(0.5, Math.min(3, +(s + direction * 0.05).toFixed(2))))
  }, [])

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setImgNatural({ w: img.naturalWidth, h: img.naturalHeight })
    }
  }, [])

  const imgFit =
    imgNatural && imgViewport && imgViewport.w > 0 && imgViewport.h > 0
      ? Math.min(imgViewport.w / imgNatural.w, imgViewport.h / imgNatural.h)
      : null
  const imgDisplayW = imgNatural && imgFit ? Math.round(imgNatural.w * imgFit * scale) : null
  const imgDisplayH = imgNatural && imgFit ? Math.round(imgNatural.h * imgFit * scale) : null

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrollRef.current) return
    e.currentTarget.setPointerCapture(e.pointerId)
    isDragging.current = true
    dragStartX.current = e.clientX
    dragStartY.current = e.clientY
    dragScrollLeft.current = scrollRef.current.scrollLeft
    dragScrollTop.current = scrollRef.current.scrollTop
    scrollRef.current.style.cursor = 'grabbing'
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging.current || !scrollRef.current) return
    e.preventDefault()
    const dx = e.clientX - dragStartX.current
    const dy = e.clientY - dragStartY.current
    scrollRef.current.scrollLeft = dragScrollLeft.current - dx
    scrollRef.current.scrollTop = dragScrollTop.current - dy
  }, [])

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    isDragging.current = false
    if (scrollRef.current) {
      scrollRef.current.style.cursor = 'grab'
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  const rotateButton = (
    <button
      type="button"
      onClick={() => setRotation((r) => (r + 90) % 360)}
      title={t('rotateClockwise')}
      aria-label={t('rotateClockwise')}
      className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      <RotateCw className="size-3.5" />
    </button>
  )

  if (!url) {
    return (
      <div className="flex min-h-[300px] items-center justify-center text-sm text-muted-foreground">
        {t('noUrl')}
      </div>
    )
  }

  if (isImage) {
    return (
      <div
        className={cn(
          'flex h-[80vh] min-h-[300px] min-w-0 flex-col bg-muted/20',
          fill && 'lg:h-full lg:min-h-0',
        )}
      >
        <div className="flex items-center justify-between border-b border-border bg-card px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">
            {t('imagePreview')}
          </span>
          <div className="flex items-center gap-1">
            {rotateButton}
            <div className="ml-1 flex items-center gap-1 border-l border-border pl-2">
              <ZoomControls scale={scale} onZoom={zoomBy} onReset={() => setScale(1)} resetTitle={t('reset')} />
            </div>
            {actions && (
              <div className="ml-1 flex items-center gap-1 border-l border-border pl-2">
                {actions}
              </div>
            )}
          </div>
        </div>
        <div ref={scrollRef} className="scrollbar-none flex flex-1 overflow-auto bg-muted/20 p-4">
          {imgSrc ? (
            <div
              className="m-auto shrink-0"
              style={
                imgDisplayW !== null && imgDisplayH !== null
                  ? { width: imgDisplayW, height: imgDisplayH }
                  : undefined
              }
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imgSrc}
                alt={t('documentPreview')}
                onLoad={handleImageLoad}
                className="h-full w-full object-contain transition-transform"
                style={{ transform: `rotate(${rotation}deg)` }}
              />
            </div>
          ) : (
            <div className="m-auto text-sm text-muted-foreground">
              {loading ? t('loading') : t('previewUnavailable')}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex min-w-0 flex-col bg-muted/20', fill && 'lg:h-full lg:min-h-0')}>
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border bg-card px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPageNum((p) => Math.max(1, p - 1))}
            disabled={pageNum <= 1}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30"
          >
            {t('prev')}
          </button>
          <span className="min-w-[70px] text-center text-xs tabular-nums text-muted-foreground">
            {pageNum} / {numPages}
          </span>
          <button
            onClick={() => setPageNum((p) => Math.min(numPages, p + 1))}
            disabled={pageNum >= numPages}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30"
          >
            {t('next')}
          </button>
        </div>

        <div className="flex items-center gap-1">
          <div className="mr-1 flex items-center border-r border-border pr-2">{rotateButton}</div>
          <ZoomControls
            scale={scale}
            onZoom={zoomAtCenter}
            onReset={() => setScale(fitScaleRef.current)}
            resetTitle={t('resetToWidth')}
          />
          {actions && (
            <div className="ml-1 flex items-center gap-1 border-l border-border pl-2">
              {actions}
            </div>
          )}
        </div>
      </div>

      {/* Scrollable area with grab cursor */}
      <div
        ref={scrollRef}
        className={cn(
          'scrollbar-none flex min-h-[300px] min-w-0 flex-col overflow-auto bg-muted/20 p-4 select-none',
          fill && 'lg:min-h-0 lg:flex-1',
        )}
        style={{ cursor: loading ? '' : 'grab' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {loading ? (
          <div className="m-auto flex items-center justify-center text-sm text-muted-foreground">
            {t('loadingPdf')}
          </div>
        ) : loadFailed || !pdf ? (
          <div className="m-auto flex items-center justify-center text-sm text-muted-foreground">
            {t('previewUnavailable')}
          </div>
        ) : (
          <div className="m-auto w-max h-max">
            <canvas
              ref={canvasRef}
              className="rounded-sm shadow-lg pointer-events-none bg-white"
            />
          </div>
        )}
      </div>
    </div>
  )
}
