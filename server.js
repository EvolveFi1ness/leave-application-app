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
