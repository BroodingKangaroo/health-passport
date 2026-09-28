'use client'

import { createContext, useContext } from 'react'

/**
 * WHO is looking at a record.
 *
 * Replaces the old `isDemo` boolean (shared-view plan ST2, §3): the full
 * record reuses the owner's own components, so a component that hides a
 * write affordance has to ask *which* kind of viewer it is under, not just
 * "is this the marketing page". Three values, one provider:
 *
 * - `owner`  — the signed-in person's own record. Everything is available.
 * - `demo`   — the /demo marketing surface over a fictional fixture. Stateful
 *              affordances that would act on real data (entry deletion) are
 *              hidden; the rest of the app's chrome is shown on purpose,
 *              because showing the product is the point of that page.
 * - `shared` — a stranger reading someone else's record through a link. No
 *              write affordance at all, and the shared tree may not import
 *              the authed data layer (enforced by the import-graph test).
 *
 * Hiding a button is NOT the read-only guarantee — the public router being
 * GET-only and the authed imports being absent are. This capability exists so
 * the reused components do not *offer* an action that cannot work.
 */
export type ViewerCapability = 'owner' | 'demo' | 'shared'

export interface ViewerValue {
  capability: ViewerCapability
  /** Full access to the owner's own record. */
  isOwner: boolean
  /** The /demo marketing surface. */
  isDemo: boolean
  /** A recipient reading a shared link. */
  isShared: boolean
}

// Module-level constants: the value must be referentially stable across
// renders, or every consumer re-renders whenever the provider's parent does.
const VALUES: Record<ViewerCapability, ViewerValue> = {
  owner: { capability: 'owner', isOwner: true, isDemo: false, isShared: false },
  demo: { capability: 'demo', isOwner: false, isDemo: true, isShared: false },
  shared: {
    capability: 'shared',
    isOwner: false,
    isDemo: false,
    isShared: true,
  },
}

// Default `owner`: every surface outside /demo and /s/<token> behaves exactly
// as before, so a component that forgets to wrap its tree keeps full
// behaviour rather than silently losing affordances.
const ViewerContext = createContext<ViewerValue>(VALUES.owner)

export function ViewerProvider({
  capability,
  children,
}: {
  capability: ViewerCapability
  children: React.ReactNode
}) {
  return (
    <ViewerContext.Provider value={VALUES[capability]}>
      {children}
    </ViewerContext.Provider>
  )
}

export function useViewer(): ViewerValue {
  return useContext(ViewerContext)
}
