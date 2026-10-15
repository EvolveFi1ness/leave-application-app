# Firestore Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the file-based SQLite database (`data/app.db`) with Cloud Firestore so application data survives Render restarts and redeploys, without changing any user-visible behavior.

**Architecture:** A new `db.js` module wraps `firebase-admin` Firestore with small helpers that mirror the app's SQL patterns (counter-backed integer IDs, doc-ID-keyed lookups, COALESCE-parity updates). The 108 `db.prepare(...)` call sites in `server.js` are rewritten in place to call these helpers; multi-write flows (submit, cancel, review, balance adjust) move into Firestore transactions. Local development and all check scripts run against the Firestore emulator (`demo-leavems`); production runs against real Firestore via a `FIREBASE_SERVICE_ACCOUNT` secret on Render. `node:sqlite` and `data/app.db` are removed entirely — there is no fallback path.

**Tech Stack:** Node 24, Express 4, express-session, bcryptjs, multer, `firebase-admin` (runtime), `firebase-tools` (devDependency, emulator host; Java 21 already installed).

**Spec:** `docs/superpowers/specs/2026-10-15-firebase-migration-design.md` (committed `517298d`, `b9ce017`, `17c4574`). This plan implements it; the spec is the source of truth for decisions.

## Global Constraints

- Zero user-visible behavior change: no route, response-shape, session/cookie, or front-end (`public/`) change. `public/js/admin.js` and `public/js/api.js` payloads stay byte-compatible.
- `app.set('trust proxy', 1);` stays verbatim and unconditional at `server.js` — apitest.js regex `app\.set\(\s*'trust proxy',\s*1\s*\)` must keep matching; do not gate it behind `isProd`.
- Field names in Firestore documents are snake_case, identical to today's SQLite column names.
- Integer IDs preserved via a `counters` collection; counter-backed docs carry a numeric `id` field matching their logical ID. Exceptions with NO `id` field (exact response-shape parity): `leave_balances` (doc ID = `${employeeId}_${leaveTypeId}`) and `system_settings` (doc ID = key).
- Dates remain ISO-8601 strings; JSON columns (`extra_details`) remain JSON strings. No Firestore `Timestamp` conversion.
- Every Firestore query stays single-field; compound predicates (LIKE, substr, date(), multi-key ORDER BY, pagination) are applied in memory. `firestore.indexes.json` is empty — no composite indexes.
- All reads inside a Firestore transaction happen before any writes (Firestore hard requirement).
- Auth stays bcrypt + express-session; no Firebase Auth. Uploads stay on disk in `./uploads/`; out of scope.
- Emulator project ID is `demo-leavems` (the `demo-` prefix guarantees no real Google services are contacted).
- Check-suite ports: smoketest/pwacheck/dlcheck spawn on 3000 (default), prodcheck 3001, admintest 3002.
- Tunnelcheck.js stays excluded from success criteria (environment-dependent `/tmp/cloudflared` binary).
- `LeaveMS-android/` is untouched.
- Node/PowerShell 5.1 environment: use `;` not `&&` in shell commands executed by the agent; `npm run` scripts run under cmd so `&&` inside package.json script strings is valid.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `db.js` | Create | Firestore init (fail-fast), persistence helpers, time parity, async handler wrapper |
| `emuclear.js` | Create | Clears all documents from the emulator via REST before each check run |
| `dbtest.js` | Create | 36 checks against `db.js` helpers (no server spawn) |
| `admintest.js` | Create | 40 checks: HR admin flows (stats, filters, review, employees, balances, holidays, types, audit, reports, export, RBAC) |
| `server.js` | Rewrite | All 108 `db.prepare` call sites → `db.js` helpers; seed → async; `app.listen` → async boot after `await seed()`; `node:sqlite`/schema/`DATA_DIR`/`balanceAfter` removed |
| `prodcheck.js` | Modify | Add `X-Forwarded-Proto: https` header to all fetches (fixes pre-existing secure-cookie 401) |
| `package.json` | Modify | Add `firebase-admin` dep, `firebase-tools` devDep, `test:*` scripts |
| `firebase.json` | Create | Firestore emulator config (port 8080) |
| `firestore.rules` | Create | Deny-all rules (Admin SDK bypasses rules) |
| `firestore.indexes.json` | Create | Empty object `{}` |
| `render.yaml` | Modify | Add `FIREBASE_SERVICE_ACCOUNT` secret; replace stale SQLite-disk commentary |
| `.gitignore` | Modify | Add `serviceAccount.json`, firebase log files |
| `smoketest.js`, `apitest.js`, `pwacheck.js`, `dlcheck.js` | Unchanged | Content identical; wrapped by npm scripts under emulator |

---

## Task 1: Firestore Persistence Layer

Installs dependencies, creates emulator config, and builds `db.js` + its test harness. After this task, `db.js` is proven against the emulator without touching `server.js` (which still runs SQLite — both can coexist until Task 3).

**Files:**
- Create: `db.js`, `emuclear.js`, `dbtest.js`, `firebase.json`, `firestore.rules`, `firestore.indexes.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: env `FIRESTORE_EMULATOR_HOST` (set by `emulators:exec`), env `FIREBASE_SERVICE_ACCOUNT` (Render, later task)
- Produces (exact exports of `db.js`, consumed by `server.js` in Task 3 and by `dbtest.js` here):
  - `db` — initialized Firestore instance
  - `nowText()` → `'YYYY-MM-DD HH:MM:SS'` (UTC), `todayISO()` → `'YYYY-MM-DD'` (UTC)
  - `nextIdsTx(tx, collections: string[])` → `Promise<Record<string, number>>` (read-only; call FIRST in a transaction)
  - `insertIntoTx(tx, collection, id, data)` → `void` (write-only: counter + doc with `id` field appended)
  - `nextIdTx(tx, collection)` → `Promise<number>` (single-collection read+write; only when it is the first/only counter op)
  - `insertWithId(collection, data)` → `Promise<number>` (standalone transaction wrapper; returns new integer id)
  - `getDoc(collection, docId)` / `getById(collection, id)` → `Promise<object|null>`
  - `setDoc(collection, docId, data)` → `Promise<void>`; `setIfAbsent(collection, docId, data)` → `Promise<void>`
  - `updateById(collection, id, patch)` → `Promise<boolean>` (skips undefined/null fields = COALESCE parity; missing doc → `false`; empty patch on existing → `true`, no write)
  - `removeById(collection, id)` → `Promise<void>`
  - `fetchAll(collection)` → `Promise<object[]>` (numeric `id` sort; doc-ID-keyed collections sort by doc ID)
  - `whereEq(collection, field, value)` → `Promise<object[]>`; `getOne(collection, field, value)` → `Promise<object|null>`
  - `getSetting(key, fallback)` / `putSetting(key, value)` / `getAllSettings()` → settings helpers over the `system_settings` collection
  - `createIfAbsentBy(collection, field, value, data)` → `Promise<object>` (INSERT OR IGNORE parity for unique-field reference rows)
  - `balanceDocId(employeeId, leaveTypeId)` → `` `${employeeId}_${leaveTypeId}` ``; `balanceRef(employeeId, leaveTypeId)` → DocumentReference; `readBalanceTx(tx, employeeId, leaveTypeId)` → `Promise<{earned,used,pending}>` (defaults `{0,0,0}`)
  - `setBalanceTx(tx, employeeId, leaveTypeId, fields)` → `void` (merge-write inside a transaction)
  - `ah(fn)` — async Express handler wrapper: `(req,res,next) => fn(req,res,next).catch(next)`

- [ ] **Step 1: Install dependencies**

Run: `npm install firebase-admin; npm install -D firebase-tools`
Expected: `package.json` gains `"firebase-admin": "^13.0.0"` in dependencies and `"firebase-tools": "^15.0.0"` in devDependencies (exact patch versions may differ; majors must match). This downloads ~80MB — allow a few minutes.

- [ ] **Step 2: Create `firebase.json`**

```json
{
  "emulators": {
    "firestore": { "host": "127.0.0.1", "port": 8080 },
    "singleProjectMode": true
  }
}
```

- [ ] **Step 3: Create `firestore.rules`**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

(The Admin SDK bypasses rules; deny-all is correct — no client SDKs exist in this app.)

- [ ] **Step 4: Create `firestore.indexes.json`**

```json
{}
```

- [ ] **Step 5: Add npm test scripts to `package.json`**

Replace the `scripts` block with:

```json
"scripts": {
  "start": "node server.js",
  "test:api": "node apitest.js",
  "test:db": "firebase emulators:exec --only firestore --project demo-leavems \"node emuclear.js && node dbtest.js\"",
  "test:smoke": "firebase emulators:exec --only firestore --project demo-leavems \"node emuclear.js && node smoketest.js\"",
  "test:admin": "firebase emulators:exec --only firestore --project demo-leavems \"node emuclear.js && node admintest.js\"",
  "test:prod": "firebase emulators:exec --only firestore --project demo-leavems \"node emuclear.js && node prodcheck.js\"",
  "test:pwa": "firebase emulators:exec --only firestore --project demo-leavems \"node emuclear.js && node pwacheck.js\"",
  "test:dl": "firebase emulators:exec --only firestore --project demo-leavems \"node emuclear.js && node dlcheck.js\""
}
```

(`emulators:exec` sets `FIRESTORE_EMULATOR_HOST` for the child; `node_modules/.bin` is on PATH under npm scripts, so `firebase` resolves to the devDependency. `test:api` needs no server/DB — apitest is source-level.)

- [ ] **Step 6: Create `emuclear.js`**

```js
// Clears every document from the local Firestore emulator so each check run
// starts from an empty database (REST delete is version-independent).
const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const url = `http://${host}/v1/projects/demo-leavems/databases/(default)/documents`;
fetch(url, { method: 'DELETE' })
  .then(async r => {
    if (!r.ok) { console.error('emuclear: clear failed', r.status, await r.text()); process.exit(1); }
    console.log('emuclear: emulator database cleared');
    process.exit(0);
  })
  .catch(e => { console.error('emuclear:', e.message); process.exit(1); });
```

- [ ] **Step 7: Write the failing test — create `dbtest.js`**

The full `dbtest.js` listing is in Task 1 Step 7 continued below (it is long; it is the complete file — write it verbatim).

```js
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const assert = require('assert');
const {
  db, nowText, todayISO, nextIdsTx, insertIntoTx, insertWithId,
  getDoc, getById, setDoc, setIfAbsent, updateById, removeById,
  fetchAll, whereEq, getOne, getSetting, putSetting, getAllSettings,
  createIfAbsentBy, balanceDocId, balanceRef, readBalanceTx, setBalanceTx, ah
} = require('./db');

