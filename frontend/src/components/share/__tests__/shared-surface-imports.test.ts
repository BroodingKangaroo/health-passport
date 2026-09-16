import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The read-only guarantee, enforced where a mistake would be invisible.
 *
 * The backend is the real enforcement point — the public router is GET-only
 * and takes no tenant id — but the frontend half of the promise is that the
 * shared tree cannot reach the write API, the bearer token, or the authed
 * providers even by accident. A stray import would hand a recipient's browser
 * a code path that assumes a session.
 */
const FORBIDDEN_IMPORTS = [
  '@/services/api',
  '@/lib/auth-token',
  '@/components/providers/AuthProvider',
  '@/providers/query-provider',
]

const ROOTS = ['src/components/share', "src/app/(public)"]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      // `sender/` is the OWNER's half of the feature (create/revoke) and
      // legitimately talks to the authenticated API; the recipient tree is
      // everything else under `share/`.
      if (entry === '__tests__' || entry === 'sender') continue
      out.push(...walk(full))
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

describe('shared surface import graph', () => {
  it('never imports the write API, the auth token or the authed providers', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(path.resolve(process.cwd(), root))) {
        const source = readFileSync(file, 'utf8')
        for (const forbidden of FORBIDDEN_IMPORTS) {
          if (source.includes(`'${forbidden}'`) || source.includes(`"${forbidden}"`)) {
            offenders.push(`${path.relative(process.cwd(), file)} -> ${forbidden}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
