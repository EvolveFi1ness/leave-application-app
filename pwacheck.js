const { spawn } = require('child_process');
const srv = spawn('node', ['server.js'], { cwd: __dirname });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try { const r = await fetch('http://localhost:3000/login.html'); if (r.ok) break; } catch {}
  }
  const out = [];
  for (const p of ['/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable.png', '/employee.html', '/admin.html']) {
    try {
      const r = await fetch('http://localhost:3000' + p);
      out.push(`${r.ok ? 'PASS' : 'FAIL'} ${p} ${r.status} ${r.headers.get('content-type')}`);
    } catch (e) { out.push('FAIL ' + p + ' ' + e.message); }
  }
  try {
    const m = await (await fetch('http://localhost:3000/manifest.webmanifest')).json();
    out.push(`PASS manifest icons=${m.icons.length} start=${m.start_url}`);
    const e = await (await fetch('http://localhost:3000/employee.html')).text();
    out.push(`${e.includes('manifest.webmanifest') ? 'PASS' : 'FAIL'} employee pwa tags`);
    out.push(`${e.includes('serviceWorker') ? 'PASS' : 'FAIL'} employee sw register`);
  } catch (e) { out.push('FAIL parse ' + e.message); }
  console.log(out.join('\n'));
  srv.kill();
  setTimeout(() => process.exit(0), 500);
})();