const results = [];
const ck = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`);

(async () => {
  try {
    // --- nowText / todayISO (2) ---
    ck('nowText format', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(nowText()), nowText());
    ck('todayISO format', /^\d{4}-\d{2}-\d{2}$/.test(todayISO()), todayISO());

    // --- insertWithId / getById / id field (4) ---
    const id1 = await insertWithId('t_items', { name: 'first', n: 1 });
    ck('insertWithId returns 1', id1 === 1, String(id1));
    const id2 = await insertWithId('t_items', { name: 'second', n: 2 });
    ck('insertWithId increments counter', id2 === 2, String(id2));
    const g1 = await getById('t_items', id1);
    ck('getById round-trip + id field', g1 && g1.id === 1 && g1.name === 'first', JSON.stringify(g1));
    ck('getById missing → null', (await getById('t_items', 999)) === null);

    // --- updateById COALESCE parity (4) ---
    const u1 = await updateById('t_items', id1, { name: 'renamed', n: null, missing: undefined });
    const g1b = await getById('t_items', id1);
    ck('updateById patches + skips null/undefined', u1 === true && g1b.name === 'renamed' && g1b.n === 1 && !('missing' in g1b), JSON.stringify(g1b));
    const uEmpty = await updateById('t_items', id1, { n: null });
    ck('updateById empty effective patch → true, no change', uEmpty === true && (await getById('t_items', id1)).n === 1);
    const uMissing = await updateById('t_items', 999, { name: 'x' });
    ck('updateById missing doc → false', uMissing === false);
    await updateById('t_items', id1, { n: 0 });
    ck('updateById writes falsy 0', (await getById('t_items', id1)).n === 0);

    // --- removeById (2) ---
    await removeById('t_items', id2);
    ck('removeById deletes', (await getById('t_items', id2)) === null);
    ck('removeById missing is silent', await removeById('t_items', 999).then(() => true));

    // --- fetchAll / whereEq / getOne (5) ---
    const all = await fetchAll('t_items');
    ck('fetchAll returns rows', all.length === 1 && all[0].id === 1, `len=${all.length}`);
    ck('fetchAll empty collection → []', (await fetchAll('t_empty')).length === 0);
    await insertWithId('t_items', { name: 'other', flag: 1 });
    const w = await whereEq('t_items', 'flag', 1);
    ck('whereEq filters', w.length === 1 && w[0].name === 'other', `len=${w.length}`);
    ck('whereEq no match → []', (await whereEq('t_items', 'flag', 42)).length === 0);
    ck('getOne first match / null', (await getOne('t_items', 'name', 'other')) !== null && (await getOne('t_items', 'name', 'nope')) === null);

    // --- setDoc / getDoc / setIfAbsent (3) ---
    await setDoc('t_kv', 'k1', { key: 'k1', value: 'a' });
    ck('setDoc/getDoc round-trip', (await getDoc('t_kv', 'k1')).value === 'a');
    await setIfAbsent('t_kv', 'k1', { key: 'k1', value: 'b' });
    ck('setIfAbsent keeps existing', (await getDoc('t_kv', 'k1')).value === 'a');
    await setIfAbsent('t_kv', 'k2', { key: 'k2', value: 'c' });
    ck('setIfAbsent writes missing', (await getDoc('t_kv', 'k2')).value === 'c');

    // --- settings helpers (4) ---
    ck('getSetting fallback', (await getSetting('nope', '500')) === '500');
    await putSetting('char_limit', 500);
    ck('putSetting stringifies + getSetting round-trip', (await getSetting('char_limit')) === '500');
    await putSetting('org_name', 'Acme');
    const allS = await getAllSettings();
    ck('getAllSettings object', allS.char_limit === '500' && allS.org_name === 'Acme', JSON.stringify(allS));
    const sdoc = await getDoc('system_settings', 'char_limit');
    ck('settings doc shape {key,value}, no id field', sdoc.key === 'char_limit' && sdoc.value === '500' && !('id' in sdoc), JSON.stringify(sdoc));

    // --- createIfAbsentBy (3) ---
    const d1 = await createIfAbsentBy('t_depts', 'name', 'Engineering', { name: 'Engineering' });
    const d2 = await createIfAbsentBy('t_depts', 'name', 'Engineering', { name: 'Engineering' });
    ck('createIfAbsentBy creates then no-ops', d1.id === d2.id && d1.name === 'Engineering', JSON.stringify(d1));
    ck('createIfAbsentBy assigns id field', typeof d1.id === 'number');
    ck('createIfAbsentBy second unique row', (await createIfAbsentBy('t_depts', 'name', 'Finance', { name: 'Finance' })).name === 'Finance');

    // --- transactions: reads-before-writes (5) ---
    const ids = await db.runTransaction(async tx => {
      const next = await nextIdsTx(tx, ['t_tx']);
      insertIntoTx(tx, 't_tx', next.t_tx, { label: 'a' });
      return next.t_tx;
    });
    ck('nextIdsTx+insertIntoTx in transaction', ids === 1, String(ids));
    const ids2 = await db.runTransaction(async tx => {
      const next = await nextIdsTx(tx, ['t_tx', 't_ty']);
      insertIntoTx(tx, 't_tx', next.t_tx, { label: 'b' });
      insertIntoTx(tx, 't_ty', next.t_ty, { label: 'c' });
      return next;
    });
    ck('nextIdsTx batch of collections', ids2.t_tx === 2 && ids2.t_ty === 1, JSON.stringify(ids2));
    const txDoc = await getById('t_tx', 1);
    ck('insertIntoTx appends id field', txDoc && txDoc.id === 1 && txDoc.label === 'a', JSON.stringify(txDoc));
    const nid = await db.runTransaction(async tx => nextIdTx(tx, 't_nid'));
    ck('nextIdTx single collection', nid === 1, String(nid));
    const cdoc = await getDoc('counters', 't_tx');
    ck('counter doc holds last issued id', cdoc && cdoc.value === 2, JSON.stringify(cdoc));

    // --- balance helpers (4) ---
    ck('balanceDocId format', balanceDocId(7, 3) === '7_3', balanceDocId(7, 3));
    await db.runTransaction(async tx => {
      const bal = await readBalanceTx(tx, 7, 3);
      setBalanceTx(tx, 7, 3, { earned: bal.earned + 25, used: bal.used, pending: bal.pending });
    });
    await db.runTransaction(async tx => {
      const bal = await readBalanceTx(tx, 7, 3);
      setBalanceTx(tx, 7, 3, { earned: bal.earned, used: bal.used, pending: bal.pending + 4 });
    });
    const bal = await db.runTransaction(async tx => readBalanceTx(tx, 7, 3));
    ck('readBalanceTx defaults when missing', (await db.runTransaction(async tx => readBalanceTx(tx, 8, 1))).earned === 0);
    ck('setBalanceTx/readBalanceTx round-trip', bal.earned === 25 && bal.pending === 4 && bal.used === 0, JSON.stringify(bal));
    const bdoc = await getDoc('leave_balances', balanceDocId(7, 3));
    ck('balance doc shape: employee_id/leave_type_id, no id field', bdoc.employee_id === 7 && bdoc.leave_type_id === 3 && !('id' in bdoc), JSON.stringify(bdoc));
    ck('balanceRef doc path', balanceRef(7, 3).path === 'leave_balances/7_3', balanceRef(7, 3).path);

    // --- ah wrapper (2) ---
    let called = null;
    const mw = ah(async (req, res) => { throw new Error('boom'); });
    await mw({}, {}, e => { called = e; });
    ck('ah forwards rejection to next', called && called.message === 'boom', String(called && called.message));
    let okNext = false;
    const mw2 = ah(async (req, res, next) => { next(); });
    await mw2({}, {}, () => { okNext = true; });
    ck('ah passes through success', okNext);

    console.log(results.join('\n'));
    const fails = results.filter(l => l.startsWith('FAIL')).length;
    console.log(`--- dbtest: ${results.length - fails} PASS / ${fails} FAIL ---`);
    process.exit(fails ? 1 : 0);
  } catch (e) {
    console.log(results.join('\n'));
    console.log('FAIL exception ' + e.message);
    process.exit(1);
  }
})();
```

- [ ] **Step 8: Run `dbtest.js` to verify it fails for the right reason**

Run: `node dbtest.js`
Expected: Node throws `Cannot find module './db'` (or, if run without the emulator, `db.js` does not exist yet). This is the failing-test gate.

- [ ] **Step 9: Implement `db.js`**

```js
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// ---------- init (fail fast when unconfigured) ----------
if (process.env.FIRESTORE_EMULATOR_HOST) {
  initializeApp({ projectId: 'demo-leavems' });
} else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
} else {
  console.error('FATAL: No Firestore configuration. Set FIRESTORE_EMULATOR_HOST (emulator) or FIREBASE_SERVICE_ACCOUNT (production JSON key).');
  process.exit(1);
}
const db = getFirestore();

// ---------- time parity with SQLite datetime('now') / date('now') ----------
function nowText() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function todayISO() { return new Date().toISOString().slice(0, 10); }

// ---------- counter-backed integer IDs ----------
// Counters live in the `counters` collection: doc id = collection name, field `value`.
// All reads inside a transaction MUST happen before any writes (Firestore rule).
async function nextIdsTx(tx, collections) {
  const out = {};
  for (const c of collections) {
    const snap = await tx.get(db.collection('counters').doc(c));
    out[c] = (snap.exists ? snap.data().value : 0) + 1;
  }
  return out;
}
function insertIntoTx(tx, collection, id, data) {
  tx.set(db.collection('counters').doc(collection), { value: id });
  tx.set(db.collection(collection).doc(String(id)), { ...data, id });
}
async function nextIdTx(tx, collection) {
  const ids = await nextIdsTx(tx, [collection]);
  insertIntoTx(tx, collection, ids[collection], {});
  // caller is expected to have written the real doc via insertIntoTx; this
  // variant only exists for counter allocation. Prefer insertWithId.
  return ids[collection];
}
async function insertWithId(collection, data) {
  return db.runTransaction(async tx => {
    const ids = await nextIdsTx(tx, [collection]);
    insertIntoTx(tx, collection, ids[collection], data);
    return ids[collection];
  });
}

// ---------- doc-id-keyed access ----------
async function getDoc(collection, docId) {
  const snap = await db.collection(collection).doc(String(docId)).get();
  return snap.exists ? snap.data() : null;
}
const getById = getDoc;
async function setDoc(collection, docId, data) {
  await db.collection(collection).doc(String(docId)).set(data);
}
async function setIfAbsent(collection, docId, data) {
  await db.runTransaction(async tx => {
    const ref = db.collection(collection).doc(String(docId));
    const snap = await tx.get(ref);
    if (!snap.exists) tx.set(ref, data);
  });
}

// ---------- id-keyed update/delete with SQLite UPDATE parity ----------
// COALESCE parity: skip undefined/null fields. Missing doc -> false (routes still answer {ok:true}).
async function updateById(collection, id, patch) {
  const clean = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null) clean[k] = v;
  const ref = db.collection(collection).doc(String(id));
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    if (Object.keys(clean).length) tx.set(ref, clean, { merge: true });
    return true;
  });
}
async function removeById(collection, id) {
  await db.collection(collection).doc(String(id)).delete();
}

// ---------- list reads (compound predicates applied in memory at call sites) ----------
async function fetchAll(collection) {
  const snap = await db.collection(collection).get();
  const rows = snap.docs.map(d => d.data());
  rows.sort((a, b) => {
    const ai = typeof a.id === 'number' ? a.id : a.id;
    const bi = typeof b.id === 'number' ? b.id : b.id;
    if (typeof ai === 'number' && typeof bi === 'number') return ai - bi;
    return String(a.id ?? '').localeCompare(String(b.id ?? ''));
  });
  return rows;
}
async function whereEq(collection, field, value) {
  const snap = await db.collection(collection).where(field, '==', value).get();
  return snap.docs.map(d => d.data());
}
async function getOne(collection, field, value) {
  const rows = await whereEq(collection, field, value);
  return rows.length ? rows[0] : null;
}

// ---------- settings (doc id = key) ----------
async function getSetting(key, fallback = '') {
  const doc = await getDoc('system_settings', key);
  return doc ? doc.value : fallback;
}
async function putSetting(key, value) {
  await setDoc('system_settings', key, { key, value: String(value) });
}
async function getAllSettings() {
  const rows = await fetchAll('system_settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ---------- INSERT OR IGNORE parity for unique-field reference rows ----------
async function createIfAbsentBy(collection, field, value, data) {
  const existing = await getOne(collection, field, value);
  if (existing) return existing;
  const id = await insertWithId(collection, data);
  return { ...data, id };
}

// ---------- leave_balances composite key (no id field, doc id = emp_type) ----------
function balanceDocId(employeeId, leaveTypeId) { return `${employeeId}_${leaveTypeId}`; }
function balanceRef(employeeId, leaveTypeId) {
  return db.collection('leave_balances').doc(balanceDocId(employeeId, leaveTypeId));
}
async function readBalanceTx(tx, employeeId, leaveTypeId) {
  const snap = await tx.get(balanceRef(employeeId, leaveTypeId));
  return snap.exists ? snap.data() : { earned: 0, used: 0, pending: 0 };
}
function setBalanceTx(tx, employeeId, leaveTypeId, fields) {
  tx.set(balanceRef(employeeId, leaveTypeId), { employee_id: employeeId, leave_type_id: leaveTypeId, ...fields }, { merge: true });
}

// ---------- express async handler ----------
const ah = fn => (req, res, next) => fn(req, res, next).catch(next);

module.exports = {
  db, nowText, todayISO,
  nextIdsTx, insertIntoTx, nextIdTx, insertWithId,
  getDoc, getById, setDoc, setIfAbsent,
  updateById, removeById,
  fetchAll, whereEq, getOne,
  getSetting, putSetting, getAllSettings,
  createIfAbsentBy,
  balanceDocId, balanceRef, readBalanceTx, setBalanceTx,
  ah
};
```

Note on `nextIdTx`: it allocates a counter and writes an empty doc — do NOT use it when the real document body is known; use `insertWithId` or `nextIdsTx` + `insertIntoTx`. It exists only for the dbtest counter check and any future partial-allocation need. Server conversion (Task 3) uses `nextIdsTx` + `insertIntoTx` or `insertWithId` exclusively.

- [ ] **Step 1:10: Run dbtest under the emulator and verify all 36 pass**

Run: `npm run test:db`
Expected: `firebase emulators:exec` boots the emulator (first run downloads it, ~1 min), `emuclear` clears, then output ends with `--- dbtest: 36 PASS / 0 FAIL ---` and exit code 0. Any FAIL line is a defect in `db.js` — fix before proceeding.

- [ ] **Step 11: Verify fail-fast with neither configuration**

Run: `node -e "delete process.env.FIRESTORE_EMULATOR_HOST; delete process.env.FIREBASE_SERVICE_ACCOUNT; require('./db.js')"`
Expected: prints `FATAL: No Firestore configuration...` and exits 1 (Node reports a non-zero exit). If it hangs or exits 0, the init guard is wrong.

- [ ] **Step 12: Verify bare `node server.js` still boots on SQLite (no regression yet)**

Run: `node server.js` (Ctrl+C after the listen line, or just confirm it starts and kill it)
Expected: `Leave Management System running on http://localhost:3000` — server.js is untouched in this task; SQLite still serves. `db.js` is loaded only by dbtest.

- [ ] **Step 13: Commit**

```bash
git add db.js emuclear.js dbtest.js firebase.json firestore.rules firestore.indexes.json package.json package-lock.json
git commit -m "feat: add Firestore persistence layer and emulator tooling"
```

---

## Task 2: Admin Parity Harness and Prodcheck Fix

Builds the admin-flow parity harness (`admintest.js`, 40 checks, port 3002) and fixes `prodcheck.js`'s pre-existing `prod admin stats` 401 by sending `X-Forwarded-Proto: https` (the real-Render TLS-termination condition). Then captures the SQLite baseline every later task must match. `server.js` is NOT modified in this task.

**Files:**
- Create: `admintest.js`
- Modify: `prodcheck.js` (full rewrite below)

**Interfaces:**
- Consumes: current SQLite `server.js` (unchanged); seed demo accounts `employee@example.com`/`password123` and `hr@example.com`/`password123`; ports 3000 (default spawn), 3001 (prodcheck), 3002 (admintest)
- Produces: `admintest.js` — 40 checks, spawns `server.js` on `PORT=3002`, reused unchanged under the emulator in Task 3 via `npm run test:admin`; `prodcheck.js` — same 7 checks, now FX-correct, reused via `npm run test:prod`; recorded SQLite baseline counts (apitest 11, smoketest 23, admintest 40, prodcheck 7 — all 0 FAIL) that Task 3 must reproduce exactly

