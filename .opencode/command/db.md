---
description: Read-only SQL query against the dev sqlite DB (never mutates).
---

# Query the dev database

Run `$ARGUMENTS` as a single read-only SQLite query:

```
sqlite3 -readonly backend/health_passport.db "$ARGUMENTS"
```

- `-readonly` is mandatory — this command must never mutate data. If a write
  seems needed, stop and ask the user instead.
- Assumes the default `DATABASE_URL` (`sqlite:///./health_passport.db`). If
  the user set a different `DATABASE_URL`, ask for the path rather than
  guessing.
- Useful when `$ARGUMENTS` is empty or for orientation:
  - List tables: `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;`
  - Columns of a table: `PRAGMA table_info(<table>);` (run via the same
    sqlite3 invocation).
- Prefer narrow queries (`LIMIT`, explicit columns) over `SELECT *` dumps;
  summarize results instead of pasting large tables back.
