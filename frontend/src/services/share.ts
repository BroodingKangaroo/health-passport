import { SHARE_TOKEN_HEADER, type SharedRecord } from '@/lib/share'

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

export async function fetchSharedRecord(token: string): Promise<SharedRecord> {
  let res: Response
  try {
    res = await fetch(`${BACKEND_ORIGIN}/api/share/record`, {
      headers: { [SHARE_TOKEN_HEADER]: token },
      cache: 'no-store',
    })
  } catch (cause) {
    throw new SharedRecordError(`share record request failed: ${String(cause)}`)
  }
  if (res.status === 404) throw new SharedLinkUnavailableError()
  if (!res.ok) throw new SharedRecordError(`share record responded ${res.status}`)
  return (await res.json()) as SharedRecord
}