- [ ] **Step 1: Create `admintest.js`**

```js
const { spawn } = require('child_process');
const srv = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: '3002' } });
let out = '';
srv.stdout.on('data', d => { out += d; });
srv.stderr.on('data', d => { out += d; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const B = 'http://localhost:3002';
(async () => {
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try { const r = await fetch(B + '/login.html'); if (r.ok) break; } catch {}
  }
  const results = [];
  const ck = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`);
  try {
    // --- employee: login + submit sick leave (2 checks) ---
    let res = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'employee@example.com', password: 'password123' }) });
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    const lj = await res.json();
    ck('employee login', res.ok && lj.user, JSON.stringify(lj.user || {}).slice(0, 80));
    const H = { Cookie: cookie, 'Content-Type': 'application/json' };
    res = await fetch(B + '/api/leave-types', { headers: H });
    const types = await res.json();
    const sick = types.find(t => t.code === 'sick');
    res = await fetch(B + '/api/leaves', { method: 'POST', headers: H, body: JSON.stringify({ leave_type_id: sick.id, start_date: '2026-10-05', end_date: '2026-10-06', reason: 'Admin parity flu', emergency_name: 'Ana', emergency_relationship: 'Spouse', emergency_phone: '+639171234567', extra_details: { care_type: 'outpatient', clinic: 'Clinic', illness: 'Flu' } }) });
    const created = await res.json();
    ck('submit sick leave', res.ok && created.id && created.working_days === 2, JSON.stringify(created).slice(0, 120));

    // --- HR: session (1 check) ---
    res = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'hr@example.com', password: 'password123' }) });
    const hc = (res.headers.get('set-cookie') || '').split(';')[0];
    const HH = { Cookie: hc, 'Content-Type': 'application/json' };
    const hj = await res.json();
    ck('hr login', res.ok && hj.user && hj.user.role === 'hr_admin', hj.user?.role);

    // --- stats shape (1 check) ---
    res = await fetch(B + '/api/admin/stats', { headers: HH });
    const stats = await res.json();
    const shapeOk = ['pending', 'approved', 'rejected', 'today', 'week', 'onLeave', 'upcoming', 'attention'].every(k => k in stats);
    ck('admin stats shape', res.ok && shapeOk && stats.pending >= 1, JSON.stringify(stats).slice(0, 160));

    // --- leaves list filters (8 checks) ---
    res = await fetch(B + '/api/admin/leaves', { headers: HH });
    let list = await res.json();
    ck('leaves list default', res.ok && Array.isArray(list.rows) && list.total >= 1, `total=${list.total}`);
    res = await fetch(B + '/api/admin/leaves?search=Kenneth', { headers: HH });
    list = await res.json();
    ck('leaves search filter', res.ok && list.rows.length >= 1 && list.rows.every(r => /kenneth/i.test(r.employee_name)), `rows=${list.rows.length}`);
    res = await fetch(B + '/api/admin/leaves?status=PENDING_GROUP', { headers: HH });
    list = await res.json();
    ck('leaves PENDING_GROUP filter', res.ok && list.rows.some(r => r.id === created.id && r.status === 'PENDING'), `rows=${list.rows.length}`);
    res = await fetch(B + '/api/admin/leaves?leave_type=sick', { headers: HH });
    list = await res.json();
    ck('leaves leave_type filter', res.ok && list.rows.length >= 1 && list.rows.every(r => r.leave_code === 'sick'), `rows=${list.rows.length}`);
    res = await fetch(B + '/api/admin/leaves?department=Engineering', { headers: HH });
    list = await res.json();
    ck('leaves department filter', res.ok && list.rows.every(r => r.department === 'Engineering'), `rows=${list.rows.length}`);
    res = await fetch(B + '/api/admin/leaves?from=2026-10-01&to=2026-10-31', { headers: HH });
    list = await res.json();
    ck('leaves from-to filter', res.ok && list.rows.some(r => r.id === created.id), `rows=${list.rows.length}`);
    res = await fetch(B + '/api/admin/leaves?limit=1', { headers: HH });
    list = await res.json();
    ck('leaves pagination limit', res.ok && list.rows.length === 1 && list.total >= 1, `rows=${list.rows.length} total=${list.total}`);
    res = await fetch(B + '/api/admin/leaves?page=99&limit=20', { headers: HH });
    list = await res.json();
    ck('leaves page=99 empty rows', res.ok && list.rows.length === 0 && list.total >= 1, `rows=${list.rows.length} total=${list.total}`);

    // --- leave detail (3 checks) ---
    res = await fetch(B + `/api/admin/leaves/${created.id}`, { headers: HH });
    const detail = await res.json();
    ck('leave detail', res.ok && detail.employee_name === 'Kenneth Fajardo' && detail.leave_code === 'sick', `${detail.employee_name} ${detail.leave_code}`);
    res = await fetch(B + '/api/admin/leaves/999999', { headers: HH });
    ck('leave detail 404', res.status === 404, res.status);
    ck('leave detail balance.remaining', typeof detail.balance?.remaining === 'number', String(detail.balance?.remaining));

    // --- reject flow: 400 -> 200 -> finalized 400 -> detail REJECTED (4 checks) ---
    res = await fetch(B + `/api/admin/leaves/${created.id}/review`, { method: 'POST', headers: HH, body: JSON.stringify({ action: 'reject', comment: '' }) });
    ck('reject without comment 400', res.status === 400, res.status);
    res = await fetch(B + `/api/admin/leaves/${created.id}/review`, { method: 'POST', headers: HH, body: JSON.stringify({ action: 'reject', comment: 'Parity rejection' }) });
    const rej = await res.json();
    ck('reject with comment 200', res.ok && rej.status === 'REJECTED', JSON.stringify(rej));
    res = await fetch(B + `/api/admin/leaves/${created.id}/review`, { method: 'POST', headers: HH, body: JSON.stringify({ action: 'reject', comment: 'again' }) });
    ck('review finalized 400', res.status === 400, res.status);
    res = await fetch(B + `/api/admin/leaves/${created.id}`, { headers: HH });
    const detail2 = await res.json();
    ck('leave detail shows REJECTED', res.ok && detail2.status === 'REJECTED', detail2.status);

    // --- employees CRUD (5 checks) ---
    res = await fetch(B + '/api/admin/employees', { headers: HH });
    const emps = await res.json();
    ck('employees list', res.ok && emps.length >= 5, `rows=${emps.length}`);
    res = await fetch(B + '/api/admin/employees', { method: 'POST', headers: HH, body: JSON.stringify({ employee_no: 'TEMP-900', name: 'Temp Worker', email: 'temp900@example.com', department: 'Operations', position: 'Staff', date_hired: '2026-01-05' }) });
    const emp = await res.json();
    ck('employee create ok', res.ok && typeof emp.id === 'number', JSON.stringify(emp));
    res = await fetch(B + '/api/admin/employees', { method: 'POST', headers: HH, body: JSON.stringify({ employee_no: 'TEMP-900', name: 'Dup No', email: 'other900@example.com' }) });
    ck('employee dup_no 400', res.status === 400, res.status);
    res = await fetch(B + '/api/admin/employees', { method: 'POST', headers: HH, body: JSON.stringify({ employee_no: 'TEMP-901', name: 'Dup Email', email: 'temp900@example.com' }) });
    ck('employee dup_email 400', res.status === 400, res.status);
    res = await fetch(B + `/api/admin/employees/${emp.id}`, { method: 'PUT', headers: HH, body: JSON.stringify({ name: 'Temp Renamed' }) });
    ck('employee update ok', res.ok, res.status);
    res = await fetch(B + `/api/admin/employees/${emp.id}`, { method: 'DELETE', headers: HH });
    ck('employee disable ok', res.ok, res.status);

    // --- balances (4 checks) ---
    res = await fetch(B + '/api/admin/balances', { headers: HH });
    const bals = await res.json();
    ck('balances list with remaining', res.ok && bals.length >= 1 && typeof bals[0].remaining === 'number', `rows=${bals.length}`);
    res = await fetch(B + `/api/admin/balances?employee_id=${emp.id}`, { headers: HH });
    const empBals = await res.json();
    ck('balances filter employee_id', res.ok && empBals.length === 3 && empBals.every(b => b.employee_id === emp.id), `rows=${empBals.length}`);
    res = await fetch(B + '/api/admin/balances/adjust', { method: 'POST', headers: HH, body: JSON.stringify({ employee_id: emp.id, leave_type_id: sick.id, delta: 5, reason: '' }) });
    ck('balances adjust missing reason 400', res.status === 400, res.status);
    res = await fetch(B + '/api/admin/balances/adjust', { method: 'POST', headers: HH, body: JSON.stringify({ employee_id: emp.id, leave_type_id: sick.id, delta: 5, reason: 'Parity adjust' }) });
    const adj = await res.json();
    res = await fetch(B + `/api/admin/balances?employee_id=${emp.id}`, { headers: HH });
    const bals2 = await res.json();
    const sickBal = bals2.find(b => b.leave_type_id === sick.id);
    ck('balances adjust ok', res.ok === true && adj.ok === true && sickBal && sickBal.earned === 20, `earned=${sickBal && sickBal.earned}`);

    // --- holidays CRUD (4 checks) ---
    res = await fetch(B + '/api/admin/holidays', { method: 'POST', headers: HH, body: JSON.stringify({ date: '2026-10-12', name: 'Test Holiday', kind: 'regular' }) });
    const hol = await res.json();
    ck('holiday create ok', res.ok && typeof hol.id === 'number', JSON.stringify(hol));
    res = await fetch(B + '/api/admin/holidays', { method: 'POST', headers: HH, body: JSON.stringify({ date: '2026-10-12', name: 'Dup Holiday' }) });
    ck('holiday dup 400', res.status === 400, res.status);
    res = await fetch(B + `/api/admin/holidays/${hol.id}`, { method: 'PUT', headers: HH, body: JSON.stringify({ name: 'Renamed Holiday' }) });
    ck('holiday update ok', res.ok, res.status);
    res = await fetch(B + `/api/admin/holidays/${hol.id}`, { method: 'DELETE', headers: HH });
    ck('holiday delete ok', res.ok, res.status);

    // --- leave-type toggle numeric 0/1 (1 check) ---
    res = await fetch(B + `/api/admin/leave-types/${sick.id}`, { method: 'PUT', headers: HH, body: JSON.stringify({ active: 0 }) });
    const tOff = res.ok;
    res = await fetch(B + '/api/leave-types', { headers: HH });
    const typesAfterOff = await res.json();
    const offOk = typesAfterOff.find(t => t.id === sick.id).active === 0;
    res = await fetch(B + `/api/admin/leave-types/${sick.id}`, { method: 'PUT', headers: HH, body: JSON.stringify({ active: 1 }) });
    const tOn = res.ok;
    res = await fetch(B + '/api/leave-types', { headers: HH });
    const typesAfterOn = await res.json();
    const onOk = typesAfterOn.find(t => t.id === sick.id).active === 1;
    ck('leave-type toggle 0/1', tOff && offOk && tOn && onOk, `off=${offOk} on=${onOk}`);

    // --- audit / reports / export / RBAC (4 checks) ---
    res = await fetch(B + '/api/admin/audit', { headers: HH });
    const audit = await res.json();
    ck('audit list', res.ok && audit.total >= 1 && audit.rows.length >= 1, `total=${audit.total}`);
    res = await fetch(B + '/api/admin/reports/summary', { headers: HH });
    const rep = await res.json();
    const repOk = res.ok && typeof rep.total === 'number' && typeof rep.totalDays === 'number' && rep.byStatus && rep.byType && rep.byDept;
    ck('reports summary', repOk, JSON.stringify(rep).slice(0, 120));
    res = await fetch(B + '/api/admin/reports/export.csv', { headers: HH });
    ck('export.csv', res.ok && (res.headers.get('content-type') || '').includes('csv'), res.headers.get('content-type'));
    res = await fetch(B + '/api/admin/users', { method: 'POST', headers: HH, body: JSON.stringify({ email: 'x@example.com', password: 'pw123456', role: 'employee' }) });
    ck('users POST as hr_admin 403', res.status === 403, res.status);

    // --- employee post-reject state: pending released + notification (2 checks) ---
    res = await fetch(B + '/api/balances/me', { headers: H });
    const myBals = await res.json();
    const mySick = myBals.find(b => b.code === 'sick');
    ck('balances pending released after reject', res.ok && mySick && mySick.pending === 0, `pending=${mySick && mySick.pending}`);
    res = await fetch(B + '/api/notifications', { headers: H });
    const notifs = await res.json();
    ck('employee got rejection notification', res.ok && notifs.some(n => n.title === 'Leave rejected'), `rows=${notifs.length}`);
  } catch (e) { results.push('FAIL exception ' + e.message); }
  console.log('--- ADMIN ---');
  console.log(results.join('\n'));
  console.log('--- SERVER LOG ---');
  console.log(out.slice(0, 2000));
  srv.kill();
  setTimeout(() => process.exit(0), 500);
})();
```

- [ ] **Step 2: Run admintest against the SQLite server and bring the harness to 40/40**

Run: `node admintest.js`
Expected: `--- ADMIN ---` then 40 lines of `PASS ...` and no `FAIL`. If a check fails, the bug is in the harness's expectations (this task must NOT modify `server.js` — it is the parity reference). Fix the harness until 40 PASS / 0 FAIL. Common pitfalls: using `leave_type_id` vs `leave_code` in filters, case-sensitivity of the search check (`/kenneth/i`), and the sick-leave working-days math (2026-10-05/06 are Tue/Wed, not holidays → 2 days).

- [ ] **Step 3: Rewrite `prodcheck.js` with the forwarded-proto fix**

```js
const { spawn } = require('child_process');
const srv = spawn('node', ['server.js'], { cwd: __dirname,
  env: { ...process.env, NODE_ENV: 'production', PORT: '3001', ADMIN_EMAIL: 'boss@company.com', ADMIN_PASSWORD: 'S3cure!Pass123', SESSION_SECRET: 'test-secret' } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const B = 'http://localhost:3001';
// Render terminates TLS and forwards X-Forwarded-Proto; trust proxy=1 makes
// express-session (secure: true under NODE_ENV=production) set the session
// cookie only when this header is present. Without it, login succeeds but no
// cookie is issued over the test's plain-HTTP connection — the pre-existing
// root cause of the old 'prod admin stats 401' failure.
const FX = { 'X-Forwarded-Proto': 'https' };
(async () => {
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try { const r = await fetch(B + '/login.html'); if (r.ok) break; } catch {}
  }
  const out = [];
  const ck = (n, ok, x = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${n} ${x}`);
  try {
    let r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { ...FX, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'employee@example.com', password: 'password123' }) });
    ck('prod demo login rejected', r.status === 401, r.status);
    r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { ...FX, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'hr@example.com', password: 'password123' }) });
    ck('prod hr demo rejected', r.status === 401, r.status);
    r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { ...FX, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'boss@company.com', password: 'S3cure!Pass123' }) });
    const c = (r.headers.get('set-cookie') || '').split(';')[0];
    const j = await r.json();
    ck('prod admin bootstrap login', r.ok && j.user.role === 'sys_admin', j.user?.role);
    r = await fetch(B + '/api/admin/stats', { headers: { ...FX, Cookie: c } });
    ck('prod admin stats', r.ok, r.status);
    r = await fetch(B + '/api/leave-types', { headers: FX });
    const t = await r.json();
    ck('prod reference data', t.length >= 10, `types=${t.length}`);
    const html = await (await fetch(B + '/login.html', { headers: FX })).text();
    ck('prod login page clean', !html.includes('password123') && !html.includes('Demo accounts'));
    // rate limit: 25 rapid failures -> 429 expected
    let got429 = false;
    for (let i = 0; i < 25; i++) {
      r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { ...FX, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nobody@x.com', password: 'wrong' }) });
      if (r.status === 429) { got429 = true; break; }
    }
    ck('prod login rate limit', got429);
  } catch (e) { out.push('FAIL exception ' + e.message); }
  console.log(out.join('\n'));
  srv.kill();
  setTimeout(() => process.exit(0), 500);
})();
```

- [ ] **Step 4: Capture the SQLite baseline (protocol order matters)**

These commands run in order in PowerShell. The first wipe gives smoketest/admintest a fresh DB (smoketest's pre-existing overlap failure only appears on a dirty DB). The second wipe is mandatory before prodcheck: prodcheck boots `NODE_ENV=production` and relies on the seed's admin-bootstrap path, which is skipped when any user already exists.

Run:
```powershell
Remove-Item data\app.db* -ErrorAction SilentlyContinue
node apitest.js
node smoketest.js
node admintest.js
Remove-Item data\app.db* -ErrorAction SilentlyContinue
node prodcheck.js
```

Expected outputs, in order:
1. apitest: 11 lines all `PASS` (exit code 0)
2. smoketest: `--- SMOKE ---` then 23 lines all `PASS`, 0 FAIL
3. admintest: `--- ADMIN ---` then 40 lines all `PASS`, 0 FAIL
4. prodcheck: 7 lines all `PASS` — including `PASS prod admin stats` (the FX fix works on SQLite too, proving the 401 was transport, not storage)

Record these counts. Task 3's acceptance gate is reproducing exactly these numbers under the emulator.

- [ ] **Step 5: Commit**

```bash
git add admintest.js prodcheck.js
git commit -m "test: add admin parity harness and prodcheck forwarded-proto fix"
```

---

## Task 3: Replace SQLite with Firestore in `server.js`

Rewrites all 108 `db.prepare(...)` call sites in place using `db.js` helpers, converts `seed()` to async, and boots the server via an async IIFE that awaits the seed. The converted file is written in three blocks (A/B/C) below — each block is contiguous file content; concatenate them in order to form the complete new `server.js`. Zero route/URL/response-shape changes; `public/` is untouched.

**Files:**
- Modify: `server.js` (full rewrite from the three blocks)

**Interfaces:**
- Consumes: `db.js` exports from Task 1 (`db, nowText, todayISO, nextIdsTx, insertIntoTx, insertWithId, getDoc, getById, setDoc, setIfAbsent, updateById, removeById, fetchAll, whereEq, getOne, getSetting, putSetting, getAllSettings, createIfAbsentBy, balanceDocId, balanceRef, readBalanceTx, setBalanceTx, ah`); `uploads/` dir unchanged; `bcryptjs`/`express-session`/`multer` unchanged
- Produces: `server.js` with identical HTTP surface; collection names = old table names; numeric `id` fields on all counter-backed docs; balance docs keyed `${employee_id}_${leave_type_id}` with NO `id` field; settings docs `{key, value}` with NO `id` field

**Conversion rules (apply throughout all three blocks):**
- Every async route handler is wrapped in `ah(...)` so rejections hit the error middleware.
- `datetime('now')` column defaults → `nowText()` written explicitly at insert time.
- SQLite `INSERT OR IGNORE` on unique fields → `createIfAbsentBy(collection, field, value, data)` (reference rows) or `setIfAbsent` (known doc IDs).
- `ON CONFLICT ... DO UPDATE` balance upserts → `readBalanceTx` + `setBalanceTx` inside `db.runTransaction`.
- JOIN queries → `fetchAll`/`getById` + id→row Maps, or per-id `getById` pairs in `appFull`.
- `LIKE '%x%'` → in-memory `.toLowerCase().includes()`; `substr(date,1,7)` → `.slice(0,7)`; `date(submitted_at)=date('now')` → `.slice(0,10) === todayISO()`; week window → `new Date(Date.now() - 7*86400000).toISOString().slice(0,10)`.
- **Transaction ordering (Firestore hard rule):** inside every `db.runTransaction`, ALL reads (`nextIdsTx`, `readBalanceTx`, `tx.get`) happen before ANY writes (`insertIntoTx`, `setBalanceTx`, `tx.set`, `tx.update`, `tx.delete`). `nextIdsTx` is always called first.
- Transactional routes (multi-write atomicity required): `POST /api/leaves` (submit), `POST /api/leaves/:id/cancel`, `POST /api/admin/leaves/:id/review` (approve/reject/advance), `POST /api/admin/balances/adjust`, and the seed's sample-approved application.
- `updateById` skips `undefined`/`null` fields (COALESCE parity); missing doc → `false` but routes still answer `{ok:true}` like SQLite's silent UPDATE.
- `balanceAfter()` (old server.js:127) is dead code — deleted, not converted.
- `app.set('trust proxy', 1);` stays verbatim and unconditional.
- Removed entirely: `node:sqlite` require, `DATA_DIR`, schema `db.exec`, `lid()` helper.

- [ ] **Step 1: Write Block A — requires, business logic, async seed, app setup**

Replace the top of `server.js` through `HR_ROLES` (old lines 1–284) with:

```js
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
  db, nowText, todayISO, nextIdsTx, insertIntoTx, insertWithId,
  getDoc, getById, setDoc, setIfAbsent, updateById, removeById,
  fetchAll, whereEq, getOne, getSetting, putSetting, getAllSettings,
  createIfAbsentBy, balanceDocId, balanceRef, readBalanceTx, setBalanceTx, ah
} = require('./db');

const PORT = process.env.PORT || 3000;
const app = express();
const isProd = process.env.NODE_ENV === 'production';

// ---------- storage (uploads only; Firestore holds all data) ----------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- business logic (centralized, not duplicated in UI) ----------
function parseISO(s) { const d = new Date(s + 'T00:00:00'); return isNaN(d) ? null : d; }
function isoDay(d) { return d.toISOString().slice(0, 10); }
function calcWorkingDays(startISO, endISO, holidayISOs = []) {
  const s = parseISO(startISO), e = parseISO(endISO);
  if (!s || !e || e < s) return 0;
  const hol = new Set(holidayISOs);
  let n = 0;
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    if (hol.has(isoDay(d))) continue;
    n++;
  }
  return n;
}
async function holidayList() { return (await fetchAll('holidays')).map(r => r.date); }
const TRANSITIONS = {
  DRAFT: ['PENDING', 'CANCELLED'],
  PENDING: ['UNDER_REVIEW', 'REJECTED', 'CANCELLED', 'APPROVED'],
  UNDER_REVIEW: ['FOR_SUPERVISOR_REVIEW', 'FOR_FINAL_APPROVAL', 'APPROVED', 'REJECTED'],
  FOR_SUPERVISOR_REVIEW: ['FOR_FINAL_APPROVAL', 'APPROVED', 'REJECTED'],
  FOR_FINAL_APPROVAL: ['APPROVED', 'REJECTED'],
  APPROVED: [], REJECTED: [], CANCELLED: []
};
const CANCELLABLE = new Set(['DRAFT', 'PENDING', 'UNDER_REVIEW']);
const MULTI_STEP_CODES = new Set(['maternity', 'paternity', 'study', 'vawc', 'adoption', 'rehab']);
async function audit(actorId, actorEmail, action, entity, entityId, description, meta = {}) {
  await insertWithId('audit_logs', {
    actor_id: actorId || null, actor_email: actorEmail || '', action,
    entity: entity || '', entity_id: String(entityId || ''), description: description || '',
    meta: JSON.stringify(meta), created_at: nowText()
  });
}
async function notify(userId, title, body, type = 'info') {
  if (!userId) return;
  await insertWithId('notifications', { user_id: userId, title, body: body || '', type, read: 0, created_at: nowText() });
}
async function notifyRole(roles, title, body, type = 'info') {
  const users = await fetchAll('users');
  for (const u of users) if (roles.includes(u.role) && u.active) await notify(u.id, title, body, type);
}
async function appFull(id) {
  const a = await getById('leave_applications', id);
  if (!a) return null;
  const e = await getById('employees', a.employee_id);
  const lt = await getById('leave_types', a.leave_type_id);
  return {
    ...a,
    employee_name: e ? e.name : null, employee_email: e ? e.email : null,
    department: e ? e.department : null, position: e ? e.position : null,
    employee_no: e ? e.employee_no : null,
    leave_code: lt ? lt.code : null, leave_name: lt ? lt.name : null
  };
}

// ---------- seed (async; Firestore) ----------
async function seed() {
  const existingUsers = (await fetchAll('users')).length;
  console.log('Seeding reference data...');
  for (const d of ['Engineering', 'Human Resources', 'Finance', 'Operations'])
    await createIfAbsentBy('departments', 'name', d, { name: d });
  const types = [
    ['vacation', 'Vacation Leave', 0, 0], ['sick', 'Sick Leave', 1, 0], ['maternity', 'Maternity Leave', 1, 105],
    ['paternity', 'Paternity Leave', 0, 7], ['spl', 'Special Privilege Leave', 0, 3], ['solo_parent', 'Solo Parent Leave', 0, 7],
    ['study', 'Study Leave', 0, 6], ['vawc', '10-Day VAWC Leave', 0, 10], ['rehab', 'Rehabilitation Privilege', 0, 0],
    ['magna_carta', 'Special Leave Benefits for Women', 1, 60], ['calamity', 'Special Emergency / Calamity Leave', 0, 5],
    ['adoption', 'Adoption Leave', 0, 0], ['unpaid', 'Unpaid Leave', 0, 0], ['other', 'Other', 0, 0]
  ];
  for (const [code, name, req, max] of types)
    await createIfAbsentBy('leave_types', 'code', code, { code, name, active: 1, requires_doc: req, max_days: max, description: '' });
  for (const [date, name, kind] of [
    ['2026-01-01', "New Year s Day", 'regular'], ['2026-04-09', 'Araw ng Kagitingan', 'regular'],
    ['2026-05-01', 'Labor Day', 'regular'], ['2026-06-12', 'Independence Day', 'regular'],
    ['2026-08-21', 'Ninoy Aquino Day', 'special'], ['2026-08-31', 'National Heroes Day', 'regular'],
    ['2026-11-01', 'All Saints Day', 'special'], ['2026-12-25', 'Christmas Day', 'regular'], ['2026-12-30', 'Rizal Day', 'regular']
  ]) await createIfAbsentBy('holidays', 'date', date, { date, name, kind });
  const settings = {
    org_name: 'Sample Organization Inc.', office: 'Human Resources Department', salary_visible: '0',
    char_limit: '500', cancellation_policy: 'Employees may cancel PENDING or UNDER_REVIEW applications.',
    workflow_vacation: 'hr_only', workflow_default: 'hr_supervisor_final',
    upload_max_mb: '5', notif_enabled: '1'
  };
  for (const [k, v] of Object.entries(settings)) await setIfAbsent('system_settings', k, { key: k, value: String(v) });
  if (existingUsers > 0) return;
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (adminEmail && adminPassword) {
    const empId = await insertWithId('employees', {
      employee_no: 'ADMIN-001', name: 'System Administrator', email: adminEmail, phone: '',
      department: 'Human Resources', position: 'Administrator', status: 'active',
      date_hired: new Date().toISOString().slice(0, 10), avatar_color: '#4f46e5'
    });
    await insertWithId('users', {
      email: adminEmail, password_hash: bcrypt.hashSync(adminPassword, 10),
      role: 'sys_admin', employee_id: empId, active: 1
    });
    for (const [code, earned] of [['vacation', 25], ['sick', 15], ['spl', 5]]) {
      const lt = await getOne('leave_types', 'code', code);
      if (lt) await setDoc('leave_balances', balanceDocId(empId, lt.id), { employee_id: empId, leave_type_id: lt.id, earned, used: 0, pending: 0 });
    }
    await audit(null, 'system', 'admin_bootstrapped', 'user', '', 'Initial admin ' + adminEmail);
    console.log('Bootstrapped admin ' + adminEmail);
    return;
  }
  if (isProd) {
    console.warn('No users exist and ADMIN_EMAIL/ADMIN_PASSWORD are not set. Set them to create the first administrator.');
    return;
  }
  console.log('Seeding demo accounts (development only)...');
  const emps = [
    ['EMP-001', 'Kenneth Fajardo', 'employee@example.com', 'Engineering', 'Software Engineer'],
    ['EMP-002', 'Maria Santos', 'maria@example.com', 'Finance', 'Accountant'],
    ['EMP-003', 'John Cruz', 'john@example.com', 'Operations', 'Staff'],
    ['HR-001', 'HR Administrator', 'hr@example.com', 'Human Resources', 'HR Manager'],
    ['SUP-001', 'Sam Supervisor', 'supervisor@example.com', 'Engineering', 'Team Lead']
  ];
  const empIds = {};
  for (const [no, name, email, dept, pos] of emps) {
    empIds[email] = await insertWithId('employees', {
      employee_no: no, name, email, phone: '+639171234567', department: dept, position: pos,
      status: 'active', date_hired: '2023-01-15', avatar_color: '#4f46e5'
    });
  }
  const pw = bcrypt.hashSync('password123', 10);
  const users = [
    ['employee@example.com', 'employee', 'employee@example.com'], ['maria@example.com', 'employee', 'maria@example.com'],
    ['john@example.com', 'employee', 'john@example.com'], ['hr@example.com', 'hr_admin', 'hr@example.com'],
    ['supervisor@example.com', 'supervisor', 'supervisor@example.com']
  ];
  const userIds = {};
  for (const [email, role, empEmail] of users) {
    userIds[email] = await insertWithId('users', { email, password_hash: pw, role, employee_id: empIds[empEmail], active: 1 });
  }
  const vacLt = await getOne('leave_types', 'code', 'vacation');
  const sickLt = await getOne('leave_types', 'code', 'sick');
  const splLt = await getOne('leave_types', 'code', 'spl');
  for (const em of Object.values(empIds)) {
    await setDoc('leave_balances', balanceDocId(em, vacLt.id), { employee_id: em, leave_type_id: vacLt.id, earned: 25, used: 0, pending: 0 });
    await setDoc('leave_balances', balanceDocId(em, sickLt.id), { employee_id: em, leave_type_id: sickLt.id, earned: 15, used: 0, pending: 0 });
    await setDoc('leave_balances', balanceDocId(em, splLt.id), { employee_id: em, leave_type_id: splLt.id, earned: 5, used: 0, pending: 0 });
  }
  // sample approved vacation for Kenneth (transactional: app + approval + balance + tx-log)
  const kId = empIds['employee@example.com'];
  await db.runTransaction(async tx => {
    const ids = await nextIdsTx(tx, ['leave_applications', 'leave_approvals', 'leave_balance_transactions']);
    insertIntoTx(tx, 'leave_applications', ids.leave_applications, {
      employee_id: kId, leave_type_id: vacLt.id, start_date: '2026-06-30', end_date: '2026-07-03',
      working_days: 4, reason: 'Family trip', emergency_name: 'Ana Fajardo', emergency_relationship: 'Spouse',
      emergency_phone: '+639171111111', extra_details: JSON.stringify({ location: 'within' }),
      status: 'APPROVED', submitted_at: nowText(), updated_at: nowText()
    });
    insertIntoTx(tx, 'leave_approvals', ids.leave_approvals, {
      application_id: ids.leave_applications, approver_id: userIds['hr@example.com'],
      step: 'HR_REVIEW', action: 'APPROVED', comment: 'Enjoy!', created_at: nowText()
    });
    setBalanceTx(tx, kId, vacLt.id, { earned: 25, used: 4, pending: 0 });
    insertIntoTx(tx, 'leave_balance_transactions', ids.leave_balance_transactions, {
      employee_id: kId, leave_type_id: vacLt.id, delta: -4, type: 'debit',
      reason: 'Approved vacation Jun 30-Jul 3', actor_id: userIds['hr@example.com'], created_at: nowText()
    });
  });
  await audit(null, 'system', 'seed', 'system', '', 'Database seeded with demo accounts');
}

// ---------- app ----------
app.set('trust proxy', 1);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-in-production';
if (isProd && !process.env.SESSION_SECRET) console.warn('WARNING: SESSION_SECRET not set; sessions are insecure. Set it in the environment.');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { maxAge: 86400000, httpOnly: true, sameSite: 'lax', secure: isProd } }));
// ----- app (Android) entry: employee-only -----
const APP_BLOCKED_PATHS = ['/admin.html', '/js/admin.js'];
app.get('/app.html', (req, res) => {
  if (req.session.user && req.session.user.role !== 'employee') {
    return req.session.destroy(() => res.redirect('/app.html?blocked=1'));
  }
  req.session.client = 'android';
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
app.use((req, res, next) => {
  if (req.session.client !== 'android') return next();
  if (APP_BLOCKED_PATHS.includes(req.path)) return res.redirect('/app.html');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// login brute-force throttle (in-memory, per IP)
const loginAttempts = new Map();
function loginThrottled(ip) {
  const now = Date.now(), rec = loginAttempts.get(ip);
  if (rec && now < rec.reset) return rec.count >= 20;
  loginAttempts.set(ip, { count: 0, reset: now + 15 * 60 * 1000 });
  return false;
}
function loginFailed(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, reset: Date.now() + 15 * 60 * 1000 };
  rec.count++; loginAttempts.set(ip, rec);
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  getById('users', req.session.user.id).then(u => {
    if (!u || !u.active) return res.status(401).json({ error: 'Account disabled' });
    req.user = u; next();
  }).catch(next);
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role) && req.user.role !== 'sys_admin') return res.status(403).json({ error: 'Forbidden: requires ' + roles.join('/') });
    next();
  };
}
const HR_ROLES = ['hr_staff', 'hr_admin', 'sys_admin', 'supervisor', 'final_approver'];
```

Notes:
- `app.listen(...)` is intentionally NOT here — it moves to the async boot IIFE at the end of Block C, after `await seed()`.
- Settings seed uses `setIfAbsent` (INSERT OR IGNORE parity: never overwrite a customized value on re-boot); reference rows use `createIfAbsentBy` (unique-field parity for `departments.name`, `leave_types.code`, `holidays.date`).
- Balance docs created via `setDoc`/`setBalanceTx` carry `employee_id` + `leave_type_id` and NO `id` field (response-shape parity).

- [ ] **Step 2: Write Block B — auth, shared, employee leaves, documents, calendar routes**

Append after `const HR_ROLES = [...]` (Block A's last line):

```js
// ----- auth -----
app.post('/api/auth/login', ah(async (req, res) => {
  if (loginThrottled(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const { email, password, client } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const u = await getOne('users', 'email', String(email).toLowerCase());
  if (!u || !u.active || !bcrypt.compareSync(password, u.password_hash)) {
    loginFailed(req.ip);
    await audit(null, email, 'login_failed', 'user', '', 'Failed login');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (client === 'android' && HR_ROLES.includes(u.role)) {
    await audit(u.id, u.email, 'login_blocked_app', 'user', u.id, 'HR/supervisor login refused from Android app');
    return res.status(403).json({ error: 'HR and Supervisor accounts use the web portal.' });
  }
  loginAttempts.delete(req.ip);
  const emp = u.employee_id ? await getById('employees', u.employee_id) : null;
  req.session.user = { id: u.id, email: u.email, role: u.role, employee_id: u.employee_id };
  await audit(u.id, u.email, 'login', 'user', u.id, 'Login');
  res.json({ user: { id: u.id, email: u.email, role: u.role, employee_id: u.employee_id, employee: emp } });
}));
app.post('/api/auth/logout', ah(async (req, res) => {
  const e = req.session.user?.email;
  req.session.destroy(() => {});
  if (e) await audit(null, e, 'logout', 'user', '', 'Logout');
  res.json({ ok: true });
}));
app.get('/api/auth/me', requireAuth, ah(async (req, res) => {
  const emp = req.user.employee_id ? await getById('employees', req.user.employee_id) : null;
  res.json({ user: { id: req.user.id, email: req.user.email, role: req.user.role, employee_id: req.user.employee_id, employee: emp } });
}));
app.post('/api/auth/forgot', ah(async (req, res) => {
  const { email } = req.body || {};
  if (email) {
    const u = await getOne('users', 'email', String(email).toLowerCase());
    if (u) await notify(u.id, 'Password reset requested', 'An administrator will contact you with reset instructions.', 'security');
  }
  res.json({ ok: true, message: 'If the account exists, instructions were sent.' });
}));

// ----- shared -----
app.get('/api/leave-types', ah(async (req, res) => {
  const rows = (await fetchAll('leave_types')).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!req.session.user) return res.json(rows.filter(r => r.active));
  res.json(rows);
}));
app.get('/api/holidays', ah(async (req, res) => {
  res.json((await fetchAll('holidays')).sort((a, b) => String(a.date).localeCompare(String(b.date))));
}));
app.get('/api/profile/me', requireAuth, ah(async (req, res) => {
  const emp = req.user.employee_id ? await getById('employees', req.user.employee_id) : null;
  res.json(emp || {});
}));

// ----- balances -----
app.get('/api/balances/me', requireAuth, ah(async (req, res) => {
  const types = new Map((await fetchAll('leave_types')).map(t => [t.id, t]));
  const rows = (await whereEq('leave_balances', 'employee_id', req.user.employee_id))
    .map(r => ({ ...r, code: types.get(r.leave_type_id)?.code, name: types.get(r.leave_type_id)?.name, remaining: r.earned - r.used - r.pending }));
  res.json(rows);
}));

// ----- calculate -----
app.post('/api/leaves/calculate', requireAuth, ah(async (req, res) => {
  const { start_date, end_date } = req.body || {};
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
  if (parseISO(end_date) < parseISO(start_date)) return res.status(400).json({ error: 'End date cannot be before start date' });
  res.json({ working_days: calcWorkingDays(start_date, end_date, await holidayList()) });
}));

// ----- employee leaves -----
async function validateLeave(body, leaveCode) {
  const errs = [];
  if (!body.start_date || !body.end_date) errs.push('Start and end dates required');
  else if (parseISO(body.end_date) < parseISO(body.start_date)) errs.push('End date cannot be before start date');
  if (!body.reason || !body.reason.trim()) errs.push('Reason is required');
  else {
    const lim = parseInt(await getSetting('char_limit', '500')) || 500;
    if (body.reason.length > lim) errs.push(`Reason exceeds ${lim} characters`);
  }
  if (!body.emergency_name) errs.push('Emergency contact name required');
  if (!body.emergency_phone || String(body.emergency_phone).replace(/\D/g, '').length < 7) errs.push('Valid emergency phone required');
  const ex = body.extra_details || {};
  if (leaveCode === 'vacation' && !ex.location) errs.push('Choose Within the Philippines or Abroad');
  if (leaveCode === 'vacation' && ex.location === 'abroad' && !ex.country) errs.push('Country required for abroad');
  if (leaveCode === 'sick' && !ex.care_type) errs.push('Choose Hospital or Out Patient');
  if (leaveCode === 'sick' && !ex.illness) errs.push('Illness/reason required');
  if (leaveCode === 'study' && !ex.purpose) errs.push('Study purpose required');
  return errs;
}
app.post('/api/leaves', requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  const lt = await getById('leave_types', b.leave_type_id);
  if (!lt || !lt.active) return res.status(400).json({ error: 'Invalid or disabled leave type' });
  const errs = await validateLeave(b, lt.code);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  const days = calcWorkingDays(b.start_date, b.end_date, await holidayList());
  if (days <= 0) return res.status(400).json({ error: 'Selected range has 0 working days (weekends/holidays excluded)' });
  const myApps = await whereEq('leave_applications', 'employee_id', req.user.employee_id);
  const overlap = myApps.find(a => !['REJECTED', 'CANCELLED'].includes(a.status) && !(a.end_date < b.start_date || a.start_date > b.end_date));
  if (overlap) return res.status(400).json({ error: 'Overlapping leave application exists (ID ' + overlap.id + ')' });
  const newId = await db.runTransaction(async tx => {
    const ids = await nextIdsTx(tx, ['leave_applications', 'leave_approvals']);
    const bal = await readBalanceTx(tx, req.user.employee_id, lt.id);
    insertIntoTx(tx, 'leave_applications', ids.leave_applications, {
      employee_id: req.user.employee_id, leave_type_id: lt.id,
      start_date: b.start_date, end_date: b.end_date, working_days: days,
      reason: b.reason, emergency_name: b.emergency_name || '', emergency_relationship: b.emergency_relationship || '',
      emergency_phone: b.emergency_phone || '', extra_details: JSON.stringify(b.extra_details || {}),
      status: 'PENDING', submitted_at: nowText(), updated_at: nowText()
    });
    insertIntoTx(tx, 'leave_approvals', ids.leave_approvals, {
      application_id: ids.leave_applications, approver_id: req.user.id,
      step: 'SUBMISSION', action: 'SUBMITTED', comment: 'Application submitted', created_at: nowText()
    });
    setBalanceTx(tx, req.user.employee_id, lt.id, { earned: bal.earned, used: bal.used, pending: bal.pending + days });
    return ids.leave_applications;
  });
  await audit(req.user.id, req.user.email, 'application_submitted', 'leave_application', newId, `${lt.name} ${b.start_date}→${b.end_date} (${days}d)`);
  await notifyRole(['hr_staff', 'hr_admin', 'sys_admin'], 'New leave application', `${lt.name} from employee #${req.user.employee_id}`, 'leave');
  res.json({ id: newId, working_days: days });
}));
app.get('/api/leaves/me', requireAuth, ah(async (req, res) => {
  const f = req.query.filter || 'all';
  const types = new Map((await fetchAll('leave_types')).map(t => [t.id, t]));
  let rows = (await whereEq('leave_applications', 'employee_id', req.user.employee_id))
    .map(a => ({ ...a, leave_code: types.get(a.leave_type_id)?.code, leave_name: types.get(a.leave_type_id)?.name }));
  if (f === 'pending') rows = rows.filter(a => ['PENDING', 'UNDER_REVIEW', 'FOR_SUPERVISOR_REVIEW', 'FOR_FINAL_APPROVAL', 'DRAFT'].includes(a.status));
  if (f === 'history') rows = rows.filter(a => ['APPROVED', 'REJECTED', 'CANCELLED'].includes(a.status));
  rows.sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
  res.json(rows);
}));
function canSeeApp(user, app) {
  if (!app) return false;
  if (HR_ROLES.includes(user.role) || user.role === 'sys_admin') return true;
  return app.employee_id === user.employee_id;
}
app.get('/api/leaves/:id', requireAuth, ah(async (req, res) => {
  const a = await appFull(req.params.id);
  if (!a || !canSeeApp(req.user, a)) return res.status(404).json({ error: 'Not found' });
  a.extra_details = JSON.parse(a.extra_details || '{}');
  a.docs = (await whereEq('supporting_documents', 'application_id', a.id))
    .map(d => ({ id: d.id, filename: d.filename, mimetype: d.mimetype, size: d.size, created_at: d.created_at }));
  a.history = (await whereEq('leave_approvals', 'application_id', a.id))
    .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
  const bal = await getDoc('leave_balances', balanceDocId(a.employee_id, a.leave_type_id));
  a.balance = bal || { earned: 0, used: 0, pending: 0 };
  res.json(a);
}));
app.post('/api/leaves/:id/cancel', requireAuth, ah(async (req, res) => {
  const a = await appFull(req.params.id);
  if (!a || !canSeeApp(req.user, a)) return res.status(404).json({ error: 'Not found' });
  if (a.employee_id !== req.user.employee_id && !HR_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  if (!CANCELLABLE.has(a.status)) return res.status(400).json({ error: 'Cannot cancel at stage ' + a.status });
  await db.runTransaction(async tx => {
    const ids = await nextIdsTx(tx, ['leave_approvals']);
    const bal = await readBalanceTx(tx, a.employee_id, a.leave_type_id);
    tx.set(db.collection('leave_applications').doc(String(a.id)), { status: 'CANCELLED', updated_at: nowText() }, { merge: true });
    setBalanceTx(tx, a.employee_id, a.leave_type_id, {
      earned: bal.earned, used: bal.used,
      pending: bal.pending - a.working_days < 0 ? 0 : bal.pending - a.working_days
    });
    insertIntoTx(tx, 'leave_approvals', ids.leave_approvals, {
      application_id: a.id, approver_id: req.user.id, step: 'CANCELLATION', action: 'CANCELLED',
      comment: 'Cancelled by ' + req.user.email, created_at: nowText()
    });
  });
  await audit(req.user.id, req.user.email, 'application_cancelled', 'leave_application', a.id, 'Cancelled');
  res.json({ ok: true });
}));
app.get('/api/leaves/:id/print-data', requireAuth, ah(async (req, res) => {
  const a = await appFull(req.params.id);
  if (!a || !canSeeApp(req.user, a)) return res.status(404).json({ error: 'Not found' });
  const settings = await getAllSettings();
  const history = (await whereEq('leave_approvals', 'application_id', a.id))
    .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
  res.json({ app: { ...a, extra_details: JSON.parse(a.extra_details || '{}') }, settings, history });
}));

// ----- documents -----
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/pdf|jpe?g|png/i.test(path.extname(file.originalname)) || /pdf|jpe?g|png/i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF, JPG, PNG allowed'));
  } });
app.post('/api/leaves/:id/documents', requireAuth, upload.single('file'), ah(async (req, res) => {
  const a = await appFull(req.params.id);
  if (!a || !canSeeApp(req.user, a)) { fs.unlinkSync(req.file.path); return res.status(404).json({ error: 'Not found' }); }
  if (a.employee_id !== req.user.employee_id) return res.status(403).json({ error: 'Forbidden' });
  if (!['PENDING', 'DRAFT', 'UNDER_REVIEW'].includes(a.status)) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Cannot attach at this stage' }); }
  const id = await insertWithId('supporting_documents', {
    application_id: a.id, filename: req.file.originalname, stored_name: path.basename(req.file.path),
    mimetype: req.file.mimetype, size: req.file.size, uploaded_by: req.user.id, created_at: nowText()
  });
  await audit(req.user.id, req.user.email, 'document_uploaded', 'supporting_document', id, req.file.originalname);
  res.json({ id });
}));
app.get('/api/documents/:id', requireAuth, ah(async (req, res) => {
  const d = await getById('supporting_documents', req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const a = await appFull(d.application_id);
  if (!a || !canSeeApp(req.user, a)) return res.status(403).json({ error: 'Forbidden' });
  await audit(req.user.id, req.user.email, 'document_viewed', 'supporting_document', d.id, d.filename);
  res.sendFile(path.join(UPLOAD_DIR, d.stored_name), { headers: { 'Content-Disposition': `inline; filename="${d.filename}"` } });
}));
app.delete('/api/documents/:id', requireAuth, ah(async (req, res) => {
  const d = await getById('supporting_documents', req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const a = await appFull(d.application_id);
  if (!a || a.employee_id !== req.user.employee_id) return res.status(403).json({ error: 'Forbidden' });
  await removeById('supporting_documents', d.id);
  try { fs.unlinkSync(path.join(UPLOAD_DIR, d.stored_name)); } catch {}
  res.json({ ok: true });
}));

// ----- calendar / notifications -----
app.get('/api/calendar/me', requireAuth, ah(async (req, res) => {
  const m = req.query.month || new Date().toISOString().slice(0, 7);
  const types = new Map((await fetchAll('leave_types')).map(t => [t.id, t]));
  const rows = (await whereEq('leave_applications', 'employee_id', req.user.employee_id))
    .filter(a => String(a.start_date).slice(0, 7) <= m && String(a.end_date).slice(0, 7) >= m)
    .map(a => ({ ...a, leave_name: types.get(a.leave_type_id)?.name }));
  rows.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
  res.json(rows);
}));
app.get('/api/notifications', requireAuth, ah(async (req, res) => {
  res.json((await whereEq('notifications', 'user_id', req.user.id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 50));
}));
app.post('/api/notifications/:id/read', requireAuth, ah(async (req, res) => {
  const n = await getById('notifications', req.params.id);
  if (n && n.user_id === req.user.id) await updateById('notifications', req.params.id, { read: 1 });
  res.json({ ok: true });
}));
```

Notes:
- Submit (`POST /api/leaves`) and cancel are the two transactional employee-side flows: all reads (`nextIdsTx`, `readBalanceTx`) precede all writes inside the transaction. `audit`/`notify` run after commit — same observable behavior as SQLite (they were separate statements there too).
- `validateLeave` is now async (reads `char_limit` via `getSetting`); its call site awaits it.
- `GET /api/notifications` preserves SQLite `ORDER BY created_at DESC LIMIT 50` via in-memory sort + `slice(0, 50)`.
- `POST /api/notifications/:id/read` preserves the user_id guard and always answers `{ok:true}` (updateById's boolean result is ignored, matching SQLite's silent UPDATE).

- [ ] **Step 3: Write Block C — admin routes, error handler, async boot**

Append after the notifications routes (Block B's last line):

```js
// ----- admin -----
app.get('/api/admin/stats', requireAuth, requireRole(...HR_ROLES), ah(async (req, res) => {
  const apps = await fetchAll('leave_applications');
  const emps = new Map((await fetchAll('employees')).map(e => [e.id, e]));
  const types = new Map((await fetchAll('leave_types')).map(t => [t.id, t]));
  const c = s => apps.filter(a => a.status === s).length;
  const todayStr = todayISO();
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const today = apps.filter(a => String(a.submitted_at).slice(0, 10) === todayStr).length;
  const week = apps.filter(a => String(a.submitted_at).slice(0, 10) >= weekAgo).length;
  const onLeave = apps.filter(a => a.status === 'APPROVED' && todayStr >= a.start_date && todayStr <= a.end_date).length;
  const upcoming = apps.filter(a => a.status === 'APPROVED' && a.start_date > todayStr)
    .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date))).slice(0, 5)
    .map(a => ({ id: a.id, employee_name: emps.get(a.employee_id)?.name, leave_name: types.get(a.leave_type_id)?.name, start_date: a.start_date }));
  const attention = apps.filter(a => ['PENDING', 'UNDER_REVIEW'].includes(a.status))
    .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at))).slice(0, 8)
    .map(a => ({ id: a.id, employee_name: emps.get(a.employee_id)?.name, leave_name: types.get(a.leave_type_id)?.name, submitted_at: a.submitted_at }));
  res.json({ pending: c('PENDING') + c('UNDER_REVIEW') + c('FOR_SUPERVISOR_REVIEW') + c('FOR_FINAL_APPROVAL'), approved: c('APPROVED'), rejected: c('REJECTED'), today, week, onLeave, upcoming, attention });
}));
app.get('/api/admin/leaves', requireAuth, requireRole(...HR_ROLES), ah(async (req, res) => {
  const { search = '', status = '', leave_type = '', department = '', from = '', to = '', page = 1, limit = 20 } = req.query;
  const [apps, emps, types] = await Promise.all([fetchAll('leave_applications'), fetchAll('employees'), fetchAll('leave_types')]);
  const empById = new Map(emps.map(e => [e.id, e]));
  const typeById = new Map(types.map(t => [t.id, t]));
  let rows = apps.map(a => ({
    ...a,
    employee_name: empById.get(a.employee_id)?.name,
    department: empById.get(a.employee_id)?.department,
    employee_email: empById.get(a.employee_id)?.email,
    leave_name: typeById.get(a.leave_type_id)?.name,
    leave_code: typeById.get(a.leave_type_id)?.code
  }));
  const q = String(search).toLowerCase();
  if (q) rows = rows.filter(r => String(r.employee_name).toLowerCase().includes(q) || String(r.employee_email).toLowerCase().includes(q));
  if (status === 'PENDING_GROUP') rows = rows.filter(r => ['PENDING', 'UNDER_REVIEW', 'FOR_SUPERVISOR_REVIEW', 'FOR_FINAL_APPROVAL'].includes(r.status));
  else if (status) rows = rows.filter(r => r.status === status);
  if (leave_type) rows = rows.filter(r => r.leave_code === leave_type);
  if (department) rows = rows.filter(r => r.department === department);
  if (from) rows = rows.filter(r => r.start_date >= from);
  if (to) rows = rows.filter(r => r.end_date <= to);
  const total = rows.length;
  rows.sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
  res.json({ total, rows: rows.slice((+page - 1) * +limit, (+page - 1) * +limit + +limit) });
}));
app.get('/api/admin/leaves/:id', requireAuth, requireRole(...HR_ROLES), ah(async (req, res) => {
  const a = await appFull(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  a.extra_details = JSON.parse(a.extra_details || '{}');
  a.docs = (await whereEq('supporting_documents', 'application_id', a.id))
    .map(d => ({ id: d.id, filename: d.filename, mimetype: d.mimetype, size: d.size, created_at: d.created_at }));
  a.history = (await whereEq('leave_approvals', 'application_id', a.id))
    .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
  const others = await whereEq('leave_applications', 'employee_id', a.employee_id);
  a.pendingCount = others.filter(o => o.id !== a.id && ['PENDING', 'UNDER_REVIEW', 'FOR_SUPERVISOR_REVIEW', 'FOR_FINAL_APPROVAL'].includes(o.status)).length;
  const bal = await getDoc('leave_balances', balanceDocId(a.employee_id, a.leave_type_id));
  a.balance = bal || { earned: 0, used: 0, pending: 0 };
  a.balance.remaining = a.balance.earned - a.balance.used - a.balance.pending;
  a.balance.after = a.balance.remaining;
  a.insufficient = a.balance.after < 0 || (a.balance.earned - a.balance.used) < a.working_days;
  res.json(a);
}));
app.post('/api/admin/leaves/:id/review', requireAuth, requireRole(...HR_ROLES), ah(async (req, res) => {
  const { action, comment = '' } = req.body || {};
  const a = await appFull(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (['APPROVED', 'REJECTED', 'CANCELLED'].includes(a.status)) return res.status(400).json({ error: 'Already finalized: ' + a.status });
  const step = a.status === 'PENDING' ? 'HR_REVIEW' : a.status;
  if (action === 'reject') {
    if (!comment.trim()) return res.status(400).json({ error: 'Rejection reason is required' });
    await db.runTransaction(async tx => {
      const ids = await nextIdsTx(tx, ['leave_approvals']);
      const bal = await readBalanceTx(tx, a.employee_id, a.leave_type_id);
      tx.set(db.collection('leave_applications').doc(String(a.id)), { status: 'REJECTED', updated_at: nowText() }, { merge: true });
      setBalanceTx(tx, a.employee_id, a.leave_type_id, {
        earned: bal.earned, used: bal.used,
        pending: bal.pending - a.working_days < 0 ? 0 : bal.pending - a.working_days
      });
      insertIntoTx(tx, 'leave_approvals', ids.leave_approvals, {
        application_id: a.id, approver_id: req.user.id, step, action: 'REJECTED', comment, created_at: nowText()
      });
    });
    await audit(req.user.id, req.user.email, 'application_rejected', 'leave_application', a.id, comment);
    const empUser = await getOne('users', 'employee_id', a.employee_id);
    if (empUser) await notify(empUser.id, 'Leave rejected', `${a.leave_name}: ${comment}`, 'leave');
    return res.json({ ok: true, status: 'REJECTED' });
  }
  if (action === 'approve') {
    const needsMulti = MULTI_STEP_CODES.has(a.leave_code);
    let next = 'APPROVED';
    if (needsMulti && a.status === 'PENDING') next = 'FOR_SUPERVISOR_REVIEW';
    else if (needsMulti && a.status === 'UNDER_REVIEW') next = 'FOR_SUPERVISOR_REVIEW';
    else if (a.status === 'FOR_SUPERVISOR_REVIEW') next = 'FOR_FINAL_APPROVAL';
    if (!TRANSITIONS[a.status].includes(next) && !(a.status === 'PENDING' && next === 'APPROVED')) next = 'APPROVED';
    const cols = next === 'APPROVED' ? ['leave_approvals', 'leave_balance_transactions'] : ['leave_approvals'];
    await db.runTransaction(async tx => {
      const ids = await nextIdsTx(tx, cols);
      const bal = await readBalanceTx(tx, a.employee_id, a.leave_type_id);
      tx.set(db.collection('leave_applications').doc(String(a.id)), { status: next, updated_at: nowText() }, { merge: true });
      insertIntoTx(tx, 'leave_approvals', ids.leave_approvals, {
        application_id: a.id, approver_id: req.user.id, step, action: next === 'APPROVED' ? 'APPROVED' : 'ADVANCED',
        comment: comment || ('Moved to ' + next), created_at: nowText()
      });
      if (next === 'APPROVED') {
        setBalanceTx(tx, a.employee_id, a.leave_type_id, {
          earned: bal.earned, used: bal.used + a.working_days,
          pending: bal.pending - a.working_days < 0 ? 0 : bal.pending - a.working_days
        });
        insertIntoTx(tx, 'leave_balance_transactions', ids.leave_balance_transactions, {
          employee_id: a.employee_id, leave_type_id: a.leave_type_id, delta: -a.working_days, type: 'debit',
          reason: `Approved ${a.leave_name} ${a.start_date}→${a.end_date}`, actor_id: req.user.id, created_at: nowText()
        });
      }
    });
    let insufficient = false;
    if (next === 'APPROVED') {
      const balAfter = await getDoc('leave_balances', balanceDocId(a.employee_id, a.leave_type_id)) || { earned: 0, used: 0, pending: 0 };
      insufficient = (balAfter.earned - balAfter.used - balAfter.pending) < 0;
    }
    await audit(req.user.id, req.user.email, next === 'APPROVED' ? 'application_approved' : 'application_advanced', 'leave_application', a.id, `→ ${next}`);
    const empUser = await getOne('users', 'employee_id', a.employee_id);
    if (empUser) await notify(empUser.id, next === 'APPROVED' ? 'Leave approved' : 'Leave moved to ' + next, `${a.leave_name} ${a.start_date}→${a.end_date}`, 'leave');
    return res.json({ ok: true, status: next, insufficient });
  }
  if (action === 'advance') {
    const order = ['PENDING', 'UNDER_REVIEW', 'FOR_SUPERVISOR_REVIEW', 'FOR_FINAL_APPROVAL'];
    const i = order.indexOf(a.status);
    if (i < 0) return res.status(400).json({ error: 'Cannot advance from ' + a.status });
    const next = order[i + 1] || 'FOR_FINAL_APPROVAL';
    await db.runTransaction(async tx => {
      const ids = await nextIdsTx(tx, ['leave_approvals']);
      tx.set(db.collection('leave_applications').doc(String(a.id)), { status: next, updated_at: nowText() }, { merge: true });
      insertIntoTx(tx, 'leave_approvals', ids.leave_approvals, {
        application_id: a.id, approver_id: req.user.id, step, action: 'ADVANCED',
        comment: comment || ('Advanced to ' + next), created_at: nowText()
      });
    });
    await audit(req.user.id, req.user.email, 'application_advanced', 'leave_application', a.id, `→ ${next}`);
    return res.json({ ok: true, status: next });
  }
  res.status(400).json({ error: 'action must be approve|reject|advance' });
}));

// employees
app.get('/api/admin/employees', requireAuth, requireRole(...HR_ROLES), ah(async (req, res) => {
  res.json((await fetchAll('employees')).sort((a, b) => String(a.name).localeCompare(String(b.name))));
}));
app.post('/api/admin/employees', requireAuth, requireRole('hr_admin', 'sys_admin'), ah(async (req, res) => {
  const { employee_no, name, email, phone = '', department = '', position = '', status = 'active', date_hired = '' } = req.body || {};
  if (!name || !email || !employee_no) return res.status(400).json({ error: 'employee_no, name, email required' });
  const emps = await fetchAll('employees');
  if (emps.some(e => e.employee_no === employee_no || e.email === email))
    return res.status(400).json({ error: 'Duplicate employee_no or email' });
  const id = await insertWithId('employees', { employee_no, name, email, phone, department, position, status, date_hired, avatar_color: '#4f46e5' });
  const vacLt = await getOne('leave_types', 'code', 'vacation');
  if (vacLt) for (const [code, earned] of [['vacation', 25], ['sick', 15], ['spl', 5]]) {
    const lt = await getOne('leave_types', 'code', code);
    if (lt) await setDoc('leave_balances', balanceDocId(id, lt.id), { employee_id: id, leave_type_id: lt.id, earned, used: 0, pending: 0 });
  }
  await audit(req.user.id, req.user.email, 'employee_created', 'employee', id, name);
  res.json({ id });
}));
app.put('/api/admin/employees/:id', requireAuth, requireRole('hr_admin', 'sys_admin'), ah(async (req, res) => {
  const { name, email, phone, department, position, status, date_hired } = req.body || {};
  await updateById('employees', req.params.id, { name, email, phone, department, position, status, date_hired });
  await audit(req.user.id, req.user.email, 'employee_modified', 'employee', req.params.id, 'Updated');
  res.json({ ok: true });
}));
app.delete('/api/admin/employees/:id', requireAuth, requireRole('hr_admin', 'sys_admin'), ah(async (req, res) => {
  await updateById('employees', req.params.id, { status: 'disabled' });
  await audit(req.user.id, req.user.email, 'employee_disabled', 'employee', req.params.id, 'Disabled');
  res.json({ ok: true });
}));

// balances admin
app.get('/api/admin/balances', requireAuth, requireRole(...HR_ROLES), ah(async (req, res) => {
  const { employee_id } = req.query;
  const [bals, types, emps] = await Promise.all([fetchAll('leave_balances'), fetchAll('leave_types'), fetchAll('employees')]);
  const typeById = new Map(types.map(t => [t.id, t]));
  const empById = new Map(emps.map(e => [e.id, e]));
  let rows = bals.map(b => ({
    ...b,
    code: typeById.get(b.leave_type_id)?.code,
    name: typeById.get(b.leave_type_id)?.name,
    employee_name: empById.get(b.employee_id)?.name,
    remaining: b.earned - b.used - b.pending
  }));
  if (employee_id) rows = rows.filter(r => String(r.employee_id) === String(employee_id));
  rows.sort((a, b) => String(a.employee_name).localeCompare(String(b.employee_name)) || String(a.name).localeCompare(String(b.name)));
  res.json(rows);
}));
app.post('/api/admin/balances/adjust', requireAuth, requireRole('hr_admin', 'sys_admin'), ah(async (req, res) => {
  const { employee_id, leave_type_id, delta, reason = '' } = req.body || {};
  if (!employee_id || !leave_type_id || delta === undefined) return res.status(400).json({ error: 'employee_id, leave_type_id, delta required' });
  if (!reason.trim()) return res.status(400).json({ error: 'Reason is required for manual adjustment' });
  const prev = await getDoc('leave_balances', balanceDocId(employee_id, leave_type_id)) || { earned: 0, used: 0, pending: 0 };
  await db.runTransaction(async tx => {
    const ids = await nextIdsTx(tx, ['leave_balance_transactions']);
    const bal = await readBalanceTx(tx, employee_id, leave_type_id);
    setBalanceTx(tx, employee_id, leave_type_id, { earned: bal.earned + +delta, used: bal.used, pending: bal.pending });
    insertIntoTx(tx, 'leave_balance_transactions', ids.leave_balance_transactions, {
      employee_id, leave_type_id, delta: +delta, type: 'adjust', reason, actor_id: req.user.id, created_at: nowText()
    });
  });
  await audit(req.user.id, req.user.email, 'leave_balance_changed', 'leave_balance', `${employee_id}/${leave_type_id}`, `prev earned=${prev.earned} delta=${delta} reason=${reason}`);
  const empUser = await getOne('users', 'employee_id', employee_id);
  if (empUser) await notify(empUser.id, 'Leave balance changed', reason, 'balance');
  res.json({ ok: true });
}));

// holidays admin
app.post('/api/admin/holidays', requireAuth, requireRole('hr_admin', 'sys_admin'), ah(async (req, res) => {
  const { date, name, kind = 'regular' } = req.body || {};
  if (!date || !name) return res.status(400).json({ error: 'date and name required' });
  if (await getOne('holidays', 'date', date)) return res.status(400).json({ error: 'Holiday date already exists' });
  const id = await insertWithId('holidays', { date, name, kind });
  await audit(req.user.id, req.user.email, 'holiday_added', 'holiday', id, name);
  res.json({ id });
}));
app.put('/api/admin/holidays/:id', requireAuth, requireRole('hr_admin', 'sys_admin'), ah(async (req, res) => {
  const { date, name, kind } = req.body || {};
  await updateById('holidays', req.params.id, { date, name, kind });
  await audit(req.user.id, req.user.email, 'holiday_modified', 'holiday', req.params.id, 'Updated');
  res.json({ ok: true });
}));
app.delete('/api/admin/holidays/:id', requireAuth, requireRole('hr_admin', 'sys_admin'), ah(async (req, res) => {
  await removeById('holidays', req.params.id);
  await audit(req.user.id, req.user.email, 'holiday_deleted', 'holiday', req.params.id, 'Deleted');
  res.json({ ok: true });
}));

// leave types admin
app.put('/api/admin/leave-types/:id', requireAuth, requireRole('hr_admin', 'sys_admin'), ah(async (req, res) => {
  const { active, name, max_days } = req.body || {};
  await updateById('leave_types', req.params.id, { active, name, max_days });
  await audit(req.user.id, req.user.email, 'leave_type_changed', 'leave_type', req.params.id, 'Updated');
  res.json({ ok: true });
}));

// audit / reports / calendar admin
app.get('/api/admin/audit', requireAuth, requireRole('hr_admin', 'sys_admin'), ah(async (req, res) => {
  const { search = '', action = '', page = 1, limit = 30 } = req.query;
  let rows = await fetchAll('audit_logs');
  const q = String(search).toLowerCase();
  if (q) rows = rows.filter(r => String(r.actor_email).toLowerCase().includes(q) || String(r.description).toLowerCase().includes(q) || String(r.entity).toLowerCase().includes(q));
  if (action) rows = rows.filter(r => r.action === action);
  const total = rows.length;
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json({ total, rows: rows.slice((+page - 1) * +limit, (+page - 1) * +limit + +limit) });
}));
async function reportRows(q) {
  const [apps, emps, types] = await Promise.all([fetchAll('leave_applications'), fetchAll('employees'), fetchAll('leave_types')]);
  const empById = new Map(emps.map(e => [e.id, e]));
  const typeById = new Map(types.map(t => [t.id, t]));
  let rows = apps.map(a => ({
    id: a.id,
    employee_name: empById.get(a.employee_id)?.name,
    department: empById.get(a.employee_id)?.department,
    employee_no: empById.get(a.employee_id)?.employee_no,
    leave_name: typeById.get(a.leave_type_id)?.name,
    start_date: a.start_date, end_date: a.end_date, working_days: a.working_days,
    status: a.status, submitted_at: a.submitted_at,
    _employee_id: a.employee_id, _leave_code: typeById.get(a.leave_type_id)?.code
  }));
  if (q.from) rows = rows.filter(r => r.start_date >= q.from);
  if (q.to) rows = rows.filter(r => r.end_date <= q.to);
  if (q.department) rows = rows.filter(r => r.department === q.department);
  if (q.leave_type) rows = rows.filter(r => r._leave_code === q.leave_type);
  if (q.status) rows = rows.filter(r => r.status === q.status);
  if (q.employee_id) rows = rows.filter(r => String(r._employee_id) === String(q.employee_id));
  rows.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
  return rows.map(({ _employee_id, _leave_code, ...r }) => r);
}
app.get('/api/admin/reports/summary', requireAuth, requireRole(...HR_ROLES), ah(async (req, res) => {
  const rows = await reportRows(req.query);
  const byStatus = {}, byType = {}, byDept = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    byType[r.leave_name] = (byType[r.leave_name] || 0) + r.working_days;
    byDept[r.department] = (byDept[r.department] || 0) + 1;
  }
  await audit(req.user.id, req.user.email, 'report_generated', 'report', '', JSON.stringify(req.query));
  res.json({ total: rows.length, totalDays: rows.reduce((s, r) => s + r.working_days, 0), byStatus, byType, byDept, rows: rows.slice(0, 200) });
}));
app.get('/api/admin/reports/export.csv', requireAuth, requireRole(...HR_ROLES), ah(async (req, res) => {
  const rows = await reportRows(req.query);
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = 'id,employee,employee_no,department,leave,start,end,working_days,status,submitted\n' +
    rows.map(r => [r.id, esc(r.employee_name), r.employee_no, esc(r.department), esc(r.leave_name), r.start_date, r.end_date, r.working_days, r.status, r.submitted_at].join(',')).join('\n');
  await audit(req.user.id, req.user.email, 'report_generated', 'report_csv', '', `${rows.length} rows`);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leave-report.csv"');
  res.send(csv);
}));
app.get('/api/admin/calendar', requireAuth, requireRole(...HR_ROLES), ah(async (req, res) => {
  const { month, department = '', status = 'APPROVED' } = req.query;
  const m = month || new Date().toISOString().slice(0, 7);
  const [apps, emps, types] = await Promise.all([fetchAll('leave_applications'), fetchAll('employees'), fetchAll('leave_types')]);
  const empById = new Map(emps.map(e => [e.id, e]));
  const typeById = new Map(types.map(t => [t.id, t]));
  let rows = apps.filter(a => String(a.start_date).slice(0, 7) <= m && String(a.end_date).slice(0, 7) >= m)
    .map(a => ({ ...a, employee_name: empById.get(a.employee_id)?.name, department: empById.get(a.employee_id)?.department, leave_name: typeById.get(a.leave_type_id)?.name }));
  if (department) rows = rows.filter(r => r.department === department);
  if (status) rows = rows.filter(r => r.status === status);
  res.json(rows);
}));

// users + settings admin
app.get('/api/admin/users', requireAuth, requireRole('sys_admin', 'hr_admin'), ah(async (req, res) => {
  const [users, emps] = await Promise.all([fetchAll('users'), fetchAll('employees')]);
  const empById = new Map(emps.map(e => [e.id, e]));
  res.json(users.map(u => ({
    id: u.id, email: u.email, role: u.role, active: u.active, employee_id: u.employee_id,
    employee_name: u.employee_id ? empById.get(u.employee_id)?.name : null
  })).sort((a, b) => String(a.email).localeCompare(String(b.email))));
}));
app.post('/api/admin/users', requireAuth, requireRole('sys_admin'), ah(async (req, res) => {
  const { email, password, role = 'employee', employee_id = null } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (await getOne('users', 'email', String(email).toLowerCase())) return res.status(400).json({ error: 'Email already exists' });
  const id = await insertWithId('users', { email: String(email).toLowerCase(), password_hash: bcrypt.hashSync(password, 10), role, employee_id, active: 1 });
  await audit(req.user.id, req.user.email, 'user_created', 'user', id, email);
  res.json({ id });
}));
app.put('/api/admin/users/:id', requireAuth, requireRole('sys_admin'), ah(async (req, res) => {
  const { role, active } = req.body || {};
  await updateById('users', req.params.id, { role, active });
  await audit(req.user.id, req.user.email, 'user_modified', 'user', req.params.id, 'Updated');
  res.json({ ok: true });
}));
app.get('/api/admin/settings', requireAuth, requireRole(...HR_ROLES), ah(async (req, res) => {
  res.json(await getAllSettings());
}));
app.put('/api/admin/settings', requireAuth, requireRole('hr_admin', 'sys_admin'), ah(async (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) await putSetting(k, String(v));
  await audit(req.user.id, req.user.email, 'admin_settings_changed', 'settings', '', 'Updated settings');
  res.json({ ok: true });
}));

