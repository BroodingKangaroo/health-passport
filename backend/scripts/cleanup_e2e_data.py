import os
import sqlite3

db_paths = [
    os.path.join(os.path.dirname(__file__), '..', 'health_passport.db'),
    os.path.join(os.path.dirname(__file__), '..', 'e2e_test.db'),
]

for db_path in db_paths:
    db_path = os.path.normpath(db_path)
    if not os.path.exists(db_path):
        print(f"cleanup: {db_path} does not exist, skipping")
        continue

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute("DELETE FROM medical_entries WHERE clinic LIKE 'E2E %'")
        deleted = cursor.rowcount
        conn.commit()
        conn.close()
        print(f"cleanup: Deleted {deleted} e2e entries from {os.path.basename(db_path)}")
    except Exception as e:
        print(f"cleanup: Error on {db_path}: {e}")
