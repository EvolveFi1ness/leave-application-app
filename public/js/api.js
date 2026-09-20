window.Api = (() => {
  async function req(method, url, body, opts = {}) {
    const r = await fetch(url, { method, credentials: 'include',
      headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
      body: body instanceof FormData ? body : (body ? JSON.stringify(body) : undefined), ...opts });
    if (r.status === 401 && !location.pathname.endsWith('login.html')) { location.href = 'login.html'; throw new Error('Login required'); }
    const t = await r.text();
    let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { error: t }; }
    if (!r.ok) throw new Error(j.error || ('Request failed ' + r.status));
    return j;
  }
  return {
    get: (u) => req('GET', u), post: (u, b) => req('POST', u, b),
    put: (u, b) => req('PUT', u, b), del: (u) => req('DELETE', u),
    upload: (u, fd) => req('POST', u, fd),
    login: (email, password) => req('POST', '/api/auth/login', { email, password }),
    me: () => req('GET', '/api/auth/me'),
  };
})();
window.esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
