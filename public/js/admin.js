const Admin = (() => {
  let me = null, view = 'dash';
  const app = () => document.getElementById('app');
  const menu = [['dash', 'Dashboard'], ['apps', 'Applications'], ['emps', 'Employees'], ['bals', 'Leave Balances'], ['cal', 'Leave Calendar'], ['reps', 'Reports'], ['audit', 'Audit Logs'], ['types', 'Leave Types'], ['hols', 'Holidays'], ['users', 'Users'], ['set', 'Settings']];
  async function init() {
    try {
      me = (await Api.me()).user;
      if (me.role === 'employee') { location.href = 'employee.html'; return; }
      document.getElementById('who').textContent = me.employee?.name + ' • ' + me.role;
      document.getElementById('menu').innerHTML = menu.map(([k, l]) => `<button data-v="${k}" class="${k === view ? 'on' : ''}" onclick="Admin.go('${k}')">${l}</button>`).join('');
      go('dash');
    } catch (e) { app().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }
  async function go(v) {
    view = v; document.getElementById('ttl').textContent = v;
    document.querySelectorAll('#menu button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    app().innerHTML = 'Loading…';
    try {
      if (v === 'dash') {
        const s = await Api.get('/api/admin/stats');
        app().innerHTML = `<div class="grid4"><div class="card"><div class="muted">PENDING</div><div style="font-size:30px;font-weight:800">${s.pending}</div></div>
        <div class="card"><div class="muted">APPROVED</div><div style="font-size:30px;font-weight:800">${s.approved}</div></div>
        <div class="card"><div class="muted">REJECTED</div><div style="font-size:30px;font-weight:800">${s.rejected}</div></div>
        <div class="card"><div class="muted">ON LEAVE NOW</div><div style="font-size:30px;font-weight:800">${s.onLeave}</div></div></div>
        <div class="card">Today: <b>${s.today}</b> • This week: <b>${s.week}</b></div>
        <div class="card"><b>Requires attention</b>${s.attention.map(a => `<div><button class="btn sec" onclick="Admin.review(${a.id})">#${a.id} ${esc(a.employee_name)} — ${esc(a.leave_name)}</button></div>`).join('') || '<div class=muted>All clear</div>'}</div>
        <div class="card"><b>Upcoming leave</b>${s.upcoming.map(a => `<div>${esc(a.start_date)} — ${esc(a.employee_name)} (${esc(a.leave_name)})</div>`).join('') || '<div class=muted>None</div>'}</div>`;
      } else if (v === 'apps') {
        const types = await Api.get('/api/leave-types');
        app().innerHTML = `<div class="card"><input id="q" placeholder="Search Employee" oninput="Admin.debounce()"><div style="display:flex;gap:6px;margin:8px 0;flex-wrap:wrap">
        ${['', 'PENDING_GROUP', 'APPROVED', 'REJECTED', 'ALL'].map(s => `<button class="btn sec" onclick="Admin.fStatus('${s}')">${s || 'All-staff'}</button>`).join('')}</div>
        <div class="grid2"><select id="f_lt"><option value="">Leave Type: all</option>${types.map(t => `<option value="${t.code}">${esc(t.name)}</option>`).join('')}</select>
        <input id="f_dp" placeholder="Department"></div><div class="grid2" style="margin-top:8px"><input type="date" id="f_from"><input type="date" id="f_to"></div></div><div id="lr"></div>`;
        window._fs = '';
        listApps();
      } else if (v === 'emps') {
        const rows = await Api.get('/api/admin/employees');
        app().innerHTML = `<button class="btn" onclick="Admin.empForm()">+ Create employee</button><div class="card"><table><tr><th>Name</th><th>ID</th><th>Dept</th><th>Status</th><th></th></tr>
        ${rows.map(e => `<tr><td>${esc(e.name)}<br><span class=muted>${esc(e.email)}</span></td><td>${esc(e.employee_no)}</td><td>${esc(e.department)}</td><td>${esc(e.status)}</td><td><button class="btn sec" onclick="Admin.empDetail(${e.id})">Open</button></td></tr>`).join('')}</table></div><div id="ed"></div>`;
      } else if (v === 'bals') {
        const emps = await Api.get('/api/admin/employees');
        app().innerHTML = `<div class="card"><label>Employee</label><select id="b_e" onchange="Admin.bals()">${emps.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select><div id="bl"></div></div>`;
        bals();
      } else if (v === 'cal') {
        app().innerHTML = `<div class="card"><input type="month" id="c_m" value="${new Date().toISOString().slice(0, 7)}" onchange="Admin.cal()"><input id="c_d" placeholder="Department filter" oninput="Admin.cal()"></div><div id="cl"></div>`;
        cal();
      } else if (v === 'reps') {
        app().innerHTML = `<div class="card"><h3>Reports</h3><div class="grid2"><input type="date" id="r_from"><input type="date" id="r_to"></div>
        <div class="grid2" style="margin-top:8px"><input id="r_dp" placeholder="Department"><select id="r_st"><option value="">Any status</option><option>PENDING</option><option>APPROVED</option><option>REJECTED</option></select></div>
        <div style="margin-top:8px;display:flex;gap:8px"><button class="btn" onclick="Admin.rep()">Run</button><button class="btn sec" onclick="Admin.repCsv()">Export CSV</button></div></div><div id="rl"></div>`;
      } else if (v === 'audit') {
        app().innerHTML = `<div class="card"><input id="a_q" placeholder="Search actor/description" oninput="Admin.auditL()"></div><div id="al"></div>`;
        auditL();
      } else if (v === 'types') {
        const types = await Api.get('/api/leave-types');
        app().innerHTML = types.map(t => `<div class="card"><b>${esc(t.name)}</b> (${t.code}) — ${t.active ? 'enabled' : 'disabled'} <button class="btn sec" onclick="Admin.toggleT(${t.id},${t.active ? 0 : 1})">${t.active ? 'Disable' : 'Enable'}</button></div>`).join('');
      } else if (v === 'hols') {
        const hs = await Api.get('/api/holidays');
        app().innerHTML = `<div class="card"><h3>Add holiday</h3><div class="grid2"><input type="date" id="h_d"><input id="h_n" placeholder="Name"></div><select id="h_k"><option>regular</option><option>special</option></select><button class="btn" onclick="Admin.addH()">Add</button></div>
        ${hs.map(h => `<div class="card">${esc(h.date)} — <b>${esc(h.name)}</b> (${h.kind}) <button class="btn danger" onclick="Admin.delH(${h.id})">Delete</button></div>`).join('')}`;
      } else if (v === 'users') {
        const us = await Api.get('/api/admin/users');
        app().innerHTML = `<div class="card"><table><tr><th>Email</th><th>Role</th><th>Active</th></tr>${us.map(u => `<tr><td>${esc(u.email)}</td><td>${u.role}</td><td>${u.active}</td></tr>`).join('')}</table></div>
        <div class="card"><h3>Create user (sys_admin)</h3><input id="u_e" placeholder="email"><input id="u_p" placeholder="password"><select id="u_r"><option>employee</option><option>supervisor</option><option>hr_staff</option><option>hr_admin</option><option>final_approver</option><option>sys_admin</option></select><button class="btn" onclick="Admin.addU()">Create</button><div id="um"></div></div>`;
      } else if (v === 'set') {
        const s = await Api.get('/api/admin/settings');
        app().innerHTML = `<div class="card"><h3>System Settings</h3>${['org_name', 'office', 'char_limit', 'cancellation_policy', 'upload_max_mb', 'workflow_default'].map(k => `<label>${k}</label><input id="s_${k}" value="${esc(s[k] || '')}">`).join('')}<br><button class="btn" onclick="Admin.saveS()">Save</button><div id="sm"></div></div>`;
      }
    } catch (e) { app().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }
  let deb = null;
  async function listApps() {
    const p = new URLSearchParams({ search: (document.getElementById('q') || {}).value || '', status: window._fs || '', leave_type: (document.getElementById('f_lt') || {}).value || '', department: (document.getElementById('f_dp') || {}).value || '', from: (document.getElementById('f_from') || {}).value || '', to: (document.getElementById('f_to') || {}).value || '' });
    const j = await Api.get('/api/admin/leaves?' + p);
    document.getElementById('lr').innerHTML = `<div class="muted">${j.total} result(s)</div>` + j.rows.map(r => `<div class="card"><b>#${r.id} ${esc(r.employee_name)}</b> <span class="badge badge-${r.status}">${r.status}</span><br>${esc(r.leave_name)} • ${esc(r.start_date)} → ${esc(r.end_date)} (${r.working_days}d)<br><button class="btn sec" onclick="Admin.review(${r.id})">Review</button></div>`).join('');
  }
  async function review(id) {
    app().innerHTML = 'Loading…';
    const a = await Api.get('/api/admin/leaves/' + id);
    app().innerHTML = `<button class="btn ghost" onclick="Admin.go('apps')">← Back</button><div class="card"><h3>EMPLOYEE</h3><b>${esc(a.employee_name)}</b><br>${esc(a.department)} • ${esc(a.employee_email)}
    <h3>${esc(a.leave_name)} — ${a.working_days} DAY(S)</h3>Interval: ${esc(a.start_date)} → ${esc(a.end_date)}<br>Emergency: ${esc(a.emergency_name)} ${esc(a.emergency_phone)}<br>Reason: ${esc(a.reason)}
    <pre class="muted">${esc(JSON.stringify(a.extra_details))}</pre>
    <h4>SUPPORTING DOCUMENTS</h4>${(a.docs || []).map(d => `<div><a target="_blank" href="/api/documents/${d.id}">${esc(d.filename)}</a></div>`).join('') || '<div class=muted>None</div>'}
    <h4>History</h4>${(a.history || []).map(h => `<div class="muted">${esc(h.step)} ${esc(h.action)} — ${esc(h.comment)}</div>`).join('')}
    <div class="card">Balance: earned ${a.balance.earned}, used ${a.balance.used}, pending ${a.balance.pending}, remaining ${a.balance.remaining}. Pending requests: ${a.pendingCount}. ${a.insufficient ? '<b style=color:red>WARNING: insufficient balance</b>' : ''}</div>
    <h4>HR REVIEW</h4><label>Comments</label><textarea id="rv_c" rows="3"></textarea><div id="rve"></div>
    <div style="display:flex;gap:8px;margin-top:8px"><button class="btn danger" onclick="Admin.doReview(${a.id},'reject')">REJECT</button><button class="btn" onclick="Admin.doReview(${a.id},'approve')">APPROVE</button><a class="btn sec" href="print.html?id=${a.id}">Print</a></div></div>`;
  }
  async function doReview(id, action) {
    const comment = (document.getElementById('rv_c') || {}).value || '';
    try {
      const j = await Api.post(`/api/admin/leaves/${id}/review`, { action, comment });
      alert((action === 'approve' ? 'Approved' : 'Rejected') + (j.insufficient ? ' (WARNING: insufficient balance)' : ''));
      go('apps');
    } catch (e) { document.getElementById('rve').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }
  async function empDetail(id) {
    const [emps, bals] = [await Api.get('/api/admin/employees'), await Api.get('/api/admin/balances?employee_id=' + id)];
    const e = emps.find(x => x.id === id);
    const hist = await Api.get(`/api/admin/leaves?status=&search=${encodeURIComponent(e.name)}`);
    document.getElementById('ed').innerHTML = `<div class="card"><b>${esc(e.name)}</b> (${esc(e.employee_no)})<br>${esc(e.email)} • ${esc(e.phone)}<br>${esc(e.department)} • ${esc(e.position)} • ${esc(e.status)}
    <h4>Balances</h4>${bals.map(b => `<div>${esc(b.name)}: earned ${b.earned}, used ${b.used}, pending ${b.pending}, remaining ${b.remaining}</div>`).join('')}
    <h4>History</h4>${hist.rows.slice(0, 10).map(r => `<div>#${r.id} ${esc(r.leave_name)} ${r.status}</div>`).join('')}</div>`;
  }
  return {
    init, go, review, doReview, empDetail,
    debounce: () => { clearTimeout(deb); deb = setTimeout(listApps, 400); },
    fStatus: s => { window._fs = s === 'ALL' ? '' : s; listApps(); },
    bals: async () => {
      const id = document.getElementById('b_e').value;
      const rows = await Api.get('/api/admin/balances?employee_id=' + id);
      document.getElementById('bl').innerHTML = rows.map(b => `<div class="card"><b>${esc(b.name)}</b><br>Earned ${b.earned} • Used ${b.used} • Pending ${b.pending} • Remaining ${b.remaining}
      <div style="display:flex;gap:6px;margin-top:6px"><input id="adj_${b.leave_type_id}" placeholder="delta e.g. 5 or -2" style="max-width:160px"><input id="adr_${b.leave_type_id}" placeholder="reason (required)"><button class="btn sec" onclick="Admin.adj(${id},${b.leave_type_id})">Adjust</button></div></div>`).join('');
    },
    adj: async (eid, ltid) => {
      const delta = +document.getElementById('adj_' + ltid).value, reason = document.getElementById('adr_' + ltid).value;
      try { await Api.post('/api/admin/balances/adjust', { employee_id: eid, leave_type_id: ltid, delta, reason }); alert('Adjusted'); Admin.bals(); }
      catch (e) { alert(e.message); }
    },
    cal: async () => {
      const m = document.getElementById('c_m').value, d = document.getElementById('c_d').value;
      const rows = await Api.get(`/api/admin/calendar?month=${m}&department=${encodeURIComponent(d)}`);
      const byDay = {};
      rows.forEach(r => { for (let dt = new Date(r.start_date); dt <= new Date(r.end_date); dt.setDate(dt.getDate() + 1)) { const k = dt.toISOString().slice(0, 10); (byDay[k] = byDay[k] || []).push(r); } });
      document.getElementById('cl').innerHTML = Object.keys(byDay).sort().map(k => `<div class="card"><b>${k}</b>${byDay[k].map(r => `<div>${esc(r.leave_name)} — ${esc(r.employee_name)}</div>`).join('')}</div>`).join('') || '<div class="empty">No leave.</div>';
    },
    rep: async () => {
      const p = new URLSearchParams({ from: r_from.value, to: r_to.value, department: r_dp.value, status: r_st.value });
      const j = await Api.get('/api/admin/reports/summary?' + p);
      document.getElementById('rl').innerHTML = `<div class="card">Total ${j.total} • Days ${j.totalDays}<br>By status: ${esc(JSON.stringify(j.byStatus))}<br>By type: ${esc(JSON.stringify(j.byType))}</div>` +
        j.rows.map(r => `<div class="card">#${r.id} ${esc(r.employee_name)} ${esc(r.leave_name)} ${r.status}</div>`).join('');
    },
    repCsv: () => {
      const p = new URLSearchParams({ from: r_from.value, to: r_to.value, department: r_dp.value, status: r_st.value });
      window.open('/api/admin/reports/export.csv?' + p, '_blank');
    },
    auditL: async () => {
      const q = (document.getElementById('a_q') || {}).value || '';
      const j = await Api.get('/api/admin/audit?search=' + encodeURIComponent(q));
      document.getElementById('al').innerHTML = `<div class="card"><table><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Desc</th></tr>${j.rows.map(r => `<tr><td>${esc(r.created_at)}</td><td>${esc(r.actor_email)}</td><td>${esc(r.action)}</td><td>${esc(r.entity)} ${esc(r.entity_id)}</td><td>${esc(r.description)}</td></tr>`).join('')}</table></div>`;
    },
    toggleT: async (id, active) => { await Api.put('/api/admin/leave-types/' + id, { active }); go('types'); },
    addH: async () => { try { await Api.post('/api/admin/holidays', { date: h_d.value, name: h_n.value, kind: h_k.value }); go('hols'); } catch (e) { alert(e.message); } },
    delH: async id => { if (confirm('Delete?')) { await Api.del('/api/admin/holidays/' + id); go('hols'); } },
    addU: async () => { try { const j = await Api.post('/api/admin/users', { email: u_e.value, password: u_p.value, role: u_r.value }); document.getElementById('um').textContent = 'Created #' + j.id; } catch (e) { document.getElementById('um').textContent = e.message; } },
    saveS: async () => {
      const body = {}; ['org_name', 'office', 'char_limit', 'cancellation_policy', 'upload_max_mb', 'workflow_default'].forEach(k => body[k] = document.getElementById('s_' + k).value);
      await Api.put('/api/admin/settings', body); document.getElementById('sm').textContent = 'Saved';
    },
    empForm: () => { document.getElementById('ed').innerHTML = `<div class="card"><input id="ne_no" placeholder="EMP-010"><input id="ne_n" placeholder="Full name"><input id="ne_e" placeholder="email"><input id="ne_d" placeholder="Department"><input id="ne_p" placeholder="Position"><button class="btn" onclick="Admin.empCreate()">Create</button></div>`; },
    empCreate: async () => {
      try { await Api.post('/api/admin/employees', { employee_no: ne_no.value, name: ne_n.value, email: ne_e.value, department: ne_d.value, position: ne_p.value, date_hired: new Date().toISOString().slice(0, 10) }); go('emps'); }
      catch (e) { alert(e.message); }
    },
    logout: async () => { await Api.post('/api/auth/logout'); location.href = 'login.html'; },
  };
})();
Admin.init();
