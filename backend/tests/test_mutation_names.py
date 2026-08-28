"""iter1: deterministic EN display word-order for gene-mutation names.

The batch translator flips between "(9 exon" and "(exon 9" across calls
(bimodal on рнпц_омр_генетика); the matcher must canonicalize so stored
definitions / displayed standard_name_en never flap.
"""

import pytest

from app.services.matcher.name_matching import canonicalize_gene_mutation_en


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # translator order A -> canonical
        ("CALR gene mutation (9 exon", "CALR gene mutation (exon 9"),
        # translator order B already canonical
        ("CALR gene mutation (exon 9", "CALR gene mutation (exon 9"),
        # multi-part mutation suffix preserved
        (
            "JAK2 gene mutation (exon 14; V617F",
            "JAK2 gene mutation (exon 14; V617F",
        ),
        (
            "JAK2 gene mutation (14 exon; V617F",
            "JAK2 gene mutation (exon 14; V617F",
        ),
        # idempotent
        ("MPL gene mutation (exon 10", "MPL gene mutation (exon 10"),
        # non-mutation names untouched
        ("CD3+ T-lymphocytes, %", "CD3+ T-lymphocytes, %"),
        ("Lymphocytes", "Lymphocytes"),
        # empty safe
        ("", ""),
        (None, None),  # type: ignore[arg-type]
    ],
)
def test_canonicalize_gene_mutation_en(raw, expected):
    assert canonicalize_gene_mutation_en(raw) == expected
