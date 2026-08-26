---
description: Run or resume the extraction autoresearch loop (benchmark-driven quality/cost optimization).
---

# Autoresearch: extraction quality/cost loop

$ARGUMENTS optionally carries a mode (`start`, `resume`) or a free-form goal
(e.g. "improve recognition on instrumental tests"), plus iteration overrides
like `--max-iterations 5`.

## Behavior

1. Load the **autoresearch** skill (`.opencode/skills/autoresearch/SKILL.md`)
   and follow it exactly — it owns the safety rules, keep rule, guards and
   journaling.

2. Determine mode:
   - `resume` **or** `.autoresearch/state.json` exists → resume from the
     recorded iteration/baseline; verify the working tree matches the state
     file's expectations before continuing.
   - otherwise `start`: create/switch to branch `autoresearch/extraction`,
     record the baseline report under `backend/reports/baseline.json`, and
     initialize `.autoresearch/state.json`.

3. If $ARGUMENTS names a focus area, seed the iteration backlog with hypotheses
   for that area only; otherwise build the backlog from known flakiness notes
   in `backend/e2e/KNOWN_ISSUES.md` and matcher/prompt code smells.

4. Iterate up to the cap (`--max-iterations` from arguments, default 10),
   honoring: ONE change per iteration, full-cost verification only for
   plausible keeps, ε-margin keep rule, guard vetoes (`pytest tests/`,
   `ruff check .`, `python -m e2e.validate_offline` from `backend/`),
   journal updates.

5. End with the skill's reporting format and hand every kept commit to the
   user for review. Never merge to main, never push, never commit without the
   journal being current.
