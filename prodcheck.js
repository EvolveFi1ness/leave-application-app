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
  const fails = out.filter(l => l.startsWith('FAIL')).length;
  setTimeout(() => process.exit(fails ? 1 : 0), 500);
})();
