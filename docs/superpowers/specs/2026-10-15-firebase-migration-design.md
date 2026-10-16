# Firestore Migration Design

**Date:** 2026-10-15
**Status:** Implemented
**Goal:** Replace the file-based SQLite database (`data/app.db`) with Cloud Firestore so application data survives Render restarts and redeploys, without changing any user-visible behavior.

## Background and motivation

The app persists in a single SQLite file via Node 24's built-in `node:sqlite` driver (`server.js:7`, `server.js:18`). `render.yaml` documents the problem: the Render free plan has no persistent disk, so `./data` is wiped on every restart or redeploy. The chosen fix is Firestore — a hosted, durable database outside the deployment box.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Why move | Data must survive Render restarts |
| Existing `data/app.db` rows | **Start fresh**, no migration script |
| Authentication | **Keep** bcrypt + express-session exactly as today; no Firebase Auth |
| File uploads (`uploads/`) | **Stay on disk**, out of scope (known limitation) |
| Firebase product | **Firestore** via `firebase-admin` (Realtime DB ruled out: cannot express the app's filtered/ordered queries) |
| Persistence fallback | **None** — single path to Firestore; `node:sqlite` is removed entirely |

## Non-goals

- Firebase Auth, Firebase Storage, Firebase Hosting, realtime listeners, offline persistence
- Migrating historical data from `data/app.db`
- Changing any HTTP route, response shape, session/cookie behavior, or front-end code
- Persisting uploaded files (remains `./uploads/` on disk)

## Architecture

### Components

1. **`db.js` (new)** — Firestore client initialization plus small persistence helpers:
   - `insertWithId(collection, data)` — transaction: increments the collection's counter doc, writes the doc with the next integer ID, returns the ID
   - `getById(collection, id)` — direct key lookup: documents are stored with **document ID = `String(id)`**, so this is one `doc(String(id)).get()` with no query or index involved
   - `updateById(collection, id, patch)` — writes the patch only when the doc exists; returns `false` on a missing doc (silent no-op). This is exact SQLite parity: today's `UPDATE ... WHERE id=?` on a missing row affects 0 rows yet the route still answers `{ ok: true }` — routes never 404 on updates.
   - `removeById(collection, id)`
   - `fetchAll(collection)` / `whereEq(collection, field, value)` / `getOne(collection, field, value)` — reads; compound predicates (LIKE, `substr`, `date()`, multi-key `ORDER BY`, pagination) are applied in memory at call sites, so every Firestore query stays single-field and **no composite indexes are needed**
   - `balanceRef`/`balanceDocId`/`readBalanceTx` — composite-key (`employeeId_leaveTypeId`) balance access used inside transactions
   - `getDoc`/`setDoc`/`setIfAbsent`/`createIfAbsentBy` — doc-ID-keyed writes: `system_settings` keyed by `key`, `INSERT OR IGNORE` parity for unique-field reference rows
   - `nowText()`/`todayISO()` — SQLite `datetime('now')`/`date('now')` string parity (`'YYYY-MM-DD HH:MM:SS'` UTC / `'YYYY-MM-DD'`)
   - JOIN replacement: read-time hydration — `fetchAll` + id→row `Map`s (or `getById` for single-doc joins); multi-write flows (application + approval + balance) run inside `db.runTransaction`
2. **`server.js`** — keeps all routes, middleware, auth, session, upload, and seed logic. The 108 `db.prepare(...)` call sites are rewritten in place to call `db.js` helpers. No route restructuring.
3. **Firestore emulator** — local/CI database. Selected automatically when `FIRESTORE_EMULATOR_HOST` is set; no credentials involved.

### Initialization order in `server.js`

1. If `FIRESTORE_EMULATOR_HOST` is set → `initializeFirestore({ projectId: 'demo-leavems' })` against the emulator.
2. Else if `FIREBASE_SERVICE_ACCOUNT` env var is set (JSON string) → `cert(JSON.parse(...))`.
3. Else → **fail fast at boot** with a clear error message naming both options. The process must not start half-configured.

### Credentials

- **Local dev and all check scripts:** emulator, project ID `demo-leavems` (the `demo-` prefix is Firebase's guarantee that no real Google services are ever contacted).
- **Render:** `FIREBASE_SERVICE_ACCOUNT` env var (secret), containing the service-account JSON for the user's Firebase project. User-side prerequisite: create the Firebase project and download the key — guided at deploy time.

## Data model

- **13 tables → 13 top-level collections.** Collection names equal today's table names (`users`, `employees`, `departments`, `leave_types`, `leave_balances`, `leave_balance_transactions`, `leave_applications`, `leave_approvals`, `supporting_documents`, `notifications`, `audit_logs`, `holidays`, `system_settings`).
- **Field names stay snake_case** — identical to column names, so call-site rewrites are mechanical.
- **Integer IDs are preserved** (API compatibility). A `counters` collection holds one doc per collection; every insert increments it inside the same transaction that writes the document. This replaces `last_insert_rowid` (`server.js:219`).
- **Dates remain ISO-8601 strings**; JSON columns (`extra_details` and similar) remain JSON strings. No Firestore `Timestamp` conversion — responses stay byte-compatible with today's.
- **Document `id` field:** counter-backed collections carry an `id` number field matching their logical ID (written by `insertWithId`), so existing response mapping is untouched. Two exceptions store no `id` field, preserving today's response shapes exactly: `leave_balances` (doc ID = `employeeId_leaveTypeId`) and `system_settings` (doc ID = `key`) — neither table has an `id` column today.

### Query mapping (108 call sites)

| SQL pattern (count) | Firestore mapping |
|---|---|
| `SELECT ... WHERE id=?` | `getById` |
| `INSERT` + `last_insert_rowid` | `insertWithId` (counter transaction) |
| `UPDATE ... WHERE id=?` | `updateById` (missing doc → silent no-op returning `false`; routes keep answering `{ ok: true }`) |
| `DELETE ... WHERE id=?` | `removeById` |
| `WHERE`/`ORDER BY` lists (16 `ORDER BY`) | `fetchAll` + in-memory predicate/sort (replicates the dynamic `${where}` builders at `server.js:398`, `server.js:698`) |
| `COUNT(*)` (incl. status aggregates `server.js:490-493,515,527,684`) | `.length` over `fetchAll`/`whereEq` results (single-field filter first) |
| `INSERT OR IGNORE` (6) | `create()`-style write catching `ALREADY_EXISTS` |
| JOINs (35) | read-time hydration (`fetchAll` + id→row `Map`s / `getById`) — no denormalized copies, single source of truth |
| Multi-write flows (balance debit + approval + status change) | Firestore **transaction** — hardening: today's SQL uses zero transactions |

## Seed and bootstrap

`seed()` keeps its exact current contract, rewritten over Firestore:

- On boot: create reference rows (`system_settings` defaults, `leave_types`, `holidays`) idempotently.
- If users exist → stop (same early return as `server.js:161`).
- Prod + `ADMIN_EMAIL`/`ADMIN_PASSWORD` set → bootstrap `sys_admin` + employee row + starter balances, audit `admin_bootstrapped`.
- Prod without env vars → same warning, no seed.
- Dev → demo accounts, sample leave application, audit `seed` — same log lines as today.

## Testing strategy

- **Invocation:** every check that spawns the server runs under the emulator wrapper:

  ```
  npx firebase emulators:exec --only firestore --project demo-leavems "node <check>.js"
  ```

  `emulators:exec` sets `FIRESTORE_EMULATOR_HOST` for the child process. **Requirement: every check run sees an empty database.** Mechanism: the check wrapper clears the emulator first via its REST endpoint (`DELETE http://127.0.0.1:8080/v1/projects/demo-leavems/databases/(default)/documents`) — correct regardless of whether the installed emulator version retains data across runs. This permanently eliminates the DB-state class of failure (e.g. today's `prodcheck` demo-user pollution).
- `apitest.js`: static/source-level — **no changes** (its `trust proxy` regex must keep matching `server.js`, which the conversion preserves verbatim).
- `smoketest.js`, `pwacheck.js`, `dlcheck.js`: script content unchanged — but all three **spawn `server.js`**, so all three run under the emulator wrapper. After the switch, `smoketest`'s pre-existing `submit leave` overlap failure disappears (fresh DB each run): expected output becomes 23 `PASS` / 0 `FAIL`.
- `prodcheck.js`: emulator wrapper plus one test-only fix — send `X-Forwarded-Proto: https` on its requests, resolving the pre-existing `prod admin stats 401` (proven pre-existing at `79f49b9`; root cause is `secure` cookies over plain HTTP). It must otherwise keep its production env vars (`NODE_ENV`, `ADMIN_EMAIL`, `SESSION_SECRET`).
- `tunnelcheck.js`: also spawns `server.js`, so it must run under the same emulator wrapper, but it additionally requires a `/tmp/cloudflared` binary that is environment-dependent (Unix path). It is **not** part of the migration success criteria — excluded exactly as it is today.
- New devDependency: `firebase-tools`. Runtime dependency: `firebase-admin`. Java 21 (already installed) hosts the emulator.

## Error handling

- Firestore `NOT_FOUND` / `updateById` miss → today's 404 responses.
- Missing configuration at boot (no emulator host, no service account) → process exits with a clear message; Render health check fails visibly rather than serving an app with no database.
- Other Firestore errors propagate to the existing Express error handling; routes keep their current try/catch shapes.

## Deployment

- `render.yaml`: add `FIREBASE_SERVICE_ACCOUNT` (`sync: false` secret); replace the stale SQLite-disk commentary with a pointer to Firestore.
- **Indexes:** the design keeps every query single-field (compound filtering happens in memory), so `firestore.indexes.json` stays empty and there are no composite indexes to deploy. **Chosen order:** final verification runs the check suite once against real Firestore with real credentials before Render is switched over.
- `package.json`: add `firebase-admin`, `firebase-tools`.
- `data/app.db` and the `node:sqlite` require are removed from code; the ignored `data/` directory becomes a legacy artifact.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| 108 call-site rewrite introduces subtle behavior changes | Mechanical pattern mapping table (above); full check suite must go green; no route/response restructuring allowed |
| Composite indexes missing on real Firestore | `firestore.indexes.json` + mandatory deploy-time query verification step |
| ID counter races | Counter increment runs inside the insert transaction |
| Emulator vs production behavioral drift | Same code path, only the transport differs; deploy-time smoke test against real project |
| Vendor lock-in | Accepted trade-off (single hosted requirement was the goal) |
| Login latency increase (remote DB) | Acceptable at this scale; bcrypt work dominates login cost anyway |

## Success criteria

1. The five check scripts (`smoketest`, `apitest`, `pwacheck`, `prodcheck`, `dlcheck`) pass under the emulator wrapper — `prodcheck` fully green, including the previously failing `prod admin stats`. (`tunnelcheck` stays excluded: environment-dependent on a `/tmp/cloudflared` binary, unchanged by this work.)
2. Browser portal, `/app.html` employee gate, admin block, PWA, and Funnel entry behave identically to before (no front-end diffs).
3. No `node:sqlite` reference remains anywhere in the repo.
4. Server fails fast with a clear message when neither emulator nor credentials are configured.
5. Fresh dev boot seeds demo data; fresh prod boot bootstraps the admin from env vars.
