"""
Tests for authentication and security fixes.
"""
import json


class TestDataIsolation:
    """Test that users can only access their own data."""

    async def test_timeline_returns_only_user_data(self, client, db_session):
        """Test that timeline only returns data for the authenticated user."""
        from datetime import datetime, timezone

        from app.db.models import MedicalEntry, Patient
        
        # Create a second user
        other_user = Patient(
            id="otheruser",
            email="other@example.com",
            hashed_password="hashed",
            name="Other User",
            dob="1990-01-01",
            gender="Other",
            external_id="HP-OTHER-0001",
        )
        db_session.add(other_user)
        db_session.flush()
        
        # Create an entry for the other user
        other_entry = MedicalEntry(
            id="other-entry",
            patient_id="otheruser",
            type="blood_test",
            date=datetime.fromisoformat("2026-01-01T00:00:00").replace(tzinfo=timezone.utc),
            title="Other User's Test",
            clinic="Other Clinic",
        )
        db_session.add(other_entry)
        db_session.commit()
        
        # Get timeline for test user
        resp = await client.get("/api/timeline")
        assert resp.status_code == 200
        data = resp.json()
        
        # Check that other user's entry is NOT in the timeline
        event_ids = [e["id"] for e in data["events"]]
        assert "other-entry" not in event_ids
        
        # Check that test user's entries ARE in the timeline
        from tests.seed_data import BLOOD_TEST_IDS
        for eid in BLOOD_TEST_IDS:
            assert eid in event_ids

    async def test_flowsheet_returns_only_user_data(self, client, db_session):
        """Test that flowsheet only returns data for the authenticated user."""
        from datetime import datetime, timezone

        from app.db.models import BiomarkerReading, MedicalEntry, Patient
        
        # Create a second user
        other_user = Patient(
            id="otheruser2",
            email="other2@example.com",
            hashed_password="hashed",
            name="Other User 2",
            dob="1990-01-01",
            gender="Other",
            external_id="HP-OTHER-0002",
        )
        db_session.add(other_user)
        db_session.flush()
        
        # Create a blood test entry for the other user
        other_entry = MedicalEntry(
            id="other-blood-test",
            patient_id="otheruser2",
            type="blood_test",
            date=datetime.fromisoformat("2026-01-01T00:00:00").replace(tzinfo=timezone.utc),
            title="Other User's Blood Test",
            clinic="Other Clinic",
        )
        db_session.add(other_entry)
        db_session.flush()
        
        # Add a biomarker reading to it
        db_session.add(BiomarkerReading(
            entry_id="other-blood-test",
            biomarker_id="wbc",
            value=8.5,
            status="normal",
        ))
        db_session.commit()
        
        # Get flowsheet for test user
        resp = await client.get("/api/flowsheet")
        assert resp.status_code == 200
        data = resp.json()
        
        # Check that other user's entry is NOT in the flowsheet dates
        date_labels = [d["label"] for d in data["dates"]]
        # The other user's entry date is 2026-01-01, which would be "Jan 01"
        assert "Jan 01" not in date_labels

    async def test_entry_saved_with_correct_user(self, client, db_session):
        """Test that entries are saved with the authenticated user's ID."""
        from app.db.models import MedicalEntry
        from tests.seed_data import TEST_USER_ID
        
        biomakers_json = json.dumps([
            {
                "id": "cat-1",
                "name": "CBC",
                "rows": [
                    {"id": "wbc", "name": "WBC", "value": "8.5", "unit": "K/µL", "range": "4.0-11.0"},
                ],
            },
        ])
        
        # Save an entry
        resp = await client.post(
            "/api/entry",
            data={
                "type": "blood_test",
                "date": "2026-11-15",
                "clinic": "Test Lab",
                "provider": "Dr. Test",
                "title": "Test Panel",
                "biomarkers": biomakers_json,
            },
        )
        
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["id"]
        
        # Verify the entry was saved with the correct user ID
        entry_id = data["id"]
        entry = db_session.query(MedicalEntry).filter(MedicalEntry.id == entry_id).first()
        assert entry is not None
        assert entry.patient_id == TEST_USER_ID


class TestPathTraversal:
    """Test that file serving prevents path traversal attacks."""

    async def test_path_traversal_blocked(self, client, db_session):
        """Test that path traversal attempts are blocked."""
        from fastapi.testclient import TestClient

        from app.api.auth import get_current_user_or_anon
        from app.db.models import Patient
        from app.main import app
        from tests.seed_data import TEST_USER_EMAIL, TEST_USER_ID

        # Create a test client
        test_client = TestClient(app)

        async def override_get_user_or_anon():
            # Must override the dependency serve_upload actually uses.
            return (Patient(id=TEST_USER_ID, email=TEST_USER_EMAIL), TEST_USER_ID, False)

        original_dep = app.dependency_overrides.get(get_current_user_or_anon)
        app.dependency_overrides[get_current_user_or_anon] = override_get_user_or_anon

        try:
            # Test that paths starting with / are blocked
            resp = test_client.get("/static/uploads//etc/passwd")
            # The double slash should be normalized, but the path param will be /etc/passwd
            # which starts with / and should be blocked
            assert resp.status_code == 403, f"Path starting with / not blocked, got {resp.status_code}"
            
            # Test that paths with .. are blocked (if they somehow get through)
            # Note: FastAPI's path routing normalizes .. at the routing level,
            # so these will typically result in 404. Our check provides defense in depth.
            resp = test_client.get("/static/uploads/../etc/passwd")
            # This should be blocked or return 404
            assert resp.status_code in [403, 404], f"Path with .. not properly handled, got {resp.status_code}"
        finally:
            if original_dep:
                app.dependency_overrides[get_current_user_or_anon] = original_dep
            else:
                app.dependency_overrides.pop(get_current_user_or_anon, None)

    async def test_valid_path_returns_404(self, client, db_session):
        """Test that valid paths return 404 (file not found) not 403."""
        from fastapi.testclient import TestClient

        from app.api.auth import get_current_user_or_anon
        from app.db.models import Patient
        from app.main import app
        from tests.seed_data import TEST_USER_EMAIL, TEST_USER_ID

        test_client = TestClient(app)

        async def override_get_user_or_anon():
            return (Patient(id=TEST_USER_ID, email=TEST_USER_EMAIL), TEST_USER_ID, False)

        original_dep = app.dependency_overrides.get(get_current_user_or_anon)
        app.dependency_overrides[get_current_user_or_anon] = override_get_user_or_anon

        try:
            # Valid path should return 404 (file not found) not 403
            resp = test_client.get("/static/uploads/valid-file.txt")
            assert resp.status_code == 404  # File doesn't exist, but path is valid
        finally:
            if original_dep:
                app.dependency_overrides[get_current_user_or_anon] = original_dep
            else:
                app.dependency_overrides.pop(get_current_user_or_anon, None)
