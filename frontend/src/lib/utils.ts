import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { getAccessToken } from '@/lib/auth-token'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Fetch a protected document (e.g. /static/uploads/...) with the auth token and
 * return a same-origin object URL. The raw URL cannot be used directly by an
 * <img>/<iframe>/<a download> because those requests can't send the
 * Authorization header, so the backend rejects them as anonymous (403).
 */
export async function fetchAuthedObjectUrl(url: string): Promise<string> {
  const token = getAccessToken()
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {}
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`Failed to load document: ${res.status}`)
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

const IMAGE_RE = /\.(jpg|jpeg|png|gif|webp|tiff|tif|bmp)$/i

/**
 * Print a protected document. Fetches it with the auth token, then opens the
 * browser print dialog for it. Images are wrapped in a minimal HTML page with
 * print styles so the picture fits on a single page (otherwise the browser
 * prints the raw <img> at natural size, splitting it across pages). Cleanup
 * happens on `afterprint` (when the dialog is dismissed) rather than on a
 * timer, so the print dialog is never yanked out from under the user.
 */
export async function printAuthedDocument(url: string): Promise<void> {
  const token = getAccessToken()
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {}
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`Failed to load document: ${res.status}`)
  const blob = await res.blob()
  const isImage = IMAGE_RE.test(url) || blob.type.startsWith('image/')

  let src: string
  let cleanup: () => void
  if (isImage) {
    const imgUrl = URL.createObjectURL(blob)
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { margin: 0; }
      html, body { margin: 0; padding: 0; height: 100%; }
      img { display: block; margin: 0 auto; max-width: 100%; max-height: 100vh; width: auto; height: auto; object-fit: contain; page-break-inside: avoid; }
    </style></head><body><img src="${imgUrl}"></body></html>`
    src = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    cleanup = () => {
      URL.revokeObjectURL(src)
      URL.revokeObjectURL(imgUrl)
    }
  } else {
    src = URL.createObjectURL(blob)
    cleanup = () => URL.revokeObjectURL(src)
  }

  const iframe = document.createElement('iframe')
  iframe.style.position = 'absolute'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  document.body.appendChild(iframe)
  iframe.onload = () => {
    const w = iframe.contentWindow
    if (!w) return
    w.onafterprint = cleanup
    try { w.focus() } catch {}
    try { w.print() } catch {}
  }
  iframe.src = src
}

export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const base = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  if (d.getHours() !== 0 || d.getMinutes() !== 0) {
    return `${base} at ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }
  return base
}

export function splitDateLabel(dateStr: string): { label: string; sub?: string } {
  const d = new Date(dateStr)
  if (!isNaN(d.getTime())) {
    const base = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    if (d.getHours() !== 0 || d.getMinutes() !== 0) {
      return {
        label: base,
        sub: `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`,
      }
    }
    return { label: base }
  }
  const idx = dateStr.indexOf(' at ')
  if (idx === -1) return { label: dateStr }
  return { label: dateStr.slice(0, idx), sub: dateStr.slice(idx + 4) }
}
