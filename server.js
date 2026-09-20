const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const app = express();

// ---------- storage ----------
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
const lid = r => Number(r.lastInsertRowid);

// ---------- schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT, employee_no TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL, phone TEXT DEFAULT '', department TEXT DEFAULT '', position TEXT DEFAULT '',
  status TEXT DEFAULT 'active', date_hired TEXT DEFAULT '', avatar_color TEXT DEFAULT '#4f46e5'
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee', employee_id INTEGER REFERENCES employees(id), active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS leave_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  active INTEGER DEFAULT 1, requires_doc INTEGER DEFAULT 0, max_days INTEGER DEFAULT 0, description TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS leave_balances (
  employee_id INTEGER NOT NULL, leave_type_id INTEGER NOT NULL, earned REAL DEFAULT 0,
  used REAL DEFAULT 0, pending REAL DEFAULT 0,
  UNIQUE(employee_id, leave_type_id)
);
CREATE TABLE IF NOT EXISTS leave_balance_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, leave_type_id INTEGER,
  delta REAL NOT NULL, type TEXT NOT NULL, reason TEXT DEFAULT '', actor_id INTEGER, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS leave_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL REFERENCES employees(id),
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, working_days REAL NOT NULL DEFAULT 1,
  reason TEXT DEFAULT '', emergency_name TEXT DEFAULT '', emergency_relationship TEXT DEFAULT '',
  emergency_phone TEXT DEFAULT '', extra_details TEXT DEFAULT '{}', status TEXT DEFAULT 'PENDING',
  submitted_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS leave_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, application_id INTEGER NOT NULL REFERENCES leave_applications(id),
  approver_id INTEGER, step TEXT NOT NULL, action TEXT NOT NULL, comment TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS supporting_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, application_id INTEGER NOT NULL REFERENCES leave_applications(id),
  filename TEXT NOT NULL, stored_name TEXT NOT NULL, mimetype TEXT DEFAULT '', size INTEGER DEFAULT 0,
  uploaded_by INTEGER, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL,
  body TEXT DEFAULT '', type TEXT DEFAULT 'info', read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, actor_email TEXT DEFAULT '',
  action TEXT NOT NULL, entity TEXT DEFAULT '', entity_id TEXT DEFAULT '',
  description TEXT DEFAULT '', meta TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT UNIQUE NOT NULL, name TEXT NOT NULL, kind TEXT DEFAULT 'regular'
);
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
`);

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
function holidayList() { return db.prepare('SELECT date FROM holidays').all().map(r => r.date); }
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
function audit(actorId, actorEmail, action, entity, entityId, description, meta = {}) {
  db.prepare(`INSERT INTO audit_logs (actor_id, actor_email, action, entity, entity_id, description, meta)
    VALUES (?,?,?,?,?,?,?)`).run(actorId || null, actorEmail || '', action, entity || '', String(entityId || ''), description || '', JSON.stringify(meta));
}
function notify(userId, title, body, type = 'info') {
  if (!userId) return;
  db.prepare('INSERT INTO notifications (user_id, title, body, type) VALUES (?,?,?,?)').run(userId, title, body || '', type);
}
function notifyRole(roles, title, body, type = 'info') {
  const users = db.prepare(`SELECT id FROM users WHERE role IN (${roles.map(() => '?').join(',')}) AND active=1`).all(...roles);
  for (const u of users) notify(u.id, title, body, type);
}
function appFull(id) {
  return db.prepare(`SELECT a.*, e.name AS employee_name, e.email AS employee_email, e.department, e.position,
    e.employee_no, lt.code AS leave_code, lt.name AS leave_name
    FROM leave_applications a JOIN employees e ON e.id=a.employee_id
    JOIN leave_types lt ON lt.id=a.leave_type_id WHERE a.id=?`).get(id);
}
function balanceAfter(employeeId, leaveTypeId, workingDays) {
  const b = db.prepare('SELECT * FROM leave_balances WHERE employee_id=? AND leave_type_id=?').get(employeeId, leaveTypeId);
  if (!b) return { current: 0, after: -workingDays };
  return { current: b.earned - b.used - b.pending, after: b.earned - b.used - b.pending - 0 /* pending already holds */ };
}

// ---------- seed ----------
function seed() {
  const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (n > 0) return;
  console.log('Seeding database...');
  for (const d of ['Engineering', 'Human Resources', 'Finance', 'Operations'])
    db.prepare('INSERT OR IGNORE INTO departments (name) VALUES (?)').run(d);
  const types = [
    ['vacation', 'Vacation Leave', 0, 0], ['sick', 'Sick Leave', 1, 0], ['maternity', 'Maternity Leave', 1, 105],
    ['paternity', 'Paternity Leave', 0, 7], ['spl', 'Special Privilege Leave', 0, 3], ['solo_parent', 'Solo Parent Leave', 0, 7],
    ['study', 'Study Leave', 0, 6], ['vawc', '10-Day VAWC Leave', 0, 10], ['rehab', 'Rehabilitation Privilege', 0, 0],
    ['magna_carta', 'Special Leave Benefits for Women', 1, 60], ['calamity', 'Special Emergency / Calamity Leave', 0, 5],
    ['adoption', 'Adoption Leave', 0, 0], ['unpaid', 'Unpaid Leave', 0, 0], ['other', 'Other', 0, 0]
  ];
  for (const [code, name, req, max] of types)
    db.prepare('INSERT OR IGNORE INTO leave_types (code, name, requires_doc, max_days) VALUES (?,?,?,?)').run(code, name, req, max);
  for (const [date, name, kind] of [
    ['2026-01-01', "New Year s Day", 'regular'], ['2026-04-09', 'Araw ng Kagitingan', 'regular'],
    ['2026-05-01', 'Labor Day', 'regular'], ['2026-06-12', 'Independence Day', 'regular'],
    ['2026-08-21', 'Ninoy Aquino Day', 'special'], ['2026-08-31', 'National Heroes Day', 'regular'],
    ['2026-11-01', 'All Saints Day', 'special'], ['2026-12-25', 'Christmas Day', 'regular'], ['2026-12-30', 'Rizal Day', 'regular']
  ]) db.prepare('INSERT OR IGNORE INTO holidays (date, name, kind) VALUES (?,?,?)').run(date, name, kind);
  const emps = [
    ['EMP-001', 'Kenneth Fajardo', 'employee@example.com', 'Engineering', 'Software Engineer'],
    ['EMP-002', 'Maria Santos', 'maria@example.com', 'Finance', 'Accountant'],
    ['EMP-003', 'John Cruz', 'john@example.com', 'Operations', 'Staff'],
    ['HR-001', 'HR Administrator', 'hr@example.com', 'Human Resources', 'HR Manager'],
    ['SUP-001', 'Sam Supervisor', 'supervisor@example.com', 'Engineering', 'Team Lead']
  ];
  const empIds = {};
  for (const [no, name, email, dept, pos] of emps) {
    const r = db.prepare('INSERT INTO employees (employee_no, name, email, phone, department, position, date_hired) VALUES (?,?,?,?,?,?,?)')
      .run(no, name, email, '+639171234567', dept, pos, '2023-01-15');
    empIds[email] = lid(r);
  }
  const pw = bcrypt.hashSync('password123', 10);
  const users = [
    ['employee@example.com', 'employee', 'employee@example.com'], ['maria@example.com', 'employee', 'maria@example.com'],
    ['john@example.com', 'employee', 'john@example.com'], ['hr@example.com', 'hr_admin', 'hr@example.com'],
    ['supervisor@example.com', 'supervisor', 'supervisor@example.com']
  ];
  const userIds = {};
  for (const [email, role, empEmail] of users) {
    const r = db.prepare('INSERT INTO users (email, password_hash, role, employee_id) VALUES (?,?,?,?)').run(email, pw, role, empIds[empEmail]);
    userIds[email] = lid(r);
  }
  const vacId = db.prepare("SELECT id FROM leave_types WHERE code='vacation'").get().id;
  const sickId = db.prepare("SELECT id FROM leave_types WHERE code='sick'").get().id;
  const splId = db.prepare("SELECT id FROM leave_types WHERE code='spl'").get().id;
  for (const em of Object.values(empIds)) {
    db.prepare('INSERT INTO leave_balances (employee_id, leave_type_id, earned, used, pending) VALUES (?,?,?,0,0)').run(em, vacId, 25);
    db.prepare('INSERT INTO leave_balances (employee_id, leave_type_id, earned, used, pending) VALUES (?,?,?,0,0)').run(em, sickId, 15);
    db.prepare('INSERT INTO leave_balances (employee_id, leave_type_id, earned, used, pending) VALUES (?,?,?,0,0)').run(em, splId, 5);
  }
  // sample approved vacation for Kenneth
  const kId = empIds['employee@example.com'];
  db.prepare(`INSERT INTO leave_applications (employee_id, leave_type_id, start_date, end_date, working_days, reason, emergency_name, emergency_relationship, emergency_phone, extra_details, status)
    VALUES (?,?,?, ?,?,?, ?,?,?, ?,?)`).run(kId, vacId, '2026-06-30', '2026-07-03', 4, 'Family trip', 'Ana Fajardo', 'Spouse', '+639171111111', JSON.stringify({ location: 'within' }), 'APPROVED');
  const appId = db.prepare('SELECT last_insert_rowid() id').get().id;
  db.prepare('INSERT INTO leave_approvals (application_id, approver_id, step, action, comment) VALUES (?,?,?,?,?)')
    .run(appId, userIds['hr@example.com'], 'HR_REVIEW', 'APPROVED', 'Enjoy!');
  db.prepare('UPDATE leave_balances SET used=used+4 WHERE employee_id=? AND leave_type_id=?').run(kId, vacId);
  db.prepare('INSERT INTO leave_balance_transactions (employee_id, leave_type_id, delta, type, reason, actor_id) VALUES (?,?,?,?,?,?)')
    .run(kId, vacId, -4, 'debit', 'Approved vacation Jun 30-Jul 3', userIds['hr@example.com']);
  const settings = {
    org_name: 'Sample Organization Inc.', office: 'Human Resources Department', salary_visible: '0',
    char_limit: '500', cancellation_policy: 'Employees may cancel PENDING or UNDER_REVIEW applications.',
    workflow_vacation: 'hr_only', workflow_default: 'hr_supervisor_final',
    upload_max_mb: '5', notif_enabled: '1'
  };
  for (const [k, v] of Object.entries(settings)) db.prepare('INSERT OR IGNORE INTO system_settings (key, value) VALUES (?,?)').run(k, v);
  audit(null, 'system', 'seed', 'system', '', 'Database seeded');
}
seed();

// ---------- app ----------
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'lms-secret-change-me', resave: false, saveUninitialized: false, cookie: { maxAge: 86400000 } }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  const u = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(req.session.user.id);
  if (!u) return res.status(401).json({ error: 'Account disabled' });
  req.user = u; next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role) && req.user.role !== 'sys_admin') return res.status(403).json({ error: 'Forbidden: requires ' + roles.join('/') });
    next();
  };
}
const HR_ROLES = ['hr_staff', 'hr_admin', 'sys_admin', 'supervisor', 'final_approver'];

// ----- auth -----
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email).toLowerCase());
  if (!u || !u.active || !bcrypt.compareSync(password, u.password_hash)) {
    audit(null, email, 'login_failed', 'user', '', 'Failed login');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const emp = u.employee_id ? db.prepare('SELECT * FROM employees WHERE id=?').get(u.employee_id) : null;
  req.session.user = { id: u.id, email: u.email, role: u.role, employee_id: u.employee_id };
  audit(u.id, u.email, 'login', 'user', u.id, 'Login');
  res.json({ user: { id: u.id, email: u.email, role: u.role, employee_id: u.employee_id, employee: emp } });
});
app.post('/api/auth/logout', (req, res) => {
  const e = req.session.user?.email;
  req.session.destroy(() => {});
  if (e) audit(null, e, 'logout', 'user', '', 'Logout');
  res.json({ ok: true });
});
app.get('/api/auth/me', requireAuth, (req, res) => {
  const emp = req.user.employee_id ? db.prepare('SELECT * FROM employees WHERE id=?').get(req.user.employee_id) : null;
  res.json({ user: { id: req.user.id, email: req.user.email, role: req.user.role, employee_id: req.user.employee_id, employee: emp } });
});
app.post('/api/auth/forgot', (req, res) => {
  const { email } = req.body || {};
  if (email) {
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email).toLowerCase());
    if (u) notify(u.id, 'Password reset requested', 'An administrator will contact you. For demo, password is password123.', 'security');
  }
  res.json({ ok: true, message: 'If the account exists, instructions were sent.' });
});

// ----- shared -----
app.get('/api/leave-types', (req, res) => {
  const rows = db.prepare('SELECT * FROM leave_types ORDER BY name').all();
  if (!req.session.user) return res.json(rows.filter(r => r.active));
  res.json(rows);
});
app.get('/api/holidays', (req, res) => {
  res.json(db.prepare('SELECT * FROM holidays ORDER BY date').all());
});
app.get('/api/profile/me', requireAuth, (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(req.user.employee_id);
  res.json(emp || {});
});

// ----- balances -----
app.get('/api/balances/me', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT b.*, lt.code, lt.name FROM leave_balances b JOIN leave_types lt ON lt.id=b.leave_type_id WHERE b.employee_id=?`).all(req.user.employee_id);
  res.json(rows.map(r => ({ ...r, remaining: r.earned - r.used - r.pending })));
});

