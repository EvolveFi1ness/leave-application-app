// Clears every document from the local Firestore emulator so each check run
// starts from an empty database. Uses the Admin SDK (version-independent);
// the REST delete-all endpoint 404s on firebase-tools 15.x standard edition.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp({ projectId: 'demo-leavems' });
const db = getFirestore();

async function deleteCol(colRef) {
  const snap = await colRef.get();
  for (const doc of snap.docs) {
    const subs = await doc.ref.listCollections();
    for (const sub of subs) await deleteCol(sub);
    await doc.ref.delete();
  }
}

(async () => {
  const cols = await db.listCollections();
  for (const col of cols) await deleteCol(col);
  console.log(`emuclear: emulator database cleared (${cols.length} root collections)`);
  process.exit(0);
})().catch(e => { console.error('emuclear:', e.message); process.exit(1); });
