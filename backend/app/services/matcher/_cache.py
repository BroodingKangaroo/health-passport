"""Per-thread, extraction-scoped LLM caches shared by the matcher modules.

These must live in exactly one place: the cache objects below are process-wide
singletons keyed by worker thread, and every matcher submodule has to share the
same instances for the per-request lifetime guarantees to hold.
"""

import threading


class _RequestBucket(threading.local):
    """Per-thread holder for the extraction-scoped LLM caches below.

    Each /api/extract request runs its matching inside a single worker thread
    (``asyncio.to_thread``), so a thread-local bucket gives exactly the
    per-call lifetime the cache docstrings promise — and keeps one
    extraction's LLM guesses from leaking into a later extraction in the
    same process.
    """


def _local_cache(bucket: _RequestBucket) -> dict:
    """Return this thread's cache dict stored on ``bucket``, creating it on
    first access within the thread."""
    cache = getattr(bucket, "store", None)
    if cache is None:
        cache = {}
        bucket.store = cache
    return cache


# Cache of LLM-supplied conversion factors keyed by (analyte, from_unit, to_unit),
# scoped to the current worker thread (one extraction).
_factor_cache = _RequestBucket()

# Cache of unit translations scoped to the current worker thread (one
# match_and_convert call): a shared cache would let one extraction's guess
# (e.g. genetics → empty) poison another's (e.g. microbiome → also empty).
_unit_translation_cache = _RequestBucket()

# Cache of scale-function conversions scoped to the current worker thread
# (one match_and_convert call). Keyed by (analyte, from_unit, to_unit,
# from_kind, to_kind) all lowercased.
_scale_function_cache = _RequestBucket()
