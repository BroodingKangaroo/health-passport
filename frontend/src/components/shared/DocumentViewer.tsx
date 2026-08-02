'use client'

import { useRef, useLayoutEffect, useEffect, useState, useCallback } from 'react'
import * as pdfjs from 'pdfjs-dist'
import { getAccessToken } from '@/lib/auth-token'

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

interface DocumentViewerProps {
  url?: string
}

export function DocumentViewer({ url }: DocumentViewerProps) {
  const isImage =
    typeof url === 'string' &&
    /\.(jpg|jpeg|png|gif|webp|tiff|tif|bmp)$/i.test(url)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null)
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
  const [loading, setLoading] = useState(() => !url)
  const [imgSrc, setImgSrc] = useState<string | null>(null)
  const [fitHeight, setFitHeight] = useState(0)
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
    setNumPages(0)
    setPageNum(1)
    setScale(1)
    setFitHeight(0)
    setLoading(true)
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
        const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise
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
          setFitHeight(page.getViewport({ scale: fitScaleRef.current }).height)
        }
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [url, isImage])

  const renderPage = useCallback(async () => {
    if (!pdf || !canvasRef.current) return
    try {
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel() } catch {}
        renderTaskRef.current = null
      }
      const page = await pdf.getPage(pageNum)
      const viewport = page.getViewport({ scale })
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
  }, [pdf, pageNum, scale])

  useLayoutEffect(() => {
    renderPage()
    return () => {
      try { renderTaskRef.current?.cancel() } catch {}
    }
  }, [renderPage])

  useEffect(() => {
    scaleRef.current = scale
  }, [scale])

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

  if (!url) {
    return (
      <div className="flex min-h-[300px] items-center justify-center text-sm text-muted-foreground">
        No document URL provided
      </div>
    )
  }

  if (isImage) {
    return (
      <div className="flex min-h-[300px] h-[80vh] min-w-0 flex-col bg-muted/20">
        <div className="flex items-center justify-between border-b border-border bg-card px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">
            Image preview
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center overflow-auto bg-muted/20 p-4">
          {imgSrc ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={imgSrc}
              alt="Document preview"
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="text-sm text-muted-foreground">
              {loading ? 'Loading…' : 'Preview unavailable'}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col bg-muted/20">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border bg-card px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPageNum((p) => Math.max(1, p - 1))}
            disabled={pageNum <= 1}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30"
          >
            Prev
          </button>
          <span className="min-w-[70px] text-center text-xs tabular-nums text-muted-foreground">
            {pageNum} / {numPages}
          </span>
          <button
            onClick={() => setPageNum((p) => Math.min(numPages, p + 1))}
            disabled={pageNum >= numPages}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30"
          >
            Next
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => zoomAtCenter(-1)}
            className="flex size-6 items-center justify-center rounded text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title="Zoom out"
          >
            -
          </button>
          <span className="min-w-[36px] text-center text-xs tabular-nums text-muted-foreground">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => zoomAtCenter(1)}
            className="flex size-6 items-center justify-center rounded text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title="Zoom in"
          >
            +
          </button>
          <button
            onClick={() => setScale(fitScaleRef.current)}
            className="ml-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title="Reset to fit width"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Scrollable area with grab cursor */}
      <div
        ref={scrollRef}
        className="flex min-h-[300px] min-w-0 flex-col overflow-auto bg-muted/20 p-4 select-none"
        style={{ height: fitHeight ? fitHeight + 32 : undefined, cursor: loading ? '' : 'grab' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {loading ? (
          <div className="m-auto flex items-center justify-center text-sm text-muted-foreground">
            Loading...
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
