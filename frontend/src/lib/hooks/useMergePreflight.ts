'use client'

import { useEffect, useMemo, useState } from 'react'

import { fetchEntriesByDate } from '@/services/api'
import type { EntrySummary, FormCategory } from '@/lib/types'

// Duplicate detection + merge pre-flight for blood-test entries: watches the
// picked date, lists same-date entries, and mirrors the backend's conflict
// resolution (definition_id / LOINC exact; manual rows by name — exact for
// names, substring containment for synonyms) so the checkbox can never stay
// enabled for a merge that would 409.
export function useMergePreflight(
  documentType: string,
  dateValue: string,
  categories: FormCategory[],
) {
  const [duplicateWarning, setDuplicateWarning] = useState(false)
  const [duplicateCheckFailed, setDuplicateCheckFailed] = useState(false)
  const [timeRequired, setTimeRequired] = useState(false)
  const [existingBloodTests, setExistingBloodTests] = useState<EntrySummary[]>([])
  const [mergeSelected, setMergeSelected] = useState(false)
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null)

  // Reset duplicate-detection/merge state when the date or document type
  // changes. Adjusted during render (React 19's "storing info from previous
  // renders" pattern) because it's derived state — no setState-in-effect here.
  const [prevFilter, setPrevFilter] = useState({ type: documentType, date: dateValue })
  if (prevFilter.type !== documentType || prevFilter.date !== dateValue) {
    setPrevFilter({ type: documentType, date: dateValue })
    setDuplicateWarning(false)
    setDuplicateCheckFailed(false)
    setTimeRequired(false)
    setExistingBloodTests([])
    setMergeSelected(false)
    setMergeTargetId(null)
  }

  useEffect(() => {
    if (!dateValue || documentType !== 'blood_test') return
    const controller = new AbortController()
    const t = setTimeout(async () => {
      try {
        const res = await fetchEntriesByDate(dateValue, 'blood_test', {
          // Actually cancel the in-flight request on unmount/date change
          // (ISSUES.md #67) instead of only filtering its late response.
          signal: controller.signal,
        })
        // Ignore stale responses
        if (controller.signal.aborted) return
        setExistingBloodTests(res.entries ?? [])
        setDuplicateCheckFailed(false)
        const hasDuplicate = (res.entries?.length ?? 0) > 0
        setDuplicateWarning(hasDuplicate)
        setTimeRequired(hasDuplicate)
        // A changed date invalidates any merge selection; default to the first
        // candidate when a single blood test exists on the date.
        setMergeSelected(false)
        setMergeTargetId((prev) =>
          prev && res.entries?.some((e) => e.id === prev) ? prev : res.entries?.[0]?.id ?? null,
        )
      } catch {
        // An abort means the effect re-ran / unmounted — the new request is
        // in charge, so don't flag a failure.
        if (controller.signal.aborted) return
        // The duplicate/merge pre-flight failed — say so instead of letting
        // the warning silently vanish while Save stays enabled (which is how
        // duplicate entries happen).
        setDuplicateCheckFailed(true)
      }
    }, 300)
    return () => {
      clearTimeout(t)
      controller.abort()
    }
  }, [dateValue, documentType])

  // Merge target + conflict detection against the biomarkers already present
  // in the existing entry the user picked. A conflict (same biomarker in both
  // tests) disables merging — a merged entry can't hold two readings of one
  // analyte. Rows the backend would skip (empty name/value) are ignored.
  const selectedMergeTarget = useMemo(() => {
    if (mergeTargetId) return existingBloodTests.find((e) => e.id === mergeTargetId) ?? null
    return existingBloodTests[0] ?? null
  }, [existingBloodTests, mergeTargetId])
  const mergeConflicts = useMemo(() => {
    if (!selectedMergeTarget) return []
    const keys = new Set<string>()
    const names = new Set<string>()
    const synonyms: string[] = []
    for (const b of selectedMergeTarget.biomarkers) {
      keys.add(b.definition_id)
      if (b.loinc_code) keys.add(b.loinc_code)
      for (const n of Object.values(b.names ?? {})) names.add(n.toLowerCase())
      for (const s of b.synonyms ?? []) synonyms.push(s.toLowerCase())
    }
    const conflicts: string[] = []
    for (const cat of categories) {
      for (const row of cat.rows) {
        if (!row.name.trim() || !row.value.trim()) continue
        const nameLower = row.name.trim().toLowerCase()
        // Rows carrying a definition_id conflict when that id (or its LOINC
        // code) is already in the target. Manually-typed rows without one are
        // resolved by name on the server — match those client-side too, so the
        // checkbox isn't left enabled for a merge that will 409. The server
        // resolves names exactly (ILIKE without wildcards) but synonyms with
        // substring containment (ILIKE '%name%'), so a typed name that is a
        // substring of an existing synonym also conflicts.
        const conflictsById = !!row.definition_id && keys.has(row.definition_id)
        const conflictsByName =
          !row.definition_id &&
          (names.has(nameLower) || synonyms.some((s) => s.includes(nameLower)))
        if (conflictsById || conflictsByName) {
          conflicts.push(row.name)
        }
      }
    }
    return conflicts
  }, [selectedMergeTarget, categories])
  const mergeBlocked = mergeConflicts.length > 0
  const merging = mergeSelected && !mergeBlocked && !!selectedMergeTarget

  // If the box is ticked and a conflict shows up afterwards (e.g. the AI
  // extraction lands a biomarker that's already in the target, or the user
  // edits a row into conflict), reset the selection: a checked-but-blocked
  // box is a lie, and saving would silently create a duplicate entry — the
  // exact thing merging exists to prevent. Adjusted during render (React 19's
  // "adjusting state when props change" pattern) instead of in an effect.
  if (mergeSelected && mergeBlocked) {
    setMergeSelected(false)
  }

  return {
    duplicateWarning,
    duplicateCheckFailed,
    timeRequired,
    existingBloodTests,
    mergeSelected,
    setMergeSelected,
    selectedMergeTarget,
    mergeTargetId,
    setMergeTargetId,
    mergeConflicts,
    mergeBlocked,
    merging,
  }
}
