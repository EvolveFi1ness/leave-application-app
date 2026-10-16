const { spawn } = require('child_process');
const srv = spawn('node', ['server.js'], { cwd: __dirname });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try { const r = await fetch('http://localhost:3000/login.html'); if (r.ok) break; } catch {}
  }
  const out = [];
  for (const p of ['/download.html', '/downloads/qr.png', '/downloads/LeaveMS.apk']) {
    try {
      const r = await fetch('http://localhost:3000' + p);
      const buf = Buffer.from(await r.arrayBuffer());
      out.push(`${r.ok ? 'PASS' : 'FAIL'} ${p} ${r.status} bytes=${buf.length}`);
      if (p.endsWith('.apk')) out.push(`${buf.slice(0, 2).toString() === 'PK' ? 'PASS' : 'FAIL'} apk-zip-magic`);
    } catch (e) { out.push('FAIL ' + p + ' ' + e.message); }
  }
  console.log(out.join('\n'));
  srv.kill();
  const fails = out.filter(l => l.startsWith('FAIL')).length;
  setTimeout(() => process.exit(fails ? 1 : 0), 500);
})();
