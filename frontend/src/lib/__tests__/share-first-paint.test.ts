import { describe, expect, it } from 'vitest'

import { sharedFirstPaint } from '@/lib/share'

/**
 * The shared page's first-paint decision (Stage 4, S15).
 *
 * It lives in a pure helper because a server component is impractical to
 * render in vitest, and this branch was the one a real browser had to catch
 * during Stage 4 development: the page asks `GET /api/share/status` and has to
 * turn one of three answers into one of three renders.
 */
describe('sharedFirstPaint', () => {
  it('reads the record when the link is unprotected', () => {
    expect(sharedFirstPaint({ requires_passcode: false })).toBe('record')
  })

  it('prompts for the passcode when the link is protected', () => {
    expect(sharedFirstPaint({ requires_passcode: true })).toBe('protected')
  })

  it('shows the dead-link page when the probe found no link', () => {
    // `null` is what fetchShareStatus returns for a 404 — the same answer for
    // unknown, revoked and expired tokens.
    expect(sharedFirstPaint(null)).toBe('unavailable')
  })

  it('never reports a record for a link it could not confirm', () => {
    // The dangerous direction: a null answer must not fall through to a read.
    const outcomes = [sharedFirstPaint(null), sharedFirstPaint({ requires_passcode: true })]
    expect(outcomes).not.toContain('record')
  })
})
