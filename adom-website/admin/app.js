(function () {
  'use strict';
  var root = document.getElementById('app'), settings = null, selected = null, filters = {};
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'class') e.className = attrs[k]; else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function api(path, opts) {
    opts = opts || {}; opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error('signed out'); }
      return r.json().then(function (b) { return { ok: r.ok, body: b }; });
    });
  }
  function fmtDate(s) { return s ? new Date(s).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }

  function layout() {
    root.textContent = '';
    var r = settings.readiness;
    root.appendChild(el('header', { class: 'bar' }, [el('h1', { text: 'ADOM private lead dashboard' }), el('div', { class: 'right' }, [
      el('a', { class: 'btn ghost', id: 'csv', href: '#', text: 'Export CSV', onclick: exportCsv }),
      el('button', { class: 'btn', type: 'button', text: 'Sign out', onclick: function () { api('/api/admin/logout', { method: 'POST', body: '{}' }).then(function () { location.reload(); }); } })])]));
    var issues = [];
    if (r.missing.length) issues.push('Setup incomplete (enquiries are blocked in production): ' + r.missing.join(', ') + '.');
    if (r.databaseStatus !== 'ok') issues.push('The database is not reachable right now.');
    if (!r.emailConfigured) issues.push('Email is not configured, so lead-partner notifications cannot be sent.');
    if (r.failedNotifications) issues.push(r.failedNotifications + ' lead-partner notification(s) FAILED to send. Open the enquiry and contact the lead partner directly.');
    if (!r.twoStepEnabled) issues.push('Two-step sign-in is not enabled (recommended).');
    var b = el('div', { class: 'banner' + (issues.length ? '' : ' ok') });
    b.textContent = issues.length ? issues.join(' ') : 'System check passed: database ' + r.database + ' reachable, email configured, ' + r.pendingNotifications + ' notification(s) waiting.';
    root.appendChild(b);
    var tools = el('div', { class: 'stats' }, [
      el('button', { class: 'btn ghost', type: 'button', text: 'Send test email to lead partner', onclick: function () {
        api('/api/admin/test-email', { method: 'POST', body: '{}' }).then(function (x) { alert(x.ok ? 'Test email sent. Ask the lead partner to confirm it arrived (also check spam).' : 'Test email failed: ' + (x.body.detail || x.body.error)); }); } }),
      el('button', { class: 'btn ghost', type: 'button', text: 'Set up two-step sign-in', onclick: function () {
        api('/api/admin/totp-setup').then(function (x) { prompt('1) In your authenticator app choose "Enter a setup key" and type this key.\n2) In Render open your service > Environment > Add variable named ADMIN_TOTP_SECRET and paste the same key, then save. Two-step sign-in switches on after Render restarts.', x.body.secret); }); } })]);
    root.appendChild(tools);
    var st = el('div', { class: 'stats' });
    settings.stats.forEach(function (s) { st.appendChild(el('span', { class: 'chip', text: s.status + ': ' + s.n })); });
    root.appendChild(st);
    var f = el('div', { class: 'filters' });
    function sel(key, label, opts) { var s = el('select', { id: 'f_' + key }, [el('option', { value: '', text: 'All' })].concat(opts.map(function (o) { return el('option', { value: o, text: o }); }))); s.addEventListener('change', function () { filters[key] = s.value; load(); }); return el('div', {}, [el('label', { text: label, for: 'f_' + key }), s]); }
    function inp(key, label, type) { var i = el('input', { id: 'f_' + key, type: type || 'text' }); i.addEventListener('change', function () { filters[key] = i.value; load(); }); return el('div', {}, [el('label', { text: label, for: 'f_' + key }), i]); }
    [inp('q', 'Search name, phone, reference'), sel('status', 'Status', settings.statuses), sel('service', 'Service', settings.services), inp('vehicle', 'Vehicle'), inp('from', 'From', 'date'), inp('to', 'To', 'date')].forEach(function (n) { f.appendChild(n); });
    root.appendChild(f);
    root.appendChild(el('div', { class: 'layout' }, [el('div', { class: 'card', id: 'listCard' }), el('div', { class: 'card detail', id: 'detailCard' }, [el('p', { text: 'Select an enquiry to view and update it.' })])]));
  }
  function qs() { var p = new URLSearchParams(); Object.keys(filters).forEach(function (k) { if (filters[k]) p.set(k, filters[k]); }); return p.toString(); }
  function exportCsv(e) { e.preventDefault(); location.href = '/api/admin/export.csv?' + qs(); }

  function load() {
    api('/api/admin/enquiries?' + qs()).then(function (res) {
      var card = document.getElementById('listCard'); card.textContent = '';
      var rows = res.body.enquiries || [];
      if (!rows.length) { card.appendChild(el('p', { text: 'No enquiries match these filters yet.' })); return; }
      var t = el('table'); t.appendChild(el('thead', {}, [el('tr', {}, ['Received', 'Reference', 'Name', 'Phone', 'Service', 'Vehicle', 'Status'].map(function (h) { return el('th', { text: h }); }))]));
      var tb = el('tbody');
      rows.forEach(function (r) {
        var tr = el('tr', { class: 'row' + (selected === r.id ? ' sel' : ''), tabindex: '0', onclick: function () { open(r.id); }, onkeydown: function (e) { if (e.key === 'Enter') open(r.id); } }, [
          el('td', { text: fmtDate(r.created_at) }), el('td', { text: r.reference }), el('td', { text: r.name }), el('td', { text: r.phone }), el('td', { text: r.service }), el('td', { text: r.vehicle || '—' }),
          el('td', {}, [el('span', { class: 'badge', text: r.status })])]);
        tb.appendChild(tr);
      });
      t.appendChild(tb); card.appendChild(t);
    });
  }
  function open(id) {
    selected = id;
    api('/api/admin/enquiries/' + id).then(function (res) { if (res.ok) renderDetail(res.body.enquiry, res.body.notifications); load(); });
  }
  function renderDetail(e, notes) {
    var c = document.getElementById('detailCard'); c.textContent = '';
    var dl = el('dl'); [['Reference', e.reference], ['Received', fmtDate(e.created_at)], ['Name', e.name], ['Phone', e.phone], ['Area', e.area], ['Service', e.service], ['Vehicle', e.vehicle || '—'], ['Issue', e.message || '—'],
      ['Consent', fmtDate(e.consent_at) + ' (notice ' + e.privacy_notice_version + ')'], ['Status', e.status], ['Referred', e.referred_to ? e.referred_to + ' on ' + fmtDate(e.referral_date) : '—'],
      ['Job value', e.job_value_ghs ? 'GHS ' + e.job_value_ghs : '—'], ['Commission', e.commission_ghs ? 'GHS ' + e.commission_ghs + ' at ' + e.commission_rate_percent + '%' : '—'],
      ['Lead partner notice', notes.length ? notes.map(function (n) { return n.status; }).join(', ') : '—']].forEach(function (p) { dl.appendChild(el('dt', { text: p[0] })); dl.appendChild(el('dd', { text: p[1] })); });
    c.appendChild(el('h2', { text: e.name })); c.appendChild(dl);
    var msg = el('p', { class: 'msg', role: 'status' });
    c.appendChild(el('div', { class: 'field' }, [el('label', { for: 'refTo', text: 'Referred to (ADOM contact)' }), el('input', { id: 'refTo', value: e.referred_to || '', maxlength: '120' })]));
    c.appendChild(el('div', { class: 'field' }, [el('label', { for: 'jv', text: 'Job value (GHS)' }), el('input', { id: 'jv', value: e.job_value_ghs || '', inputmode: 'decimal' })]));
    c.appendChild(el('div', { class: 'field' }, [el('label', { for: 'nt', text: 'Internal notes' }), el('textarea', { id: 'nt', rows: '3', maxlength: '2000', text: e.notes || '' })]));
    function save(extra) {
      var body = Object.assign({ referred_to: document.getElementById('refTo').value, notes: document.getElementById('nt').value, job_value_ghs: document.getElementById('jv').value }, extra || {});
      api('/api/admin/enquiries/' + e.id, { method: 'PATCH', body: JSON.stringify(body) }).then(function (res) {
        if (res.ok) { renderDetail(res.body.enquiry, notes); load(); settingsRefresh(); }
        else { msg.className = 'msg'; msg.textContent = Object.keys(res.body.errors || {}).map(function (k) { return res.body.errors[k]; }).join(' ') || 'Could not save.'; }
      });
    }
    var actions = el('div', { class: 'row-actions' }, [el('button', { class: 'btn ghost', type: 'button', text: 'Save changes', onclick: function () { save(); } })]);
    (settings.transitions[e.status] || []).forEach(function (to) { actions.appendChild(el('button', { class: 'btn', type: 'button', text: 'Mark ' + to, onclick: function () { save({ status: to }); } })); });
    actions.appendChild(el('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: function () { if (confirm('Permanently delete ' + e.reference + '? This cannot be undone.')) api('/api/admin/enquiries/' + e.id, { method: 'DELETE' }).then(function () { selected = null; c.textContent = ''; c.appendChild(el('p', { text: 'Enquiry deleted.' })); load(); settingsRefresh(); }); } }));
    c.appendChild(actions); c.appendChild(msg);
  }
  function settingsRefresh() { api('/api/admin/settings').then(function (r) { settings = r.body; var s = document.querySelector('.stats'); if (s) { s.textContent = ''; settings.stats.forEach(function (x) { s.appendChild(el('span', { class: 'chip', text: x.status + ': ' + x.n })); }); } }); }
  api('/api/admin/settings').then(function (r) { settings = r.body; layout(); load(); });
})();
