const UI = (() => {
  let me = null, balances = [], types = [], leaves = [], tab = 'home', filter = 'all', month = new Date().toISOString().slice(0, 7);
  let wiz = {};
  const el = id => document.getElementById(id);
  const app = () => document.getElementById('app');
  const balFor = code => balances.find(b => b.code === code);
  const balCard = (label, b) => `<div class="card" style="text-align:center"><div class="muted">${label}</div><div style="font-size:26px;font-weight:800">${b != null ? b.remaining : '—'}</div><div class="muted">Days</div></div>`;

  async function init() {
    try {
      me = (await Api.me()).user;
      if (me.role !== 'employee') { location.href = 'admin.html'; return; }
      el('nm').textContent = me.employee?.name || me.email;
      el('dp').textContent = `${me.employee?.position || ''} • ${me.employee?.department || ''}`;
      el('av').textContent = (me.employee?.name || 'E')[0].toUpperCase();
      types = await Api.get('/api/leave-types');
      await refresh();
    } catch (e) { app().innerHTML = `<div class="err">${esc(e.message)}</div><button class="btn" onclick="location.href='login.html'">Login</button>`; }
  }
  async function refresh() {
    balances = await Api.get('/api/balances/me');
    leaves = await Api.get('/api/leaves/me?filter=' + filter);
    render();
  }
  function statusBadge(s) { return `<span class="badge badge-${s}">${s.replace(/_/g, ' ')}</span>`; }
  function leaveCard(l) {
    return `<div class="card"><div style="display:flex;justify-content:space-between"><b>${esc(l.leave_name)}</b>${statusBadge(l.status)}</div>
    <div class="muted">${esc(l.start_date)} → ${esc(l.end_date)} • ${l.working_days} working day(s)</div>
    <div>${esc((l.reason || '').slice(0, 90))}</div>
    <div style="margin-top:8px;display:flex;gap:8px"><button class="btn sec" onclick="UI.detail(${l.id})">View</button>
    <a class="btn ghost" href="print.html?id=${l.id}">Print</a></div></div>`;
  }
  function render() {
    const v = balFor('vacation'), s = balFor('sick'), p = balFor('spl');
    const unpaid = leaves.filter(l => l.leave_code === 'unpaid' && l.status === 'APPROVED').reduce((x, l) => x + l.working_days, 0);
    const pend = leaves.filter(l => ['PENDING', 'UNDER_REVIEW', 'FOR_SUPERVISOR_REVIEW', 'FOR_FINAL_APPROVAL'].includes(l.status)).length;
    if (tab === 'home') {
      const upcoming = leaves.filter(l => l.status === 'APPROVED' && l.start_date >= new Date().toISOString().slice(0, 10)).slice(0, 3);
      app().innerHTML = `<h3>STAFF PROFILE</h3><div class="grid4">${balCard('Annual Leave', v)}${balCard('Sick Leave', s)}${balCard('Personal Leave', p)}
        <div class="card" style="text-align:center"><div class="muted">Unpaid Taken</div><div style="font-size:26px;font-weight:800">${unpaid}</div><div class="muted">Days</div></div></div>
      <h3>MY REQUEST TRACKING</h3><div style="display:flex;gap:8px">
      ${['all', 'pending', 'history'].map(f => `<button class="btn ${filter === f ? '' : 'sec'}" onclick="UI.filter('${f}')">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}</div>
      <div class="muted">Pending: ${pend} • Upcoming: ${upcoming.length}</div>
      ${leaves.length ? leaves.map(leaveCard).join('') : `<div class="empty">No applications found.<br><br><button class="btn" onclick="UI.wizard()">CREATE LEAVE APPLICATION</button></div>`}`;
    } else if (tab === 'req') {
      app().innerHTML = `<h3>My Requests</h3><div style="display:flex;gap:8px">${['all', 'pending', 'history'].map(f => `<button class="btn ${filter === f ? '' : 'sec'}" onclick="UI.filter('${f}')">${f}</button>`).join('')}</div>
      ${leaves.length ? leaves.map(leaveCard).join('') : `<div class="empty">You don't have any leave requests yet.</div>`}`;
    } else if (tab === 'cal') { renderCal(); }
    else if (tab === 'not') { renderNot(); }
    else if (tab === 'me') {
      const e = me.employee || {};
      app().innerHTML = `<h3>Profile</h3><div class="card"><b>${esc(e.name || '')}</b><br>${esc(e.employee_no || '')} • ${esc(e.email || '')}<br>${esc(e.phone || '')}<br>${esc(e.department || '')} • ${esc(e.position || '')}<br>Hired: ${esc(e.date_hired || '')}<br><br><button class="btn danger" onclick="UI.logout()">Logout</button></div>`;
    }
  }
  async function renderCal() {
    app().innerHTML = `<h3>Leave Calendar</h3><input type="month" value="${month}" onchange="UI.setMonth(this.value)"><div id="cald">Loading…</div>`;
    try {
      const items = await Api.get('/api/calendar/me?month=' + month);
      const [Y, M] = month.split('-').map(Number);
      const first = new Date(Y, M - 1, 1), days = new Date(Y, M, 0).getDate();
      let html = '<div class="cal" style="margin-top:10px">';
      for (let i = 0; i < first.getDay(); i++) html += '<div></div>';
      for (let d = 1; d <= days; d++) {
        const ds = `${month}-${String(d).padStart(2, '0')}`;
        const hit = items.filter(x => x.start_date <= ds && x.end_date >= ds);
        const cls = hit.some(x => x.status === 'APPROVED') ? 'hasA' : hit.length ? 'hasP' : '';
        html += `<div class="${cls}" title="${hit.map(x => esc(x.leave_name)).join(', ')}">${d}</div>`;
      }
      html += '</div>' + (items.length ? items.map(leaveCard).join('') : '<div class="empty">No leave this month.</div>');
      document.getElementById('cald').innerHTML = html;
    } catch (e) { document.getElementById('cald').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }
  async function renderNot() {
    app().innerHTML = '<h3>Notifications</h3><div id="nl">Loading…</div>';
    try {
      const ns = await Api.get('/api/notifications');
      document.getElementById('nl').innerHTML = ns.length ? ns.map(n => `<div class="card"><b>${n.read ? '' : '● '}${esc(n.title)}</b><div class="muted">${esc(n.created_at)}</div><div>${esc(n.body)}</div>${n.read ? '' : `<button class="btn sec" onclick="UI.readN(${n.id})">Mark read</button>`}</div>`).join('') : '<div class="empty">No notifications.</div>';
    } catch (e) { document.getElementById('nl').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }
  // ---- wizard ----
  function wizard() {
    wiz = { step: 1, extra_details: {}, docs: [] };
    drawWiz();
  }
  function drawWiz() {
    const acts = types.filter(t => t.active);
    let body = '';
    if (wiz.step === 1) body = `<h3>Step 1 — Leave Category</h3>${acts.map(t => `<div class="card"><label><input type="radio" name="lt" value="${t.id}" style="width:auto"> <b>${esc(t.name)}</b></label></div>`).join('')}`;
    else if (wiz.step === 2) {
      const t = acts.find(x => x.id == wiz.leave_type_id);
      const code = t ? t.code : '';
      body = `<h3>Step 2 — Details (${esc(t?.name || '')})</h3><div id="dyn">`;
      if (code === 'vacation') body += `<label>Where will you spend your leave?</label><label><input type="radio" name="loc" value="within" style="width:auto"> Within the Philippines</label><label><input type="radio" name="loc" value="abroad" style="width:auto"> Abroad</label><label>Country (if abroad)</label><input id="w_country">`;
      else if (code === 'sick') body += `<label>Where were you confined?</label><label><input type="radio" name="care" value="hospital" style="width:auto"> Hospital</label><label><input type="radio" name="care" value="outpatient" style="width:auto"> Out Patient</label><label>Hospital / Clinic</label><input id="w_clinic"><label>Illness / Reason</label><input id="w_ill">`;
      else if (code === 'study') body += `<label>Purpose</label><select id="w_purp"><option value="">—</option><option>Completion of Master's Degree</option><option>BAR/Board Examination Review</option><option>Other</option></select><label>Details</label><input id="w_det">`;
      else body += `<label>Additional details</label><input id="w_det" placeholder="Optional details">`;
      body += `</div>`;
    }
    else if (wiz.step === 3) body = `<h3>Step 3 — Absence Interval</h3><div class="grid2"><div><label>Start Date</label><input type="date" id="w_s" value="${wiz.start_date || ''}" onchange="UI.calc()"></div><div><label>End Date</label><input type="date" id="w_e" value="${wiz.end_date || ''}" onchange="UI.calc()"></div></div><div id="wd" class="card">Number of working days: <b>${wiz.working_days ?? '—'}</b></div>`;
    else if (wiz.step === 4) body = `<h3>Emergency Callback Contact</h3><label>Contact Name</label><input id="w_ecn" value="${esc(wiz.emergency_name || '')}"><label>Relationship</label><select id="w_ecr"><option>Parent</option><option>Spouse</option><option>Sibling</option><option>Friend</option><option>Other</option></select><label>Phone Number</label><input id="w_ecp" placeholder="+639..." value="${esc(wiz.emergency_phone || '')}">`;
    else if (wiz.step === 5) body = `<h3>Details of Leave</h3><label>Reason for leave</label><textarea id="w_r" rows="4" oninput="document.getElementById('cc').textContent=this.value.length+' / 500'">${esc(wiz.reason || '')}</textarea><div id="cc" class="muted">${(wiz.reason || '').length} / 500</div>`;
    else if (wiz.step === 6) body = `<h3>Supporting Documents</h3><input type="file" id="w_f" accept=".pdf,.jpg,.jpeg,.png"><button class="btn sec" onclick="UI.addDoc()">+ Upload Document</button><div id="dl">${(wiz.docs || []).map((d, i) => `<div class="card">${esc(d.name)} <button onclick="UI.delDoc(${i})">Delete</button></div>`).join('')}</div><div class="muted">PDF/JPG/PNG, max 5MB. Upload happens on submit.</div>`;
    else if (wiz.step === 7) {
      const t = acts.find(x => x.id == wiz.leave_type_id);
      const b = balFor(t?.code);
      body = `<h3>Review Application</h3><div class="card"><b>Leave Type:</b> ${esc(t?.name)}<br><b>Dates:</b> ${esc(wiz.start_date)} → ${esc(wiz.end_date)}<br><b>Duration:</b> ${wiz.working_days} working day(s)<br><b>Emergency:</b> ${esc(wiz.emergency_name)} ${esc(wiz.emergency_phone)}<br><b>Reason:</b> ${esc(wiz.reason)}<br><b>Balance after approval:</b> ${b ? (b.remaining - wiz.working_days) : 'n/a'}<br><label><input type="checkbox" id="w_ok" style="width:auto"> I confirm that the information provided is correct.</label></div><div id="we"></div>`;
    }
    app().innerHTML = `<div class="card">${body}<div id="we"></div><div style="display:flex;gap:8px;margin-top:12px">
      ${wiz.step > 1 ? `<button class="btn ghost" onclick="UI.wstep(-1)">Back</button>` : `<button class="btn ghost" onclick="UI.cancelW()">Cancel</button>`}
      ${wiz.step < 7 ? `<button class="btn" onclick="UI.wstep(1)">Continue</button>` : `<button class="btn" onclick="UI.submit()">SUBMIT APPLICATION</button>`}</div></div>`;
  }
  function werr(m) { document.getElementById('we').innerHTML = `<div class="err">${esc(m)}</div>`; }
  function wstep(d) {
    const acts = types.filter(t => t.active);
    if (d > 0) {
      if (wiz.step === 1) { const s = document.querySelector('input[name=lt]:checked'); if (!s) return werr('Choose a leave type'); wiz.leave_type_id = +s.value; }
      if (wiz.step === 2) {
        const t = acts.find(x => x.id == wiz.leave_type_id), ex = {};
        if (t.code === 'vacation') { const l = document.querySelector('input[name=loc]:checked'); if (!l) return werr('Choose location'); ex.location = l.value; ex.country = (document.getElementById('w_country') || {}).value || ''; if (ex.location === 'abroad' && !ex.country) return werr('Country required'); }
        if (t.code === 'sick') { const c = document.querySelector('input[name=care]:checked'); if (!c) return werr('Choose care type'); ex.care_type = c.value; ex.clinic = document.getElementById('w_clinic').value; ex.illness = document.getElementById('w_ill').value; if (!ex.illness) return werr('Illness required'); }
        if (t.code === 'study') { ex.purpose = document.getElementById('w_purp').value; ex.details = document.getElementById('w_det').value; if (!ex.purpose) return werr('Purpose required'); }
        const det = document.getElementById('w_det'); if (det && t.code !== 'study') ex.details = det.value;
        wiz.extra_details = ex;
      }
      if (wiz.step === 3) { wiz.start_date = document.getElementById('w_s').value; wiz.end_date = document.getElementById('w_e').value; if (!wiz.start_date || !wiz.end_date) return werr('Dates required'); if (wiz.end_date < wiz.start_date) return werr('End date cannot be before start date'); if (!wiz.working_days) return werr('Wait for working-day calculation'); }
      if (wiz.step === 4) { wiz.emergency_name = document.getElementById('w_ecn').value; wiz.emergency_relationship = document.getElementById('w_ecr').value; wiz.emergency_phone = document.getElementById('w_ecp').value; if (!wiz.emergency_name) return werr('Contact name required'); if (wiz.emergency_phone.replace(/\D/g, '').length < 7) return werr('Valid phone required'); }
      if (wiz.step === 5) { wiz.reason = document.getElementById('w_r').value.trim(); if (!wiz.reason) return werr('Reason required'); if (wiz.reason.length > 500) return werr('Reason too long'); }
    }
    wiz.step += d; drawWiz();
  }
  async function calc() {
    const s = document.getElementById('w_s').value, e = document.getElementById('w_e').value;
    if (!s || !e) return;
    try { const j = await Api.post('/api/leaves/calculate', { start_date: s, end_date: e }); wiz.working_days = j.working_days; wiz.start_date = s; wiz.end_date = e; document.getElementById('wd').innerHTML = `Number of working days: <b>${j.working_days} DAY(S)</b>`; }
    catch (err) { document.getElementById('wd').innerHTML = `<div class="err">${esc(err.message)}</div>`; wiz.working_days = 0; }
  }
  function addDoc() {
    const f = document.getElementById('w_f').files[0];
    if (!f) return werr('Choose a file');
    if (f.size > 5 * 1024 * 1024) return werr('Max 5MB');
    wiz.docs.push(f); drawWiz();
  }
  function delDoc(i) { wiz.docs.splice(i, 1); drawWiz(); }
  async function submit() {
    if (!document.getElementById('w_ok').checked) { document.getElementById('we').innerHTML = '<div class="err">Please confirm the information is correct.</div>'; return; }
    try {
      const j = await Api.post('/api/leaves', { leave_type_id: wiz.leave_type_id, start_date: wiz.start_date, end_date: wiz.end_date, reason: wiz.reason, emergency_name: wiz.emergency_name, emergency_relationship: wiz.emergency_relationship, emergency_phone: wiz.emergency_phone, extra_details: wiz.extra_details });
      for (const f of wiz.docs) { const fd = new FormData(); fd.append('file', f); await Api.upload(`/api/leaves/${j.id}/documents`, fd); }
      app().innerHTML = `<div class="card" style="text-align:center"><h2>✓ Application Submitted</h2><div class="muted">ID #${j.id} • ${j.working_days} working day(s)</div><br><button class="btn" onclick="UI.detail(${j.id})">View Application</button> <button class="btn sec" onclick="location.reload()">Home</button></div>`;
      filter = 'all'; leaves = await Api.get('/api/leaves/me?filter=all');
    } catch (e) { document.getElementById('we').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }
  async function detail(id) {
    app().innerHTML = 'Loading…';
    try {
      const a = await Api.get('/api/leaves/' + id);
      const steps = ['Application Submitted', 'HR Review', 'Supervisor Review', 'Final Approval', 'Completed'];
      const idx = { PENDING: 1, UNDER_REVIEW: 1, FOR_SUPERVISOR_REVIEW: 2, FOR_FINAL_APPROVAL: 3, APPROVED: 4, REJECTED: 1, CANCELLED: 0 }[a.status] ?? 1;
      app().innerHTML = `<button class="btn ghost" onclick="location.reload()">← Back</button><div class="card"><h3>APPLICATION STATUS ${statusBadge(a.status)}</h3>
      <div class="timeline">${steps.map((s, i) => `<div>${i <= idx && a.status !== 'CANCELLED' ? '✓' : '○'} ${s}</div>`).join('')}</div>
      <b>${esc(a.leave_name)}</b><br>${esc(a.start_date)} → ${esc(a.end_date)} (${a.working_days}d)<br>Reason: ${esc(a.reason)}<br>
      Emergency: ${esc(a.emergency_name)} ${esc(a.emergency_phone)}<br>Docs: ${(a.docs || []).map(d => esc(d.filename)).join(', ') || '—'}
      ${(a.history || []).map(h => `<div class="muted">${esc(h.step)}: ${esc(h.action)} — ${esc(h.comment)} (${esc(h.created_at)})</div>`).join('')}
      <div style="margin-top:10px;display:flex;gap:8px">${['PENDING', 'UNDER_REVIEW'].includes(a.status) ? `<button class="btn danger" onclick="UI.cancel(${a.id})">Cancel Application</button>` : ''}<a class="btn sec" href="print.html?id=${a.id}">Print / PDF</a></div></div>`;
    } catch (e) { app().innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }
  return {
    init, render, detail, wizard, wstep, calc, addDoc, delDoc, submit,
    cancelW: () => { tab = 'home'; refresh(); },
    tab: (t, b) => { tab = t; document.querySelectorAll('nav.bottom button').forEach(x => x.classList.remove('on')); if (b) b.classList.add('on'); render(); },
    filter: f => { filter = f; refresh(); }, setMonth: m => { month = m; renderCal(); },
    readN: async id => { await Api.post(`/api/notifications/${id}/read`); renderNot(); },
    cancel: async id => { if (!confirm('Cancel this application?')) return; await Api.post(`/api/leaves/${id}/cancel`); location.reload(); },
    logout: async () => { await Api.post('/api/auth/logout'); location.href = 'login.html'; },
  };
})();
UI.init();
