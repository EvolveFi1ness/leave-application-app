// Verifies public/js/api.js forwards the optional client field through
// Api.login and only redirects to login.html from pages other than /app.html.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'public', 'js', 'api.js'), 'utf8');

const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`);

function loadApi(pathname, fetchImpl) {
  const win = {};
  const loc = { pathname, href: 'about:blank' };
  const factory = new Function('window', 'location', 'fetch', src + '\nreturn window.Api;');
  return { api: factory(win, loc, fetchImpl), loc };
}

(async () => {
  let sent = null;
  const a = loadApi('/app.html', async (u, o) => {
    sent = JSON.parse(o.body);
    return { status: 200, ok: true, text: async () => JSON.stringify({ user: { role: 'employee' } }) };
  });
  await a.api.login('a@b.c', 'pw', { client: 'android' });
  check('login forwards client', sent && sent.client === 'android' && sent.email === 'a@b.c', JSON.stringify(sent));

  let sent2 = null;
  const b = loadApi('/login.html', async (u, o) => {
    sent2 = JSON.parse(o.body);
    return { status: 200, ok: true, text: async () => JSON.stringify({ user: { role: 'employee' } }) };
  });
  await b.api.login('a@b.c', 'pw');
  check('login without extra omits client', sent2 && !('client' in sent2) && sent2.email === 'a@b.c', JSON.stringify(sent2));

  const c = loadApi('/app.html', async () => ({ status: 401, ok: false, text: async () => '{}' }));
  let threw = false;
  try { await c.api.me(); } catch { threw = true; }
  check('app.html 401 does not redirect', threw && c.loc.href === 'about:blank', c.loc.href);

  const d = loadApi('/employee.html', async () => ({ status: 401, ok: false, text: async () => '{}' }));
  try { await d.api.me(); } catch {}
  check('employee.html 401 redirects to login', d.loc.href === 'login.html', d.loc.href);

  const sw = fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8');
  const swOk = sw.includes("u.pathname === '/admin.html'")
    && /fetch\(e\.request\)/.test(sw)
    && sw.includes('!res.redirected');
  check('sw.js network-first for admin.html', swOk, swOk ? '' : 'missing admin.html network-first branch');
  const shellOk = /const SHELL = \[[^\]]*'\/app\.html'/.test(sw);
  check('sw.js SHELL precaches /app.html', shellOk, shellOk ? '' : '/app.html missing from SHELL');

  console.log(results.join('\n'));
  process.exit(results.some(l => l.startsWith('FAIL')) ? 1 : 0);
})();
