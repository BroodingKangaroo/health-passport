import { getAccessToken } from '@/lib/auth-token'

/**
 * Document helpers that require the bearer token.
 *
 * Split out of `lib/utils.ts` so the shared (recipient) tree can import the
 * formatting helpers without pulling `lib/auth-token` into its graph. The
 * shared tree renders no attachments, so nothing there needs these, and the
 * import-graph test enforces that.
 */

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
 * timer, so the print dialog is never yanked out from under the user; a
 * safety timeout covers browsers that never fire it for a programmatic print.
 * The hidden iframe and both object URLs are always released.
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
  let revoke: () => void
  if (isImage) {
    const imgUrl = URL.createObjectURL(blob)
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { margin: 0; }
      html, body { margin: 0; padding: 0; height: 100%; }
      img { display: block; margin: 0 auto; max-width: 100%; max-height: 100vh; width: auto; height: auto; object-fit: contain; page-break-inside: avoid; }
    </style></head><body><img src="${imgUrl}"></body></html>`
    src = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    revoke = () => {
      URL.revokeObjectURL(src)
      URL.revokeObjectURL(imgUrl)
    }
  } else {
    src = URL.createObjectURL(blob)
    revoke = () => URL.revokeObjectURL(src)
  }

  const iframe = document.createElement('iframe')
  iframe.style.position = 'absolute'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  document.body.appendChild(iframe)

  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    iframe.remove()
    revoke()
  }

  // Safety net armed BEFORE the load handler: an iframe that never fires
  // `load` (revoked blob URL, replaced body) is still released. `cleanedUp`
  // makes the afterprint/timeout/throw paths collapse into one cleanup, so
  // the pending timer needs no cancellation.
  setTimeout(cleanup, 60_000)

  iframe.onload = () => {
    const w = iframe.contentWindow
    if (!w) {
      // Nothing to print from — release instead of leaking the iframe/URLs.
      cleanup()
      return
    }
    w.onafterprint = cleanup
    try { w.focus() } catch {}
    try { w.print() } catch { cleanup() }
  }
  iframe.src = src
}