// ---------- error + fallback ----------
app.use((err, req, res, next) => {
  if (err.message && /Only PDF/.test(err.message)) return res.status(400).json({ error: err.message });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large (max 5MB)' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ---------- boot: seed first (async), then listen ----------
(async () => {
  await seed();
  app.listen(PORT, () => console.log(`Leave Management System running on http://localhost:${PORT}`));
})().catch(e => { console.error('FATAL boot error:', e); process.exit(1); });
```

Notes:
- Admin list/detail/review/balances/audit/reports/calendar all do bulk `fetchAll` + in-memory filter/sort/pagination — compound predicates, no composite indexes.
- Review reject/approve/advance and balances adjust are transactional (reads before writes); `audit`/`notify` fire after commit.
- `reportRows` keeps its original signature (query object → rows) so both summary and export.csv share it; underscore-prefixed temp fields are stripped before return.
- The final IIFE is the only `app.listen` — it runs after `await seed()`, guaranteeing reference data exists before traffic.

- [ ] **Step 4: Run the full emulator suite and verify parity with the SQLite baseline**

Run each in order (PowerShell; one command per line):
```powershell
npm run test:api
npm run test:db
npm run test:smoke
npm run test:admin
npm run test:prod
npm run test:pwa
npm run test:dl
```

Expected outputs:
1. `test:api` — 11 PASS / 0 FAIL (source-level; no server spawn)
2. `test:db` — `--- dbtest: 36 PASS / 0 FAIL ---`
3. `test:smoke` — 23 PASS / 0 FAIL
4. `test:admin` — 40 PASS / 0 FAIL (the exact baseline captured in Task 2 Step 4)
5. `test:prod` — 7 PASS / 0 FAIL, including `PASS prod admin stats`
6. `test:pwa` — pwacheck green (0 FAIL)
7. `test:dl` — dlcheck green (0 FAIL)

If any check fails: the failure is in the Task 3 conversion (not the harness — the harness was proven green on SQLite in Task 2). Debug the specific route, fix, re-run only the affected npm script, then re-run the full sequence once clean. Common conversion defects to check first: a `tx.get` after a `tx.set` (reads-before-writes violation), a missing `await` on an `ah`-wrapped handler, a Map lookup using the wrong key (`a.employee_id` vs `emp.id`), or a response object missing a field the harness asserts (`working_days`, `remaining`, `pendingCount`, `insufficient`).

- [ ] **Step 5: Verify the fail-fast guard still holds (bare `node server.js` with no config)**

Run: `node server.js`
Expected: prints `FATAL: No Firestore configuration...` and exits 1 — the server must not start against an unconfigured Firestore. If it starts or hangs, the `db.js` init guard was bypassed (check that `server.js` still `require`s `./db` at the top and does not lazy-load it).

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: replace SQLite with Cloud Firestore in server"
```

## Task 4: Wire Render secret, guard the service-account file, verify no SQLite remnants

### Files
- `render.yaml` (modify)
- `.gitignore` (modify)

### Context
Task 3 converted `server.js` to Firestore. The service-account JSON must never be committed, Render needs the new env var, and a final sweep must prove zero SQLite remnants remain in the source tree. (The bare-`node server.js` fail-fast guard was already verified in Task 3 Step 5.)

### Step 1: Update `render.yaml`

Replace the entire file with:

```yaml
services:
  - type: web
    name: leavems
    runtime: docker
    plan: free
    healthCheckPath: /login.html
    envVars:
      - key: PORT
        value: 3000
      - key: NODE_ENV
        value: production
      - key: SESSION_SECRET
        generateValue: true
      - key: ADMIN_EMAIL
        sync: false
      - key: ADMIN_PASSWORD
        sync: false
      - key: FIREBASE_SERVICE_ACCOUNT
        sync: false
    # DATA PERSISTENCE NOTE:
    # Data is stored in Cloud Firestore (see db.js). On the Render free plan
    # the container filesystem is wiped on every restart/redeploy, but
    # Firestore data lives in Google's cloud and survives — this is why the
    # SQLite → Firestore migration was done. FIREBASE_SERVICE_ACCOUNT must be
    # set manually in the Render dashboard (Environment tab): paste the full
    # JSON contents of the service-account key file (it is marked sync: false
    # so it is never stored in git).
```

What changed: added `FIREBASE_SERVICE_ACCOUNT` with `sync: false`; replaced the obsolete SQLite/disk persistence note with the Firestore note.

### Step 2: Append to `.gitignore`

Add these four lines at the end of `.gitignore`:

```
serviceAccount.json
firebase-debug.log
firestore-debug.log
ui-debug.log
firebase-export-*
```

(`serviceAccount.json` is the conventional filename for the downloaded key; the log/export files are Firebase-tools local artifacts that must never be committed.)

### Step 3: Verify zero SQLite remnants in source

Run (PowerShell, from the project root):
```powershell
$hits = Get-ChildItem -Recurse -Include *.js,*.yaml,*.json -File |
  Where-Object { $_.FullName -notmatch 'node_modules|LeaveMS-android|github-upload|\.omo' } |
  Select-String -Pattern 'node:sqlite|db\.prepare' -SimpleMatch:$false
if ($hits) { $hits | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }; exit 1 } else { "OK: no node:sqlite or db.prepare references" }
```

Expected: `OK: no node:sqlite or db.prepare references` (exit 0). If any hit appears, remove or fix that reference before committing.

Also verify `package.json` contains no `sqlite` dependency:
```powershell
Select-String -Path package.json -Pattern 'sqlite'
```
Expected: no output.

### Step 4: Commit

```bash
git add render.yaml .gitignore
git commit -m "chore: wire Render secret and guard service-account file"
```

---

## Task 5: User-gated real-Firestore verification (Render + Firebase console)

This task cannot be fully executed by the agent alone — it requires the user to create a Firebase project and set the secret on Render. The agent waits for confirmation at each user-gated step.

### Step 1: User creates a Firebase project and enables Firestore

User actions:
1. Go to https://console.firebase.google.com → Add project (e.g. `leavems-prod`).
2. Build → Firestore Database → Create database → Production mode → pick closest region (e.g. `asia-southeast1`).
3. Project settings → Service accounts → Generate new private key → save the downloaded JSON as `serviceAccount.json` (never commit; already in `.gitignore`).

### Step 2: Apply deny-all rules and empty indexes (agent, with the user's JSON in place)

Run (from the project root, with `serviceAccount.json` present and untracked):
```powershell
firebase deploy --only firestore:rules,firestore:indexes --project <USER_PROJECT_ID>
```
Expected: deploy succeeds; `firestore.rules` denies all (client SDKs cannot read/write directly — only the Admin SDK via `db.js` talks to Firestore).

### Step 3: User sets the Render environment variable

User actions:
1. Render dashboard → leavems → Environment → add `FIREBASE_SERVICE_ACCOUNT`, paste the full JSON contents of `serviceAccount.json`.
2. Trigger a redeploy (or wait for the next push).

### Step 4: Smoke-verify the live deployment

Agent (or user) hits the live URL and confirms:
- `/login.html` serves; login with the seeded `ADMIN_EMAIL`/`ADMIN_PASSWORD` works.
- Submit a leave request as an employee; approve it as HR.
- Check `/api/admin/stats`, `/api/admin/leaves`, balances, audit, CSV export all return data.
- Restart the service from the Render dashboard (Manual Deploy → Restart) and confirm the same data is still present — this is the entire point of the migration (data now survives free-plan restarts).

### Step 5: Update spec status

Edit `docs/superpowers/specs/2026-10-15-firebase-migration-design.md`: change the status line from `Draft` to `Implemented`. Commit:
```bash
git add docs/superpowers/specs/2026-10-15-firebase-migration-design.md
git commit -m "docs: mark Firebase migration spec as implemented"
```

### Note on running the emulator suite against the real database

`npm run test:smoke` / `test:prod` / `test:admin` use the emulator when `FIRESTORE_EMULATOR_HOST` is set by `firebase emulators:exec` (which all wrapped scripts do). They never touch the real database. If the user ever runs a check script with real credentials (`FIREBASE_SERVICE_ACCOUNT` set, no emulator), the seed data will be shared and must be cleared manually between smoke and prod checks — this is only relevant to ad-hoc real-DB debugging, not the standard suite.

---

## Success Criteria

The migration is complete when all of the following hold:

1. **Test parity**: `npm run test:api` (11 PASS), `test:db` (36 PASS), `test:smoke` (23 PASS), `test:admin` (40 PASS), `test:prod` (7 PASS incl. `prod admin stats`), `test:pwa` (green), `test:dl` (green) — all against the Firestore emulator.
2. **No SQLite remnants**: zero `node:sqlite` / `db.prepare` references anywhere in source (verified in Task 4 Step 3); no `sqlite` entry in `package.json`.
3. **Fail-fast on missing config**: bare `node server.js` with no Firestore credentials prints `FATAL: No Firestore configuration...` and exits 1 — the server never starts against an unconfigured Firestore.
4. **Render wiring**: `render.yaml` includes `FIREBASE_SERVICE_ACCOUNT` (`sync: false`); `.gitignore` excludes `serviceAccount.json` and Firebase debug logs.
5. **Data survives restarts** (user-gated): after the live deployment and a manual Render restart, submitted leave requests, balances, and audit logs are still present — proving the original SQLite-wipe problem is gone.
6. **Spec status updated**: `docs/superpowers/specs/2026-10-15-firebase-migration-design.md` marked `Implemented`.
