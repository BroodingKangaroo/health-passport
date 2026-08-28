#!/usr/bin/env python3
"""Replay the benchmark's COLD-snapshot path for one case with the OpenRouter
chat provider, dumping the observed record + matcher logs (which the benchmark
swallows silently)."""
# ruff: noqa: E402
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s %(message)s")

from dotenv import load_dotenv

load_dotenv(".env")

CASE = sys.argv[1] if len(sys.argv) > 1 else "рнпц_омр_генетика"

# Replicate main()'s env wiring, then restore the SAME pristine snapshot the
# benchmark children use, and run exactly one case through run_once.
import benchmark.run_benchmark as rb

os.environ["DATABASE_URL"] = f"sqlite:///{os.path.abspath('/tmp/rnpc_replay.db')}"
for suffix in ("", "-wal", "-shm"):
    p = f"/tmp/rnpc_replay.db{suffix}"
    if os.path.exists(p):
        os.remove(p)


rb.restore_snapshot(rb.PRISTINE_DB, "/tmp/rnpc_replay.db")

cases = rb.load_corpus([CASE])
results, metrics, wall = rb.run_once(cases, 0.9, stage_concurrency=1)
observed = results[CASE]["observed"][0]
diffs = results[CASE]["runs_diffs"][0]

print(f"\n=== observed ({len(observed.get('biomarkers', []))} biomarkers)")
for b in observed.get("biomarkers", []):
    print("   ", b.get("raw_name"), "->", b.get("standard_name_en"),
          "|", b.get("standard_value"), "| def:", b.get("definition_id"))
print("\n=== diffs vs golden")
for d in diffs:
    print("   ", d)
print("\n=== metrics:", metrics.to_dict().get("llm_calls"), "llm calls,",
      metrics.to_dict().get("fallback_extractions"), "fallbacks,",
      metrics.to_dict().get("provider_error_calls"), "provider errors")
