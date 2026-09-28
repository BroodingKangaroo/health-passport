import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The read-only guarantee, enforced where a mistake would be invisible.
 *
 * The backend is the real enforcement point — the public router is GET-only
 * and takes no tenant id — but the frontend half of the promise is that the
 * shared tree cannot REACH the write API, the bearer token, the authed
 * providers or the charting library even by accident.
 *
 * This walks the real import graph instead of grepping each file. A textual
 * check passes the moment the offending import sits one file further away,
 * which is exactly how the ST2 full record would have failed: the recipient
 * tree renders the owner's timeline, whose detail views reached `services/api`
 * through `entry-settings`, and `lib/utils` pulled `lib/auth-token` into every
 * page that formatted a date. Both were found by this walk and fixed by moving
 * the code behind a boundary.
 */

const FORBIDDEN = [
  '@/services/api',
  '@/lib/auth-token',
  '@/components/providers/AuthProvider',
  '@/providers/query-provider',
  '@/i18n/api-locale',
  'recharts',
  'next-auth',
]

/** Where the recipient's load path begins. */
const ROOTS = [
  'src/components/share/SharedRecordView.tsx',
  'src/components/share/SharedStates.tsx',
  'src/components/share/SharedUnlockGate.tsx',
  'src/components/share/language-switch.tsx',
  'src/app/(public)/s/[token]/page.tsx',
  'src/lib/share-grant.ts',
]

/**
 * The only `FORBIDDEN` edges a recipient can reach at all, each behind a
 * dynamic boundary that never opens on the shared surface:
 *
 * - `entry-delete` is the owner-only danger zone: the shared full view renders
 *   no settings tab, and `EntrySettings` renders nothing for a recipient.
 * - the three chart modules are behind `next/dynamic`, so they are fetched
 *   only when a chart actually renders — the shared record shows none.
 * - `authed-documents` (and the `DocumentViewer` and `services/api` behind it)
 *   is reached only from `document-tab`, which imports it inside its handlers;
 *   the shared record renders no documents tab and no attachments.
 *
 * Adding a line here is a deliberate act; that is the point of the test.
 */
const ALLOWED_LAZY = [
  'src/components/health-passport/entry-delete.tsx -> @/services/api',
  'src/components/shared/BiomarkerChartInner.tsx -> recharts',
  'src/components/shared/DocumentViewer.tsx -> @/lib/auth-token',
  'src/components/shared/Sparkline.tsx -> recharts',
  'src/lib/authed-documents.ts -> @/lib/auth-token',
  'src/lib/chart-line-shape.tsx -> recharts',
  'src/services/api.ts -> @/i18n/api-locale',
  'src/services/api.ts -> @/lib/auth-token',
]

const SRC = path.resolve(process.cwd(), 'src')

function exists(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function resolveSpecifier(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith('@/')
    ? path.join(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? path.resolve(path.dirname(fromFile), specifier)
      : null
  if (!base) return null
  for (const candidate of [
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, 'index.tsx'),
    path.join(base, 'index.ts'),
  ]) {
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * Every specifier a module pulls in at RUNTIME, with the kind of edge.
 *
 * `import type` / `export type` lines are dropped: TypeScript erases them, so
 * they cannot put a byte of recharts, or a line of `services/api`, into a
 * recipient's browser. Everything else counts, `await import(...)` included —
 * it is a real chunk, just a lazy one.
 */
function edgesOf(file: string): { specifier: string; dynamic: boolean }[] {
  const source = readFileSync(file, 'utf8')
    .replace(/^\s*import\s+type\s[^\n]*$/gm, '')
    .replace(/^\s*export\s+type\s[^\n]*$/gm, '')
  const edges: { specifier: string; dynamic: boolean }[] = []
  const re =
    /(?:^|[^\w.])(?:import|export)[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g
  for (const match of source.matchAll(re)) {
    edges.push({ specifier: match[1] ?? match[2], dynamic: !match[1] })
  }
  return edges
}

function walk(roots: string[]) {
  // `staticFiles`: reached through static imports only — this is the module
  // graph the recipient's browser loads up front.
  const staticFiles = new Set<string>()
  const lazyFiles = new Set<string>()
  const staticHits: string[] = []
  const lazyHits: string[] = []

  const visit = (file: string, lazy: boolean): void => {
    if (lazy) {
      if (staticFiles.has(file)) return
      if (lazyFiles.has(file)) return
      lazyFiles.add(file)
    } else {
      if (staticFiles.has(file)) return
      if (lazyFiles.has(file)) return
      staticFiles.add(file)
    }
    for (const edge of edgesOf(file)) {
      const hit = FORBIDDEN.find(
        (entry) => edge.specifier === entry || edge.specifier.startsWith(`${entry}/`),
      )
      if (hit) {
        const line = `${path.relative(process.cwd(), file)} -> ${edge.specifier}`
        ;(lazy || edge.dynamic ? lazyHits : staticHits).push(line)
      }
      const next = resolveSpecifier(edge.specifier, file)
      if (next) visit(next, lazy || edge.dynamic)
    }
  }

  for (const root of roots) visit(path.resolve(process.cwd(), root), false)
  return { staticFiles, lazyFiles, staticHits, lazyHits }
}

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
