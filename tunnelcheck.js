const { spawn } = require('child_process');
const srv = spawn('node', ['server.js'], { cwd: __dirname });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try { const r = await fetch('http://localhost:3000/login.html'); if (r.ok) break; } catch {}
  }
  const tun = spawn('/tmp/cloudflared', ['tunnel', '--url', 'http://localhost:3000'], { cwd: __dirname });
  let log = '';
  tun.stderr.on('data', d => { log += d; });
  tun.stdout.on('data', d => { log += d; });
  let url = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) { url = m[0]; break; }
  }
  console.log('TUNNEL_URL=' + (url || 'NONE'));
  if (url) {
    await require('fs').promises.writeFile('/tmp/tunnel_url.txt', url);
    for (let i = 0; i < 10; i++) {
      try {
        const r = await fetch(url + '/login.html');
        console.log('PUBLIC_STATUS=' + r.status);
        if (r.ok) { console.log('PUBLIC_OK'); break; }
      } catch (e) { console.log('RETRY ' + e.message); }
      await sleep(2000);
    }
  } else {
    console.log('--- TUNNEL LOG ---');
    console.log(log.slice(0, 3000));
  }
  tun.kill(); srv.kill();
  setTimeout(() => process.exit(0), 800);
})();
