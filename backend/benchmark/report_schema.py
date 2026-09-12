"""Shared benchmark report-schema constants (ISSUES.md F7/F8/F9).

Kept in one place so ``run_benchmark.py`` (writes reports) and
``compare_reports.py`` (refuses unsafe comparisons) cannot drift on which
fields identify a reproducible run.
"""

# Bump when a report field changes meaning; compare_reports refuses
# cross-version comparisons (ISSUES.md F7).
METRIC_VERSION = 2

# config fields that must match for two reports to be mechanically comparable.
# Any difference means a different code/env/corpus world (ISSUES.md F8).
FINGERPRINT_FIELDS = (
    "metric_version",
    "git_head",
    "git_dirty",
    "chat_provider",
    "chat_model",
    "openrouter_model",
    "openrouter_scope",
    "chat_failover",
    "ocr_model",
    "ocr_markdown_clean",
    "text_threshold",
    "corpus_hash",
    "golden_hash",
    "snapshot_fingerprint",
)

# compare_reports.py final verdicts -> process exit codes.
VERDICT_EXIT_CODES = {
    "KEEP": 0,
    "DISCARD": 1,
    "BROKEN": 2,
    "POLLUTED": 3,
}
