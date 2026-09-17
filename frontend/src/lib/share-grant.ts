import { SHARE_GRANT_STORAGE_KEY } from './share'

/**
 * Where a recipient's unlock grant lives (Stage 4, S15).
 *
 * `sessionStorage`, deliberately:
 *
 * - **Not a cookie.** The share surface sets no cookie by contract — a
 *   recipient is a stranger, and opening a link must not write state about
 *   them that the app would then send on every later request.
 * - **Not `localStorage`.** Closing the tab forgets the code, which is the
 *   behaviour a person expects from "I typed a passcode into this page".
 * - **Not the URL.** A grant in a query parameter would end up in the
 *   recipient's history, in `Referer` headers, and in whatever they paste
 *   into a chat.
 *
 * Every access is wrapped: `sessionStorage` throws in a sandboxed iframe and
 * in some privacy modes, and a recipient who cannot store a grant must still
 * be able to read the record for the length of their visit. Falling back to
 * "no grant" means they unlock again, not that the page breaks.
 *
 * The value is keyed per link so unlocking one shared record cannot leak a
 * grant into another one opened in the same tab.
 */

interface StoredGrant {
  token: string
  grant: string
  expiresAt: number
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function read(): StoredGrant | null {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(SHARE_GRANT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredGrant>
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.grant !== 'string' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null
    }
    return parsed as StoredGrant
  } catch {
    return null
  }
}

/**
 * The stored grant for exactly this link, or null.
 *
 * Expiry is checked here as well as on the server: a stale grant is dropped
 * rather than sent to be refused, so an expired unlock shows the prompt
 * instead of a dead-link page.
 */
export function readShareGrant(token: string): string | null {
  const stored = read()
  if (!stored || stored.token !== token) return null
  if (stored.expiresAt <= Date.now()) {
    clearShareGrant()
    return null
  }
  return stored.grant
}

export function storeShareGrant(token: string, grant: string, expiresAt: string): void {
  const store = storage()
  if (!store) return
  const parsed = Date.parse(expiresAt)
  const value: StoredGrant = {
    token,
    grant,
    // A missing/unparseable expiry is treated as "already expired" rather
    // than "forever": an unbounded client-side credential is the bug this
    // guards against.
    expiresAt: Number.isFinite(parsed) ? parsed : 0,
  }
  try {
    store.setItem(SHARE_GRANT_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Quota or a sandboxed store: the recipient simply unlocks again.
  }
}

export function clearShareGrant(): void {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(SHARE_GRANT_STORAGE_KEY)
  } catch {
    // Nothing to do: the grant is already unusable if we cannot reach it.
  }
}
