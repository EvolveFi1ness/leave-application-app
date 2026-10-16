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
