"""Shared benchmark report-schema constants (ISSUES.md F7/F8/F9).

Kept in one place so ``run_benchmark.py`` (writes reports) and
``compare_reports.py`` (refuses unsafe comparisons) cannot drift on which
fields identify a reproducible run.
"""

# Bump when a report field changes meaning; compare_reports refuses
# cross-version comparisons (ISSUES.md F7).
METRIC_VERSION = 2

# config fields that must match for two reports to be mechanically comparable.
# These describe the metric's environment + data world. Any difference means a
# different env/corpus world (ISSUES.md F8).
FINGERPRINT_FIELDS = (
    "metric_version",
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
    "snapshot_data_fingerprint",
)

# Recorded code/world drift — informational, never a verdict veto. The loop's
# A/B variable IS code (git HEAD/dirty + the pipeline half of the snapshot
# fingerprint), so gating these would make every iteration BROKEN by
# construction. The data half of the snapshot fingerprint stays in
# FINGERPRINT_FIELDS above.
CODE_DRIFT_FIELDS = (
    "git_head",
    "git_dirty",
    "snapshot_code_fingerprint",
    "snapshot_fingerprint",
)

# compare_reports.py final verdicts -> process exit codes.
VERDICT_EXIT_CODES = {
    "KEEP": 0,
    "DISCARD": 1,
    "BROKEN": 2,
    "POLLUTED": 3,
}
