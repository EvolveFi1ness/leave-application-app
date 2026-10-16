process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const assert = require('assert');
const {
  db, nowText, todayISO, nextIdsTx, insertIntoTx, nextIdTx, insertWithId,
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
