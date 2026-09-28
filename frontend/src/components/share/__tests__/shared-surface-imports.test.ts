import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ALLOWED_LAZY,
  ROOTS,
  exists,
  walk,
} from '@/test/share-import-graph'

/**
 * The read-only guarantee, enforced where a mistake would be invisible.
 *
 * The backend is the real enforcement point — the public router is GET-only
 * and takes no tenant id — but the frontend half of the promise is that the
 * shared tree cannot REACH the write API, the bearer token, the authed
 * providers or the charting library even by accident.
 *
 * The walker itself lives in `src/test/share-import-graph.ts` so that its
 * classification rules can be exercised directly; see
 * `shared-graph-walk.test.ts`, which pins the one that ST3 broke (static
 * imports must win regardless of traversal order).
 */

describe('shared surface import graph', () => {
  it('reads a graph worth reading', () => {
    // Guards against the roots silently disappearing, and against a resolver
    // that stops resolving (a rename would otherwise turn this into a green
    // no-op).
    for (const root of ROOTS) {
      expect(exists(path.resolve(process.cwd(), root)), root).toBe(true)
    }
    const { staticFiles, lazyFiles } = walk(ROOTS)
    expect(staticFiles.size).toBeGreaterThan(15)
    expect(lazyFiles.size).toBeGreaterThan(0)
  })

  it('reaches no write API, no auth token and no authed provider up front', () => {
    const { staticHits } = walk(ROOTS)
    expect(staticHits).toEqual([])
  })

  it('keeps charting and owner-only code behind the lazy boundaries we chose', () => {
    const { lazyHits } = walk(ROOTS)
    expect([...lazyHits].sort()).toEqual([...ALLOWED_LAZY].sort())
  })
})
