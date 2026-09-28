import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * The walker behind the shared surface's read-only guarantee, in its own
 * module so it can be exercised directly (`shared-graph-walk.test.ts`) and not
 * only through the real tree (`shared-surface-imports.test.ts`).
 *
 * It walks the real import graph instead of grepping each file: a textual
 * check passes the moment the offending import sits one file further away,
 * which is exactly how the ST2 full record would have failed — the recipient
 * tree renders the owner's timeline, whose detail views reached `services/api`
 * through `entry-settings`, and `lib/utils` pulled `lib/auth-token` into every
 * page that formatted a date. Both were found by this walk.
 */

export const FORBIDDEN = [
  '@/services/api',
  '@/lib/auth-token',
  '@/components/providers/AuthProvider',
  '@/providers/query-provider',
  '@/i18n/api-locale',
  'recharts',
  'next-auth',
]

/** Where the recipient's load path begins. */
export const ROOTS = [
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
 *   only when a chart actually renders.
 * - `correlation-chart` is the ST3 addition: the recipient's correlation
 *   section imports it dynamically AND renders it only after a click, so the
 *   shared page fetches no chart chunk until the reader asks for one.
 * - `authed-documents` (and the `DocumentViewer` and `services/api` behind it)
 *   is reached only from `document-tab`, which imports it inside its handlers;
 *   the shared record renders no documents tab and no attachments.
 *
 * Adding a line here is a deliberate act; that is the point of the test.
 */
export const ALLOWED_LAZY = [
  'src/components/health-passport/correlation-chart.tsx -> recharts',
  'src/components/health-passport/entry-delete.tsx -> @/services/api',
  'src/components/shared/BiomarkerChartInner.tsx -> recharts',
  'src/components/shared/DocumentViewer.tsx -> @/lib/auth-token',
  'src/components/shared/Sparkline.tsx -> recharts',
  'src/lib/authed-documents.ts -> @/lib/auth-token',
  'src/lib/chart-line-shape.tsx -> recharts',
  'src/services/api.ts -> @/i18n/api-locale',
  'src/services/api.ts -> @/lib/auth-token',
]

export const SRC = path.resolve(process.cwd(), 'src')

export function exists(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

export function resolveSpecifier(specifier: string, fromFile: string): string | null {
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
export function edgesOf(file: string): { specifier: string; dynamic: boolean }[] {
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

export function walk(roots: string[]) {
  // `staticFiles`: reached through static imports only — this is the module
  // graph the recipient's browser loads up front.
  const staticFiles = new Set<string>()
  const lazyFiles = new Set<string>()
  // One entry per FORBIDDEN EDGE, classified at the END against the final
  // `staticFiles` set. Recording each hit with the flag it happened to have at
  // traversal time — and keeping it there — is what made the old version
  // order-sensitive as well as blind: a module reached lazily first would sit
  // in `lazyHits` for good, even after a static path promoted it. Keyed by
  // file + specifier because one module may import more than one of them.
  const hits: { file: string; line: string }[] = []
  const seen = new Set<string>()

  const visit = (file: string, lazy: boolean): void => {
    if (lazy) {
      if (staticFiles.has(file)) return
      if (lazyFiles.has(file)) return
      lazyFiles.add(file)
    } else {
      if (staticFiles.has(file)) return
      // STATIC WINS, WHATEVER ORDER THE TRAVERSAL ARRIVES IN.
      //
      // This used to `return` here when the file was already in `lazyFiles`,
      // which made the guard order-sensitive: a module first discovered
      // through a dynamic import could never be re-flagged as eager. ST3
      // opened that hole for `correlation-chart.tsx` — it became the first
      // lazily-reachable module (the click-gated correlation section, listed
      // in `ALLOWED_LAZY`), so a static import of it placed AFTER the dynamic
      // one went unnoticed, while the same import placed BEFORE it failed the
      // suite. Demote it back to eager and keep walking: the lazy mark is a
      // provisional classification, not a verdict.
      lazyFiles.delete(file)
      staticFiles.add(file)
    }
    for (const edge of edgesOf(file)) {
      const hit = FORBIDDEN.find(
        (entry) => edge.specifier === entry || edge.specifier.startsWith(`${entry}/`),
      )
      if (hit) {
        const key = `${file}|${edge.specifier}`
        if (!seen.has(key)) {
          seen.add(key)
          hits.push({
            file,
            line: `${path.relative(process.cwd(), file)} -> ${edge.specifier}`,
          })
        }
      }
      const next = resolveSpecifier(edge.specifier, file)
      if (next) visit(next, lazy || edge.dynamic)
    }
  }

  for (const root of roots) visit(path.resolve(process.cwd(), root), false)

  const staticHits: string[] = []
  const lazyHits: string[] = []
  for (const hit of hits) {
    ;(staticFiles.has(hit.file) ? staticHits : lazyHits).push(hit.line)
  }
  return { staticFiles, lazyFiles, staticHits, lazyHits }
}