// ----- calculate -----
app.post('/api/leaves/calculate', requireAuth, (req, res) => {
  const { start_date, end_date } = req.body || {};
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
  if (parseISO(end_date) < parseISO(start_date)) return res.status(400).json({ error: 'End date cannot be before start date' });
  res.json({ working_days: calcWorkingDays(start_date, end_date, holidayList()) });
});

// ----- employee leaves -----
function validateLeave(body, leaveCode) {
  const errs = [];
  if (!body.start_date || !body.end_date) errs.push('Start and end dates required');
  else if (parseISO(body.end_date) < parseISO(body.start_date)) errs.push('End date cannot be before start date');
  if (!body.reason || !body.reason.trim()) errs.push('Reason is required');
  else {
    const lim = parseInt((db.prepare("SELECT value FROM system_settings WHERE key='char_limit'").get() || {}).value || '500');
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
app.post('/api/leaves', requireAuth, (req, res) => {
  const b = req.body || {};
  const lt = db.prepare('SELECT * FROM leave_types WHERE id=?').get(b.leave_type_id);
  if (!lt || !lt.active) return res.status(400).json({ error: 'Invalid or disabled leave type' });
  const errs = validateLeave(b, lt.code);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  const days = calcWorkingDays(b.start_date, b.end_date, holidayList());
  if (days <= 0) return res.status(400).json({ error: 'Selected range has 0 working days (weekends/holidays excluded)' });
  const overlap = db.prepare(`SELECT id FROM leave_applications WHERE employee_id=? AND status NOT IN ('REJECTED','CANCELLED')
    AND NOT (end_date < ? OR start_date > ?)`).get(req.user.employee_id, b.start_date, b.end_date);
  if (overlap) return res.status(400).json({ error: 'Overlapping leave application exists (ID ' + overlap.id + ')' });
  const r = db.prepare(`INSERT INTO leave_applications (employee_id, leave_type_id, start_date, end_date, working_days, reason, emergency_name, emergency_relationship, emergency_phone, extra_details, status)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'PENDING')`).run(req.user.employee_id, lt.id, b.start_date, b.end_date, days,
    b.reason, b.emergency_name || '', b.emergency_relationship || '', b.emergency_phone || '', JSON.stringify(b.extra_details || {}));
  db.prepare('INSERT INTO leave_approvals (application_id, approver_id, step, action, comment) VALUES (?,?,?,?,?)')
    .run(lid(r), req.user.id, 'SUBMISSION', 'SUBMITTED', 'Application submitted');
  db.prepare(`INSERT INTO leave_balances (employee_id, leave_type_id, earned, used, pending) VALUES (?,?,0,0,?)
    ON CONFLICT(employee_id, leave_type_id) DO UPDATE SET pending=pending+?`).run(req.user.employee_id, lt.id, days, days);
  audit(req.user.id, req.user.email, 'application_submitted', 'leave_application', lid(r), `${lt.name} ${b.start_date}→${b.end_date} (${days}d)`);
  notifyRole(['hr_staff', 'hr_admin', 'sys_admin'], 'New leave application', `${lt.name} from employee #${req.user.employee_id}`, 'leave');
  res.json({ id: lid(r), working_days: days });
});
app.get('/api/leaves/me', requireAuth, (req, res) => {
  const f = req.query.filter || 'all';
  let sql = `SELECT a.*, lt.code leave_code, lt.name leave_name FROM leave_applications a JOIN leave_types lt ON lt.id=a.leave_type_id WHERE a.employee_id=?`;
  if (f === 'pending') sql += ` AND a.status IN ('PENDING','UNDER_REVIEW','FOR_SUPERVISOR_REVIEW','FOR_FINAL_APPROVAL','DRAFT')`;
  if (f === 'history') sql += ` AND a.status IN ('APPROVED','REJECTED','CANCELLED')`;
  sql += ' ORDER BY a.submitted_at DESC';
  res.json(db.prepare(sql).all(req.user.employee_id));
});
function canSeeApp(user, app) {
  if (!app) return false;
  if (HR_ROLES.includes(user.role) || user.role === 'sys_admin') return true;
  return app.employee_id === user.employee_id;
}
app.get('/api/leaves/:id', requireAuth, (req, res) => {
  const a = appFull(req.params.id);
  if (!a || !canSeeApp(req.user, a)) return res.status(404).json({ error: 'Not found' });
  a.extra_details = JSON.parse(a.extra_details || '{}');
  a.docs = db.prepare('SELECT id, filename, mimetype, size, created_at FROM supporting_documents WHERE application_id=?').all(a.id);
  a.history = db.prepare('SELECT * FROM leave_approvals WHERE application_id=? ORDER BY created_at').all(a.id);
  const bal = db.prepare('SELECT earned, used, pending FROM leave_balances WHERE employee_id=? AND leave_type_id=?').get(a.employee_id, a.leave_type_id);
  a.balance = bal || { earned: 0, used: 0, pending: 0 };
  res.json(a);
});
app.post('/api/leaves/:id/cancel', requireAuth, (req, res) => {
  const a = appFull(req.params.id);
  if (!a || !canSeeApp(req.user, a)) return res.status(404).json({ error: 'Not found' });
  if (a.employee_id !== req.user.employee_id && !HR_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  if (!CANCELLABLE.has(a.status)) return res.status(400).json({ error: 'Cannot cancel at stage ' + a.status });
  db.prepare("UPDATE leave_applications SET status='CANCELLED', updated_at=datetime('now') WHERE id=?").run(a.id);
  db.prepare('UPDATE leave_balances SET pending=CASE WHEN pending-? < 0 THEN 0 ELSE pending-? END WHERE employee_id=? AND leave_type_id=?')
    .run(a.working_days, a.working_days, a.employee_id, a.leave_type_id);
  db.prepare('INSERT INTO leave_approvals (application_id, approver_id, step, action, comment) VALUES (?,?,?,?,?)')
    .run(a.id, req.user.id, 'CANCELLATION', 'CANCELLED', 'Cancelled by ' + req.user.email);
  audit(req.user.id, req.user.email, 'application_cancelled', 'leave_application', a.id, 'Cancelled');
  res.json({ ok: true });
});
app.get('/api/leaves/:id/print-data', requireAuth, (req, res) => {
  const a = appFull(req.params.id);
  if (!a || !canSeeApp(req.user, a)) return res.status(404).json({ error: 'Not found' });
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM system_settings').all().map(r => [r.key, r.value]));
  const history = db.prepare('SELECT * FROM leave_approvals WHERE application_id=? ORDER BY created_at').all(a.id);
  res.json({ app: { ...a, extra_details: JSON.parse(a.extra_details || '{}') }, settings, history });
});

// ----- documents -----
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/pdf|jpe?g|png/i.test(path.extname(file.originalname)) || /pdf|jpe?g|png/i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF, JPG, PNG allowed'));
  } });
