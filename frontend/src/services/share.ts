import { SHARE_GRANT_HEADER, SHARE_TOKEN_HEADER, type SharedRecord } from '@/lib/share'

/**
 * Server-side access to the public share API.
 *
 * Two things here are load-bearing rather than stylistic:
 *
 * - **The backend origin is addressed directly.** `next.config.mjs` rewrites
 *   apply to INCOMING requests, not to fetches the Next server makes, so the
 *   shared page cannot rely on the `/api/*` proxy. `STATIC_PROXY_URL` is the
 *   same value the rewrites use.
 * - **`cache: 'no-store'`.** The link shows the record as it is right now, and
 *   a revoked or expired link must stop resolving on the very next request.
 *   Any caching in front of this read (route cache, CDN) silently breaks
 *   revocation, so the option is a security control.
 *
 * The token travels in a header, never in the URL path of the API, so it
 * stays out of access logs and proxy logs.
 */

const BACKEND_ORIGIN = process.env.STATIC_PROXY_URL || 'http://localhost:8000'

/**
 * Where a share read should be addressed from.
 *
 * `BACKEND_ORIGIN` is for fetches the NEXT SERVER makes: the `/api/*` rewrite
 * in `next.config.mjs` applies to incoming requests only, so the server has to
 * name the backend directly.
 *
 * A fetch from the recipient's BROWSER must instead use the same-origin path —
 * `BACKEND_ORIGIN` is a different origin from the page, so the request would
 * be blocked (or need CORS the backend does not grant). The rewrite proxies it
 * either way.
 *
 * One helper rather than two call sites deciding wrongly: a protected link
 * reads the record on the CLIENT (the first request has no passcode to send),
 * so this distinction is load-bearing for Stage 4.
 */
function shareApiUrl(path: string): string {
  return typeof window === 'undefined' ? `${BACKEND_ORIGIN}${path}` : path
}

/** The link does not resolve: unknown, expired or revoked — indistinguishable. */
export class SharedLinkUnavailableError extends Error {
  constructor() {
    super('share link unavailable')
    this.name = 'SharedLinkUnavailableError'
  }
}

/** The link may be fine; the backend did not answer with a record. */
export class SharedRecordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SharedRecordError'
  }
}

/**
 * The link needs a passcode that this request did not carry (Stage 4, S15).
 *
 * The backend answers a protected link's unauthenticated read with the SAME
 * 404 as a dead link, on purpose — a distinguishable answer would confirm that
 * a token is real. So this error is raised by the caller that KNOWS the link is
 * protected (the unlock flow), never inferred from a response code.
 */
export class SharedPasscodeRequiredError extends Error {
  constructor() {
    super('share link requires a passcode')
    this.name = 'SharedPasscodeRequiredError'
  }
}

/** The passcode was wrong, or the link is not one that can be unlocked. */
export class SharedUnlockFailedError extends Error {
  constructor() {
    super('share unlock failed')
    this.name = 'SharedUnlockFailedError'
  }
}

/** Too many unlock attempts for this link inside the throttle window. */
export class SharedUnlockThrottledError extends Error {
  constructor() {
    super('share unlock throttled')
    this.name = 'SharedUnlockThrottledError'
  }
}

export interface UnlockResult {
  grant: string
  expiresAt: string
}

/**
 * Exchange a passcode for a read grant.
 *
 * A wrong code and a nonexistent link are the same 400 — the backend refuses
 * to distinguish them — so both surface as `SharedUnlockFailedError` and the
 * UI shows one line. The throttle is a 429 and gets its own message, because
 * "wait a moment" is genuinely different advice from "that code is wrong".
 */
export async function unlockSharedRecord(
  token: string,
  passcode: string,
): Promise<UnlockResult> {
  let res: Response
  try {
    // SAME-ORIGIN path, unlike the server-side reads above: this runs in the
    // recipient's BROWSER, where `${BACKEND_ORIGIN}` is a different origin
    // from the page and the request would be blocked (or need CORS). The
    // `/api/*` rewrite in next.config.mjs proxies it to the backend, exactly
    // as the flowsheet read does. The token and the passcode travel in the
    // POST body, so neither reaches a URL, a log line or the address bar.
    res = await fetch('/api/share/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, passcode }),
      cache: 'no-store',
      // Never leak the link to whatever the recipient opens next.
      referrerPolicy: 'no-referrer',
    })
  } catch (cause) {
    throw new SharedRecordError(`share unlock request failed: ${String(cause)}`)
  }
  if (res.status === 429) throw new SharedUnlockThrottledError()
  if (res.status === 400) throw new SharedUnlockFailedError()
  if (!res.ok) throw new SharedRecordError(`share unlock responded ${res.status}`)
  const body = (await res.json()) as { grant: string; expires_at: string }
  return { grant: body.grant, expiresAt: body.expires_at }
}

export async function fetchSharedRecord(
  token: string,
  grant?: string | null,
): Promise<SharedRecord> {
  let res: Response
  try {
    res = await fetch(shareApiUrl('/api/share/record'), {
      headers: {
        [SHARE_TOKEN_HEADER]: token,
        ...(grant ? { [SHARE_GRANT_HEADER]: grant } : {}),
      },
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
  } catch (cause) {
    throw new SharedRecordError(`share record request failed: ${String(cause)}`)
  }
  if (res.status === 404) throw new SharedLinkUnavailableError()
  if (!res.ok) throw new SharedRecordError(`share record responded ${res.status}`)
  return (await res.json()) as SharedRecord
}

/**
 * Whether a link resolves, and whether it needs a passcode (Stage 4, S15).
 *
 * A protected link cannot be server-rendered — the first request has no code —
 * so the page asks this first and renders the prompt instead of a record. A
 * dead token answers 404 exactly as the read paths do.
 *
 * Returns null for "no such link" rather than throwing: the page's normal path
 * for a dead link is the unavailable state, not an error.
 */
export async function fetchShareStatus(
  token: string,
): Promise<{ requires_passcode: boolean } | null> {
  let res: Response
  try {
    // Server-side today, but routed through the same helper so a future
    // client-side caller cannot silently pick the cross-origin form.
    res = await fetch(shareApiUrl('/api/share/status'), {
      headers: { [SHARE_TOKEN_HEADER]: token },
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
  } catch (cause) {
    throw new SharedRecordError(`share status request failed: ${String(cause)}`)
  }
  if (res.status === 404) return null
  if (!res.ok) throw new SharedRecordError(`share status responded ${res.status}`)
  return (await res.json()) as { requires_passcode: boolean }
}


/**
 * The full results table, requested separately so it never weighs down the
 * first paint.
 *
 * A browser-side function rather than a server one (unlike the record read
 * above): the shared page fetches it after mount. A protected link reaches
 * this point already unlocked, so the grant has to travel or the table would
 * 404 on a page whose record above it rendered fine (Stage 4, S15).
 */
export async function fetchSharedFlowsheet(
  token: string,
  grant?: string | null,
): Promise<unknown> {
  const res = await fetch('/api/share/flowsheet', {
    headers: {
      [SHARE_TOKEN_HEADER]: token,
      ...(grant ? { [SHARE_GRANT_HEADER]: grant } : {}),
    },
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  })
  if (!res.ok) throw new SharedRecordError(`share flowsheet responded ${res.status}`)
  return res.json()
}
