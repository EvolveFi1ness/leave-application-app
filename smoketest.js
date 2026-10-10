const { spawn } = require('child_process');
const srv = spawn('node', ['server.js'], { cwd: __dirname });
let out = '';
srv.stdout.on('data', d => { out += d; });
srv.stderr.on('data', d => { out += d; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const r = await fetch('http://localhost:3000/login.html');
      if (r.ok) break;
    } catch {}
  }
  const results = [];
  const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
  try {
    const r = await fetch('http://localhost:3000/login.html');
    check('static login.html', r.ok, r.status);
    // login employee
    let res = await fetch('http://localhost:3000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'employee@example.com', password: 'password123' }) });
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    const lj = await res.json();
    check('employee login', res.ok && lj.user, JSON.stringify(lj.user || lj).slice(0, 120));
    const H = { Cookie: cookie, 'Content-Type': 'application/json' };
    res = await fetch('http://localhost:3000/api/balances/me', { headers: H });
    const bals = await res.json();
    check('balances/me', res.ok && bals.length >= 3, `rows=${bals.length}`);
    res = await fetch('http://localhost:3000/api/leave-types', { headers: H });
    const types = await res.json();
    check('leave-types', res.ok && types.length >= 10, `rows=${types.length}`);
    res = await fetch('http://localhost:3000/api/leaves/calculate', { method: 'POST', headers: H, body: JSON.stringify({ start_date: '2026-08-24', end_date: '2026-08-28' }) });
    const cd = await res.json();
    check('calculate working days', res.ok && cd.working_days === 5, JSON.stringify(cd));
    // submit a sick leave
    const sick = types.find(t => t.code === 'sick');
    res = await fetch('http://localhost:3000/api/leaves', { method: 'POST', headers: H, body: JSON.stringify({ leave_type_id: sick.id, start_date: '2026-09-28', end_date: '2026-09-29', reason: 'Smoke test flu', emergency_name: 'Ana', emergency_relationship: 'Spouse', emergency_phone: '+639171234567', extra_details: { care_type: 'outpatient', clinic: 'Clinic', illness: 'Flu' } }) });
    const created = await res.json();
    check('submit leave', res.ok && created.id, JSON.stringify(created).slice(0, 120));
    // HR login + review
    res = await fetch('http://localhost:3000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'hr@example.com', password: 'password123' }) });
    const hc = (res.headers.get('set-cookie') || '').split(';')[0];
    const HH = { Cookie: hc, 'Content-Type': 'application/json' };
    res = await fetch('http://localhost:3000/api/admin/stats', { headers: HH });
    check('admin stats', res.ok, (await res.text()).slice(0, 120));
    if (created.id) {
      res = await fetch(`http://localhost:3000/api/admin/leaves/${created.id}/review`, { method: 'POST', headers: HH, body: JSON.stringify({ action: 'approve', comment: 'Smoke OK' }) });
      check('approve leave', res.ok, (await res.text()).slice(0, 120));
      res = await fetch(`http://localhost:3000/api/leaves/${created.id}/print-data`, { headers: H });
      check('print-data', res.ok, (await res.text()).slice(0, 80));
    }
    res = await fetch('http://localhost:3000/api/admin/reports/export.csv', { headers: HH });
    check('csv export', res.ok && (res.headers.get('content-type') || '').includes('csv'));
    // --- app (Android) client separation ---
    res = await fetch('http://localhost:3000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'employee@example.com', password: 'password123', client: 'android' }) });
    const apj = await res.json();
    check('employee login via app client', res.ok && apj.user && apj.user.role === 'employee', JSON.stringify(apj).slice(0, 100));
    res = await fetch('http://localhost:3000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'hr@example.com', password: 'password123', client: 'android' }) });
    const hrj = await res.json();
    check('HR refused on app client', res.status === 403 && /web portal/.test(hrj.error || ''), `status=${res.status} ${JSON.stringify(hrj)}`);
    check('HR app refusal sets no cookie', !res.headers.get('set-cookie'), String(res.headers.get('set-cookie')));
    res = await fetch('http://localhost:3000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'hr@example.com', password: 'password123' }) });
    const hrw = await res.json();
    check('HR browser login unaffected', res.ok && hrw.user, JSON.stringify(hrw).slice(0, 100));
    // --- app entry route + admin block ---
    res = await fetch('http://localhost:3000/app.html');
    const appCookie = (res.headers.get('set-cookie') || '').split(';')[0];
    check('app.html serves', res.ok, res.status);
    res = await fetch('http://localhost:3000/admin.html', { headers: { Cookie: appCookie }, redirect: 'manual' });
    const loc1 = res.headers.get('location') || '';
    check('admin.html blocked for app session', res.status === 302 && loc1.includes('/app.html'), `${res.status} ${loc1}`);
    res = await fetch('http://localhost:3000/js/admin.js', { headers: { Cookie: appCookie }, redirect: 'manual' });
    check('admin.js blocked for app session', res.status === 302, res.status);
    res = await fetch('http://localhost:3000/admin.html', { redirect: 'manual' });
    check('admin.html open for unmarked session', res.ok, res.status);
    res = await fetch('http://localhost:3000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'hr@example.com', password: 'password123' }) });
    const hrc = (res.headers.get('set-cookie') || '').split(';')[0];
    check('hr login for clear test', res.ok, res.status);
    res = await fetch('http://localhost:3000/app.html', { headers: { Cookie: hrc }, redirect: 'manual' });
    const loc2 = res.headers.get('location') || '';
    check('app.html clears HR session', res.status === 302 && loc2.includes('blocked=1'), `${res.status} ${loc2}`);
    res = await fetch('http://localhost:3000/api/auth/me', { headers: { Cookie: hrc } });
    check('HR session destroyed', res.status === 401, res.status);
    res = await fetch('http://localhost:3000/app.html', { headers: { Cookie: cookie }, redirect: 'manual' });
    check('app.html serves employee session', res.status === 200, res.status);
    res = await fetch('http://localhost:3000/api/auth/me', { headers: { Cookie: cookie } });
    check('employee session intact after app.html', res.status === 200, res.status);
  } catch (e) { results.push('FAIL exception ' + e.message); }
  console.log('--- SMOKE ---');
  console.log(results.join('\n'));
  console.log('--- SERVER LOG ---');
  console.log(out.slice(0, 2000));
  srv.kill();
  setTimeout(() => process.exit(0), 500);
})();
