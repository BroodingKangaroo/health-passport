/**
 * "New" markers for the /imports tracker (ISSUES.md #76 rework): job ids
 * submitted from /add-entry that the user has not opened yet. Tracked in
 * sessionStorage (per tab — the submission and its review happen in the same
 * tab) so the tracker can badge freshly added extractions and distinguish
 * them from previously viewed ones. An id leaves the set when its job is
 * opened (progress view, review editor or the tracker's auto-transition).
 */

const STORAGE_KEY = 'imports_new_job_ids'

function read(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : []
  } catch {
    return []
  }
}

function write(ids: string[]) {
  if (typeof window === 'undefined') return
  try {
    if (ids.length === 0) window.sessionStorage.removeItem(STORAGE_KEY)
    else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    /* storage unavailable (private mode) — badges degrade gracefully */
  }
}

export function addNewImportJobIds(ids: string[]) {
  if (ids.length === 0) return
  write([...new Set([...read(), ...ids])])
}

export function getNewImportJobIds(): string[] {
  return read()
}

export function markImportJobSeen(id: string) {
  const remaining = read().filter((x) => x !== id)
  if (remaining.length !== read().length) write(remaining)
}
