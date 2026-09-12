"""Comparator accommodation: local definition ids compare by their
normalized-name hash suffix (#37 per-user ids vs legacy golden ids)."""

from e2e.compare import _definition_ids_equal


def test_legacy_and_per_user_local_ids_are_equal():
    assert _definition_ids_equal("local-default-0678b465ba33", "local-0678b465ba33")
    assert _definition_ids_equal("local-anon-abc123def456-0678b465ba33", "local-0678b465ba33")
    assert _definition_ids_equal("local-0678b465ba33", "local-0678b465ba33")


def test_different_identity_or_scheme_still_fails():
    assert not _definition_ids_equal("local-default-aabbccddeeff", "local-0678b465ba33")
    assert not _definition_ids_equal("local-0678b465ba33", "4544-3")
    assert not _definition_ids_equal(None, "local-0678b465ba33")
    assert not _definition_ids_equal("local-activated-lymphocytes", "local-0678b465ba33")
