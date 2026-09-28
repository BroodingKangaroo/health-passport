import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { walk } from '@/test/share-import-graph'

/**
 * The import-graph walker must make STATIC STRICTLY DOMINATE, whatever order
 * the traversal happens to reach a module in.
 *
 * This is a regression test for a real hole ST3 opened. `visit()` used to
 * return early from the eager branch when the file was already in `lazyFiles`,
 * so a module first discovered through a dynamic import could never be
 * re-flagged as eager. Before ST3 no lazily-reachable path led to
 * `correlation-chart.tsx`, so any static import of it was caught; ST3 added the
 * first lazy path (the click-gated correlation section, deliberately listed in
 * `ALLOWED_LAZY`) and thereby blinded the guard for the one module it exists to
 * protect. Proven by hand: adding a static import of `correlation-chart` to
 * `SharedFullRecord.tsx` AFTER the `SharedCorrelation` import left all three
 * tests green, while placing it before them failed two.
 *
 * The fixture below reproduces that shape without touching the repo: `b` is
 * reached dynamically from `c` and statically from `a`, and `b` is the module
 * that imports a forbidden package. Root order decides which visit happens
 * first, so the assertion holds only if static wins.
 */
function fixture(): { a: string; c: string; b: string; hit: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hp-graph-walk-'))
  const b = path.join(dir, 'b.tsx')
  const a = path.join(dir, 'a.tsx')
  const c = path.join(dir, 'c.tsx')
  // `b` is the module with a forbidden edge: it is the thing that must be
  // classified as eager when ANY static path reaches it.
  writeFileSync(b, "import { Curve } from 'recharts'\nexport const b = Curve\n")
  writeFileSync(a, "import { b } from './b'\nexport const a = b\n")
  writeFileSync(
    c,
    "export async function c() {\n  const m = await import('./b')\n  return m\n}\n",
  )
  return {
    a,
    c,
    b,
    hit: `${path.relative(process.cwd(), b)} -> recharts`,
  }
}

describe('shared import-graph walker', () => {
  it('counts a statically reachable forbidden edge as eager, even when the module was reached lazily first', () => {
    const { a, c, hit } = fixture()
    // `c` first: the dynamic edge reaches `b` before the static one does. This
    // is the ordering that used to hide it.
    const { staticHits, lazyHits } = walk([c, a])
    expect(staticHits).toContain(hit)
    expect(lazyHits).not.toContain(hit)
  })

  it('gives the same answer whichever root is visited first', () => {
    const { a, c, hit } = fixture()
    const first = walk([a, c])
    const second = walk([c, a])
    expect([...first.staticHits].sort()).toEqual([...second.staticHits].sort())
    expect([...first.lazyHits].sort()).toEqual([...second.lazyHits].sort())
    expect(second.staticHits).toContain(hit)
  })
})
