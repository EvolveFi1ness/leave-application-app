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
    // Full bodies: send every column the handler destructures; null/undefined
    // fields are skipped by the patch layer, so untouched columns keep values.
    res = await fetch(B + `/api/admin/employees/${emp.id}`, { method: 'PUT', headers: HH, body: JSON.stringify({ name: 'Temp Renamed', email: 'temp900@example.com', phone: null, department: 'Operations', position: 'Staff', status: null, date_hired: '2026-01-05' }) });
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
    res = await fetch(B + `/api/admin/holidays/${hol.id}`, { method: 'PUT', headers: HH, body: JSON.stringify({ date: '2026-10-12', name: 'Renamed Holiday', kind: 'regular' }) });
    ck('holiday update ok', res.ok, res.status);
    res = await fetch(B + `/api/admin/holidays/${hol.id}`, { method: 'DELETE', headers: HH });
    ck('holiday delete ok', res.ok, res.status);

    // --- leave-type toggle numeric 0/1 (1 check) ---
    res = await fetch(B + `/api/admin/leave-types/${sick.id}`, { method: 'PUT', headers: HH, body: JSON.stringify({ active: 0, name: sick.name ?? null, max_days: sick.max_days ?? null }) });
    const tOff = res.ok;
    res = await fetch(B + '/api/leave-types', { headers: HH });
    const typesAfterOff = await res.json();
    const offOk = typesAfterOff.find(t => t.id === sick.id).active === 0;
    res = await fetch(B + `/api/admin/leave-types/${sick.id}`, { method: 'PUT', headers: HH, body: JSON.stringify({ active: 1, name: sick.name ?? null, max_days: sick.max_days ?? null }) });
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