app.post('/api/leaves/:id/documents', requireAuth, upload.single('file'), (req, res) => {
  const a = appFull(req.params.id);
  if (!a || !canSeeApp(req.user, a)) { fs.unlinkSync(req.file.path); return res.status(404).json({ error: 'Not found' }); }
  if (a.employee_id !== req.user.employee_id) return res.status(403).json({ error: 'Forbidden' });
  if (!['PENDING', 'DRAFT', 'UNDER_REVIEW'].includes(a.status)) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Cannot attach at this stage' }); }
  const r = db.prepare('INSERT INTO supporting_documents (application_id, filename, stored_name, mimetype, size, uploaded_by) VALUES (?,?,?,?,?,?)')
    .run(a.id, req.file.originalname, path.basename(req.file.path), req.file.mimetype, req.file.size, req.user.id);
  audit(req.user.id, req.user.email, 'document_uploaded', 'supporting_document', lid(r), req.file.originalname);
  res.json({ id: lid(r) });
});
app.get('/api/documents/:id', requireAuth, (req, res) => {
  const d = db.prepare('SELECT * FROM supporting_documents WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const a = appFull(d.application_id);
  if (!a || !canSeeApp(req.user, a)) return res.status(403).json({ error: 'Forbidden' });
  audit(req.user.id, req.user.email, 'document_viewed', 'supporting_document', d.id, d.filename);
  res.sendFile(path.join(UPLOAD_DIR, d.stored_name), { headers: { 'Content-Disposition': `inline; filename="${d.filename}"` } });
});
app.delete('/api/documents/:id', requireAuth, (req, res) => {
  const d = db.prepare('SELECT * FROM supporting_documents WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const a = appFull(d.application_id);
  if (!a || a.employee_id !== req.user.employee_id) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM supporting_documents WHERE id=?').run(d.id);
  try { fs.unlinkSync(path.join(UPLOAD_DIR, d.stored_name)); } catch {}
  res.json({ ok: true });
});

// ----- calendar / notifications -----
app.get('/api/calendar/me', requireAuth, (req, res) => {
  const m = req.query.month || new Date().toISOString().slice(0, 7);
  res.json(db.prepare(`SELECT a.*, lt.name leave_name FROM leave_applications a JOIN leave_types lt ON lt.id=a.leave_type_id
    WHERE a.employee_id=? AND substr(a.start_date,1,7)<=? AND substr(a.end_date,1,7)>=? ORDER BY a.start_date`).all(req.user.employee_id, m, m));
});
app.get('/api/notifications', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.id));
});
app.post('/api/notifications/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ----- admin -----
app.get('/api/admin/stats', requireAuth, requireRole(...HR_ROLES), (req, res) => {
  const c = s => db.prepare('SELECT COUNT(*) c FROM leave_applications WHERE status=?').get(s).c;
  const today = db.prepare("SELECT COUNT(*) c FROM leave_applications WHERE date(submitted_at)=date('now')").get().c;
  const week = db.prepare("SELECT COUNT(*) c FROM leave_applications WHERE date(submitted_at)>=date('now','-7 days')").get().c;
  const onLeave = db.prepare("SELECT COUNT(*) c FROM leave_applications WHERE status='APPROVED' AND date('now') BETWEEN start_date AND end_date").get().c;
  const upcoming = db.prepare(`SELECT a.id, e.name employee_name, lt.name leave_name, a.start_date FROM leave_applications a
    JOIN employees e ON e.id=a.employee_id JOIN leave_types lt ON lt.id=a.leave_type_id
    WHERE a.status='APPROVED' AND a.start_date > date('now') ORDER BY a.start_date LIMIT 5`).all();
  const attention = db.prepare(`SELECT a.id, e.name employee_name, lt.name leave_name, a.submitted_at FROM leave_applications a
    JOIN employees e ON e.id=a.employee_id JOIN leave_types lt ON lt.id=a.leave_type_id
    WHERE a.status IN ('PENDING','UNDER_REVIEW') ORDER BY a.submitted_at LIMIT 8`).all();
  res.json({ pending: c('PENDING') + c('UNDER_REVIEW') + c('FOR_SUPERVISOR_REVIEW') + c('FOR_FINAL_APPROVAL'), approved: c('APPROVED'), rejected: c('REJECTED'), today, week, onLeave, upcoming, attention });
});
app.get('/api/admin/leaves', requireAuth, requireRole(...HR_ROLES), (req, res) => {
  const { search = '', status = '', leave_type = '', department = '', from = '', to = '', page = 1, limit = 20 } = req.query;
  const conds = [], args = [];
  if (search) { conds.push('(e.name LIKE ? OR e.email LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }
  if (status) {
    if (status === 'PENDING_GROUP') conds.push(`a.status IN ('PENDING','UNDER_REVIEW','FOR_SUPERVISOR_REVIEW','FOR_FINAL_APPROVAL')`);
    else { conds.push('a.status=?'); args.push(status); }
  }
  if (leave_type) { conds.push('lt.code=?'); args.push(leave_type); }
  if (department) { conds.push('e.department=?'); args.push(department); }
  if (from) { conds.push('a.start_date>=?'); args.push(from); }
  if (to) { conds.push('a.end_date<=?'); args.push(to); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM leave_applications a JOIN employees e ON e.id=a.employee_id JOIN leave_types lt ON lt.id=a.leave_type_id ${where}`).get(...args).c;
  const rows = db.prepare(`SELECT a.*, e.name employee_name, e.department, e.email employee_email, lt.name leave_name, lt.code leave_code
    FROM leave_applications a JOIN employees e ON e.id=a.employee_id JOIN leave_types lt ON lt.id=a.leave_type_id
    ${where} ORDER BY a.submitted_at DESC LIMIT ? OFFSET ?`).all(...args, +limit, (+page - 1) * +limit);
  res.json({ total, rows });
});
app.get('/api/admin/leaves/:id', requireAuth, requireRole(...HR_ROLES), (req, res) => {
  const a = appFull(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  a.extra_details = JSON.parse(a.extra_details || '{}');
  a.docs = db.prepare('SELECT id, filename, mimetype, size, created_at FROM supporting_documents WHERE application_id=?').all(a.id);
  a.history = db.prepare('SELECT * FROM leave_approvals WHERE application_id=? ORDER BY created_at').all(a.id);
  a.pendingCount = db.prepare(`SELECT COUNT(*) c FROM leave_applications WHERE employee_id=? AND status IN ('PENDING','UNDER_REVIEW','FOR_SUPERVISOR_REVIEW','FOR_FINAL_APPROVAL') AND id!=?`).get(a.employee_id, a.id).c;
  const bal = db.prepare('SELECT earned, used, pending FROM leave_balances WHERE employee_id=? AND leave_type_id=?').get(a.employee_id, a.leave_type_id);
  a.balance = bal || { earned: 0, used: 0, pending: 0 };
  a.balance.remaining = a.balance.earned - a.balance.used - a.balance.pending;
  a.balance.after = a.balance.remaining;
  a.insufficient = a.balance.after < 0 || (a.balance.earned - a.balance.used) < a.working_days;
  res.json(a);
});
app.post('/api/admin/leaves/:id/review', requireAuth, requireRole(...HR_ROLES), (req, res) => {
  const { action, comment = '' } = req.body || {};
  const a = appFull(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (['APPROVED', 'REJECTED', 'CANCELLED'].includes(a.status)) return res.status(400).json({ error: 'Already finalized: ' + a.status });
  const step = a.status === 'PENDING' ? 'HR_REVIEW' : a.status;
  if (action === 'reject') {
    if (!comment.trim()) return res.status(400).json({ error: 'Rejection reason is required' });
    db.prepare("UPDATE leave_applications SET status='REJECTED', updated_at=datetime('now') WHERE id=?").run(a.id);
    db.prepare('UPDATE leave_balances SET pending=CASE WHEN pending-? < 0 THEN 0 ELSE pending-? END WHERE employee_id=? AND leave_type_id=?')
      .run(a.working_days, a.working_days, a.employee_id, a.leave_type_id);
    db.prepare('INSERT INTO leave_approvals (application_id, approver_id, step, action, comment) VALUES (?,?,?,?,?)')
      .run(a.id, req.user.id, step, 'REJECTED', comment);
    audit(req.user.id, req.user.email, 'application_rejected', 'leave_application', a.id, comment);
    const empUser = db.prepare('SELECT id FROM users WHERE employee_id=?').get(a.employee_id);
    if (empUser) notify(empUser.id, 'Leave rejected', `${a.leave_name}: ${comment}`, 'leave');
    return res.json({ ok: true, status: 'REJECTED' });
  }
  if (action === 'approve') {
    const needsMulti = MULTI_STEP_CODES.has(a.leave_code);
    let next = 'APPROVED';
    if (needsMulti && a.status === 'PENDING') next = 'FOR_SUPERVISOR_REVIEW';
    else if (needsMulti && a.status === 'UNDER_REVIEW') next = 'FOR_SUPERVISOR_REVIEW';
    else if (a.status === 'FOR_SUPERVISOR_REVIEW') next = 'FOR_FINAL_APPROVAL';
    if (!TRANSITIONS[a.status].includes(next) && !(a.status === 'PENDING' && next === 'APPROVED'))
      next = 'APPROVED';
    db.prepare('UPDATE leave_applications SET status=?, updated_at=datetime(\'now\') WHERE id=?').run(next, a.id);
    db.prepare('INSERT INTO leave_approvals (application_id, approver_id, step, action, comment) VALUES (?,?,?,?,?)')
      .run(a.id, req.user.id, step, next === 'APPROVED' ? 'APPROVED' : 'ADVANCED', comment || ('Moved to ' + next));
    if (next === 'APPROVED') {
      db.prepare('UPDATE leave_balances SET pending=CASE WHEN pending-? < 0 THEN 0 ELSE pending-? END, used=used+? WHERE employee_id=? AND leave_type_id=?')
        .run(a.working_days, a.working_days, a.working_days, a.employee_id, a.leave_type_id);
      db.prepare('INSERT INTO leave_balance_transactions (employee_id, leave_type_id, delta, type, reason, actor_id) VALUES (?,?,?,?,?,?)')
        .run(a.employee_id, a.leave_type_id, -a.working_days, 'debit', `Approved ${a.leave_name} ${a.start_date}→${a.end_date}`, req.user.id);
    }
    const bal = db.prepare('SELECT earned, used, pending FROM leave_balances WHERE employee_id=? AND leave_type_id=?').get(a.employee_id, a.leave_type_id) || { earned: 0, used: 0, pending: 0 };
    const insufficient = (bal.earned - bal.used - bal.pending) < 0;
    audit(req.user.id, req.user.email, next === 'APPROVED' ? 'application_approved' : 'application_advanced', 'leave_application', a.id, `→ ${next}`);
    const empUser = db.prepare('SELECT id FROM users WHERE employee_id=?').get(a.employee_id);
    if (empUser) notify(empUser.id, next === 'APPROVED' ? 'Leave approved' : 'Leave moved to ' + next, `${a.leave_name} ${a.start_date}→${a.end_date}`, 'leave');
    return res.json({ ok: true, status: next, insufficient });
  }
  if (action === 'advance') {
    const order = ['PENDING', 'UNDER_REVIEW', 'FOR_SUPERVISOR_REVIEW', 'FOR_FINAL_APPROVAL'];
    const i = order.indexOf(a.status);
    if (i < 0) return res.status(400).json({ error: 'Cannot advance from ' + a.status });
    const next = order[i + 1] || 'FOR_FINAL_APPROVAL';
    db.prepare('UPDATE leave_applications SET status=?, updated_at=datetime(\'now\') WHERE id=?').run(next, a.id);
    db.prepare('INSERT INTO leave_approvals (application_id, approver_id, step, action, comment) VALUES (?,?,?,?,?)')
      .run(a.id, req.user.id, step, 'ADVANCED', comment || ('Advanced to ' + next));
    audit(req.user.id, req.user.email, 'application_advanced', 'leave_application', a.id, `→ ${next}`);
    return res.json({ ok: true, status: next });
  }
  res.status(400).json({ error: 'action must be approve|reject|advance' });
});

// employees
app.get('/api/admin/employees', requireAuth, requireRole(...HR_ROLES), (req, res) => {
  res.json(db.prepare('SELECT * FROM employees ORDER BY name').all());
});
app.post('/api/admin/employees', requireAuth, requireRole('hr_admin', 'sys_admin'), (req, res) => {
  const { employee_no, name, email, phone = '', department = '', position = '', status = 'active', date_hired = '' } = req.body || {};
  if (!name || !email || !employee_no) return res.status(400).json({ error: 'employee_no, name, email required' });
  try {
    const r = db.prepare('INSERT INTO employees (employee_no, name, email, phone, department, position, status, date_hired) VALUES (?,?,?,?,?,?,?,?)')
      .run(employee_no, name, email, phone, department, position, status, date_hired);
    const vacId = db.prepare("SELECT id FROM leave_types WHERE code='vacation'").get()?.id;
    if (vacId) for (const [code, earned] of [['vacation', 25], ['sick', 15], ['spl', 5]]) {
      const lt = db.prepare('SELECT id FROM leave_types WHERE code=?').get(code);
      if (lt) db.prepare('INSERT OR IGNORE INTO leave_balances (employee_id, leave_type_id, earned) VALUES (?,?,?)').run(lid(r), lt.id, earned);
    }
    audit(req.user.id, req.user.email, 'employee_created', 'employee', lid(r), name);
    res.json({ id: lid(r) });
  } catch (e) { res.status(400).json({ error: 'Duplicate employee_no or email' }); }
});
app.put('/api/admin/employees/:id', requireAuth, requireRole('hr_admin', 'sys_admin'), (req, res) => {
  const { name, email, phone, department, position, status, date_hired } = req.body || {};
  db.prepare('UPDATE employees SET name=COALESCE(?,name), email=COALESCE(?,email), phone=COALESCE(?,phone), department=COALESCE(?,department), position=COALESCE(?,position), status=COALESCE(?,status), date_hired=COALESCE(?,date_hired) WHERE id=?')
    .run(name, email, phone, department, position, status, date_hired, req.params.id);
  audit(req.user.id, req.user.email, 'employee_modified', 'employee', req.params.id, 'Updated');
  res.json({ ok: true });
});
app.delete('/api/admin/employees/:id', requireAuth, requireRole('hr_admin', 'sys_admin'), (req, res) => {
  db.prepare("UPDATE employees SET status='disabled' WHERE id=?").run(req.params.id);
  audit(req.user.id, req.user.email, 'employee_disabled', 'employee', req.params.id, 'Disabled');
  res.json({ ok: true });
});

// balances admin
app.get('/api/admin/balances', requireAuth, requireRole(...HR_ROLES), (req, res) => {
  const { employee_id } = req.query;
  let sql = `SELECT b.*, lt.code, lt.name, e.name employee_name FROM leave_balances b JOIN leave_types lt ON lt.id=b.leave_type_id JOIN employees e ON e.id=b.employee_id`;
  const args = [];
  if (employee_id) { sql += ' WHERE b.employee_id=?'; args.push(employee_id); }
  sql += ' ORDER BY e.name, lt.name';
  res.json(db.prepare(sql).all(...args).map(r => ({ ...r, remaining: r.earned - r.used - r.pending })));
});
app.post('/api/admin/balances/adjust', requireAuth, requireRole('hr_admin', 'sys_admin'), (req, res) => {
  const { employee_id, leave_type_id, delta, reason = '' } = req.body || {};
  if (!employee_id || !leave_type_id || delta === undefined) return res.status(400).json({ error: 'employee_id, leave_type_id, delta required' });
  if (!reason.trim()) return res.status(400).json({ error: 'Reason is required for manual adjustment' });
  const prev = db.prepare('SELECT * FROM leave_balances WHERE employee_id=? AND leave_type_id=?').get(employee_id, leave_type_id) || { earned: 0, used: 0, pending: 0 };
  db.prepare(`INSERT INTO leave_balances (employee_id, leave_type_id, earned, used, pending) VALUES (?,?,?,0,0)
    ON CONFLICT(employee_id, leave_type_id) DO UPDATE SET earned=earned+?`).run(employee_id, leave_type_id, +delta, +delta);
  db.prepare('INSERT INTO leave_balance_transactions (employee_id, leave_type_id, delta, type, reason, actor_id) VALUES (?,?,?,?,?,?)')
    .run(employee_id, leave_type_id, +delta, 'adjust', reason, req.user.id);
  audit(req.user.id, req.user.email, 'leave_balance_changed', 'leave_balance', `${employee_id}/${leave_type_id}`, `prev earned=${prev.earned} delta=${delta} reason=${reason}`);
  const empUser = db.prepare('SELECT id FROM users WHERE employee_id=?').get(employee_id);
  if (empUser) notify(empUser.id, 'Leave balance changed', reason, 'balance');
  res.json({ ok: true });
});

// holidays admin
app.post('/api/admin/holidays', requireAuth, requireRole('hr_admin', 'sys_admin'), (req, res) => {
  const { date, name, kind = 'regular' } = req.body || {};
  if (!date || !name) return res.status(400).json({ error: 'date and name required' });
  try {
    const r = db.prepare('INSERT INTO holidays (date, name, kind) VALUES (?,?,?)').run(date, name, kind);
    audit(req.user.id, req.user.email, 'holiday_added', 'holiday', lid(r), name);
    res.json({ id: lid(r) });
  } catch { res.status(400).json({ error: 'Holiday date already exists' }); }
});
app.put('/api/admin/holidays/:id', requireAuth, requireRole('hr_admin', 'sys_admin'), (req, res) => {
  const { date, name, kind } = req.body || {};
  db.prepare('UPDATE holidays SET date=COALESCE(?,date), name=COALESCE(?,name), kind=COALESCE(?,kind) WHERE id=?').run(date, name, kind, req.params.id);
  audit(req.user.id, req.user.email, 'holiday_modified', 'holiday', req.params.id, 'Updated');
  res.json({ ok: true });
});
app.delete('/api/admin/holidays/:id', requireAuth, requireRole('hr_admin', 'sys_admin'), (req, res) => {
  db.prepare('DELETE FROM holidays WHERE id=?').run(req.params.id);
  audit(req.user.id, req.user.email, 'holiday_deleted', 'holiday', req.params.id, 'Deleted');
  res.json({ ok: true });
});

// leave types admin
app.put('/api/admin/leave-types/:id', requireAuth, requireRole('hr_admin', 'sys_admin'), (req, res) => {
  const { active, name, max_days } = req.body || {};
  db.prepare('UPDATE leave_types SET active=COALESCE(?,active), name=COALESCE(?,name), max_days=COALESCE(?,max_days) WHERE id=?').run(active, name, max_days, req.params.id);
  audit(req.user.id, req.user.email, 'leave_type_changed', 'leave_type', req.params.id, 'Updated');
  res.json({ ok: true });
});

// audit / reports / calendar admin
app.get('/api/admin/audit', requireAuth, requireRole('hr_admin', 'sys_admin'), (req, res) => {
  const { search = '', action = '', page = 1, limit = 30 } = req.query;
  const conds = [], args = [];
  if (search) { conds.push('(actor_email LIKE ? OR description LIKE ? OR entity LIKE ?)'); args.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (action) { conds.push('action=?'); args.push(action); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM audit_logs ${where}`).get(...args).c;
  const rows = db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, +limit, (+page - 1) * +limit);
  res.json({ total, rows });
});
function reportRows(q) {
  const conds = [], args = [];
  if (q.from) { conds.push('a.start_date>=?'); args.push(q.from); }
  if (q.to) { conds.push('a.end_date<=?'); args.push(q.to); }
  if (q.department) { conds.push('e.department=?'); args.push(q.department); }
  if (q.leave_type) { conds.push('lt.code=?'); args.push(q.leave_type); }
  if (q.status) { conds.push('a.status=?'); args.push(q.status); }
  if (q.employee_id) { conds.push('a.employee_id=?'); args.push(q.employee_id); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  return db.prepare(`SELECT a.id, e.name employee_name, e.department, e.employee_no, lt.name leave_name, a.start_date, a.end_date, a.working_days, a.status, a.submitted_at
    FROM leave_applications a JOIN employees e ON e.id=a.employee_id JOIN leave_types lt ON lt.id=a.leave_type_id ${where} ORDER BY a.start_date`).all(...args);
}
app.get('/api/admin/reports/summary', requireAuth, requireRole(...HR_ROLES), (req, res) => {
  const rows = reportRows(req.query);
  const byStatus = {}, byType = {}, byDept = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    byType[r.leave_name] = (byType[r.leave_name] || 0) + r.working_days;
    byDept[r.department] = (byDept[r.department] || 0) + 1;
  }
  audit(req.user.id, req.user.email, 'report_generated', 'report', '', JSON.stringify(req.query));
  res.json({ total: rows.length, totalDays: rows.reduce((s, r) => s + r.working_days, 0), byStatus, byType, byDept, rows: rows.slice(0, 200) });
});
app.get('/api/admin/reports/export.csv', requireAuth, requireRole(...HR_ROLES), (req, res) => {
  const rows = reportRows(req.query);
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = 'id,employee,employee_no,department,leave,start,end,working_days,status,submitted\n' +
    rows.map(r => [r.id, esc(r.employee_name), r.employee_no, esc(r.department), esc(r.leave_name), r.start_date, r.end_date, r.working_days, r.status, r.submitted_at].join(',')).join('\n');
  audit(req.user.id, req.user.email, 'report_generated', 'report_csv', '', `${rows.length} rows`);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leave-report.csv"');
  res.send(csv);
});
app.get('/api/admin/calendar', requireAuth, requireRole(...HR_ROLES), (req, res) => {
  const { month, department = '', status = 'APPROVED' } = req.query;
  const m = month || new Date().toISOString().slice(0, 7);
  let sql = `SELECT a.*, e.name employee_name, e.department, lt.name leave_name FROM leave_applications a
    JOIN employees e ON e.id=a.employee_id JOIN leave_types lt ON lt.id=a.leave_type_id
    WHERE substr(a.start_date,1,7)<=? AND substr(a.end_date,1,7)>=?`;
  const args = [m, m];
  if (department) { sql += ' AND e.department=?'; args.push(department); }
  if (status) { sql += ' AND a.status=?'; args.push(status); }
  res.json(db.prepare(sql).all(...args));
});

// users + settings admin
app.get('/api/admin/users', requireAuth, requireRole('sys_admin', 'hr_admin'), (req, res) => {
  res.json(db.prepare('SELECT u.id, u.email, u.role, u.active, u.employee_id, e.name employee_name FROM users u LEFT JOIN employees e ON e.id=u.employee_id ORDER BY u.email').all());
});
app.post('/api/admin/users', requireAuth, requireRole('sys_admin'), (req, res) => {
  const { email, password, role = 'employee', employee_id = null } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const r = db.prepare('INSERT INTO users (email, password_hash, role, employee_id) VALUES (?,?,?,?)')
      .run(String(email).toLowerCase(), bcrypt.hashSync(password, 10), role, employee_id);
    audit(req.user.id, req.user.email, 'user_created', 'user', lid(r), email);
    res.json({ id: lid(r) });
  } catch { res.status(400).json({ error: 'Email already exists' }); }
});
app.put('/api/admin/users/:id', requireAuth, requireRole('sys_admin'), (req, res) => {
  const { role, active } = req.body || {};
  db.prepare('UPDATE users SET role=COALESCE(?,role), active=COALESCE(?,active) WHERE id=?').run(role, active, req.params.id);
  audit(req.user.id, req.user.email, 'user_modified', 'user', req.params.id, 'Updated');
  res.json({ ok: true });
});
app.get('/api/admin/settings', requireAuth, requireRole(...HR_ROLES), (req, res) => {
  res.json(Object.fromEntries(db.prepare('SELECT key, value FROM system_settings').all().map(r => [r.key, r.value])));
});
app.put('/api/admin/settings', requireAuth, requireRole('hr_admin', 'sys_admin'), (req, res) => {
  for (const [k, v] of Object.entries(req.body || {}))
    db.prepare('INSERT INTO system_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?').run(k, String(v), String(v));
  audit(req.user.id, req.user.email, 'admin_settings_changed', 'settings', '', 'Updated settings');
  res.json({ ok: true });
});

// ---------- error + fallback ----------
app.use((err, req, res, next) => {
  if (err.message && /Only PDF/.test(err.message)) return res.status(400).json({ error: err.message });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large (max 5MB)' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => console.log(`Leave Management System running on http://localhost:${PORT}`));
