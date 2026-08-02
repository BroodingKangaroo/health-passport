---
description: Run the e2e golden harness for a single case (optional --regen-golden).
---

# E2E single case

Run the golden harness for one case through the isolated server:

`backend/venv/bin/python backend/e2e/run_e2e_server.py --case $1 [--regen-golden]`

- Use port 8099 default; override with `--port` only if busy.
- `--regen-golden` must come from the user explicitly — never add it yourself.
- If `--regen-golden` is passed: after the run, OPEN the generated
  `backend/e2e/golden/<case>/standardized.json`, hand-review it against the
  source document, and present it for user verification before it may be
  considered verified. Never self-approve a regenerated golden and never
  report it as verified until the user confirms.

$1 is the case name; remaining $ARGUMENTS are passed through to the script.