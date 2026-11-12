'use strict';
/** In-process fakes of the two external services, used to test the real adapter/mailer code over real HTTP. */
const http = require('node:http');
const crypto = require('node:crypto');
const V = require('../server/validate');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });

// ---- Fake Supabase (PostgREST subset used by server/store/supabase.js) ----
async function fakeSupabase(serviceKey = 'test-service-key') {
  const db = { enquiries: [], notification_outbox: [], audit_log: [], seq: { outbox: 0, audit: 0 }, calls: [] };
  const now = () => new Date().toISOString();
  const like = (val, pat) => new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(String(val == null ? '' : val));
  function cond(row, col, expr) {
    const [op, ...rest] = expr.split('.'); const v = rest.join('.');
    if (op === 'eq') return String(row[col]) === v;
    if (op === 'gte') return new Date(row[col]) >= new Date(v);
    if (op === 'lte') return new Date(row[col]) <= new Date(v);
    if (op === 'ilike') return like(row[col], v);
    if (op === 'in') return v.replace(/^\(|\)$/g, '').split(',').includes(String(row[col]));
    throw new Error('fake: unsupported op ' + op);
  }
  function filter(rows, params) {
    let out = rows.slice();
    for (const [k, v] of params) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      if (k === 'or') { const parts = v.replace(/^\(|\)$/g, '').split(','); out = out.filter((r) => parts.some((p) => { const [c, ...e] = p.split('.'); return cond(r, c, e.join('.')); })); }
      else out = out.filter((r) => cond(r, k, v));
    }
    const ord = params.get('order'); if (ord) { const [c, d] = ord.split('.'); out.sort((a, b) => (a[c] > b[c] ? 1 : -1) * (d === 'desc' ? -1 : 1)); }
    if (params.get('limit')) out = out.slice(0, Number(params.get('limit')));
    return out;
  }
  const rpc = {
    create_enquiry({ p }) {
      if (db.enquiries.some((e) => e.reference === p.reference)) throw Object.assign(new Error('dup'), { status: 409, code: '23505' });
      const row = { id: crypto.randomUUID(), reference: p.reference, created_at: now(), updated_at: now(), customer_name: p.customer_name, customer_phone: p.customer_phone, customer_area: p.customer_area,
        service_type: p.service_type, vehicle_details: p.vehicle_details || null, enquiry_message: p.enquiry_message || null, consent_at: now(), privacy_notice_version: p.privacy_notice_version,
        source_page: p.source_page || null, lead_status: 'new', referred_to: null, referral_date: null, job_value_pesewas: null, commission_rate_bp: null, commission_pesewas: null, internal_notes: null };
      db.enquiries.push(row);
      db.notification_outbox.push({ id: ++db.seq.outbox, enquiry_id: row.id, recipient_role: 'lead_partner', channel: 'email', status: 'pending', attempts: 0, created_at: now(), sent_at: null, next_attempt_at: now(), locked_at: null, last_error: null });
      db.audit_log.push({ id: ++db.seq.audit, at: now(), actor: 'public-form', action: 'enquiry.created', enquiry_id: row.id, detail: { reference: p.reference } });
      return { id: row.id, reference: p.reference };
    },
    claim_notifications({ p_limit }) {
      const due = db.notification_outbox.filter((o) => (o.status === 'pending' && o.next_attempt_at <= now()) || (o.status === 'sending' && o.locked_at < new Date(Date.now() - 600000).toISOString())).slice(0, p_limit);
      return due.map((o) => { o.status = 'sending'; o.locked_at = now(); o.attempts++; return { id: o.id, attempts: o.attempts, enquiry: db.enquiries.find((e) => e.id === o.enquiry_id) }; });
    },
    finish_notification({ p_id, p_ok, p_error, p_final, p_retry_at }) {
      const o = db.notification_outbox.find((x) => x.id === p_id);
      if (p_ok) Object.assign(o, { status: 'sent', sent_at: now(), locked_at: null, last_error: null });
      else Object.assign(o, { status: p_final ? 'failed' : 'pending', next_attempt_at: p_retry_at || now(), locked_at: null, last_error: String(p_error).slice(0, 300) });
      return null;
    },
    purge_closed_enquiries({ p_before }) {
      const before = db.enquiries.length;
      db.enquiries = db.enquiries.filter((e) => !(['completed', 'cancelled'].includes(e.lead_status) && e.updated_at < p_before));
      return before - db.enquiries.length;
    }
  };
  const server = http.createServer(async (req, res) => {
    const send = (st, body) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    try {
      if (req.headers.apikey !== serviceKey || req.headers.authorization !== 'Bearer ' + serviceKey) return send(401, { message: 'Invalid API key' });
      const url = new URL(req.url, 'http://x'); const m = url.pathname.match(/^\/rest\/v1\/(.+)$/); if (!m) return send(404, {});
      db.calls.push(req.method + ' ' + m[1]);
      const raw = await readBody(req); const body = raw ? JSON.parse(raw) : undefined; const name = m[1];
      if (name.startsWith('rpc/')) { const fn = rpc[name.slice(4)]; if (!fn) return send(404, {}); try { const out = fn(body || {}); return out === null ? send(204) : send(200, out); } catch (e) { return send(e.status || 400, { code: e.code, message: e.message }); } }
      const table = db[name]; if (!table) return send(404, { code: 'PGRST205' });
      if (req.method === 'GET') return send(200, filter(table, url.searchParams));
      if (req.method === 'POST') { const row = { id: ++db.seq.audit, at: now(), ...body }; table.push(row); return send(201); }
      if (req.method === 'PATCH') {
        const rows = filter(table, url.searchParams);
        for (const r of rows) {
          if (body.lead_status && !V.canTransition(r.lead_status, body.lead_status)) return send(400, { code: 'P0001', message: 'Invalid status transition' });
          Object.assign(r, body, { updated_at: now() });
        }
        return send(200, rows);
      }
      if (req.method === 'DELETE') { const rows = filter(table, url.searchParams); db[name] = table.filter((r) => !rows.includes(r)); return send(200, rows); }
      return send(405, {});
    } catch (e) { send(500, { message: e.message }); }
  });
  const url = await listen(server);
  return { url, serviceKey, db, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

// ---- Fake Resend ----
async function fakeResend({ apiKey = 're_test' } = {}) {
  const state = { sent: [], queue: [], keys: new Set() }; // queue: statuses to return for upcoming calls, e.g. [500, 200]
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    if (req.headers.authorization !== 'Bearer ' + apiKey) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"message":"API key is invalid"}'); }
    const forced = state.queue.shift();
    if (forced && forced !== 200) { res.writeHead(forced, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ message: 'forced ' + forced })); }
    const body = JSON.parse(raw); const key = req.headers['idempotency-key'];
    if (key && state.keys.has(key)) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"id":"dup"}'); }
    if (key) state.keys.add(key);
    state.sent.push({ ...body, idempotencyKey: key });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"email_1"}');
  });
  const url = await listen(server);
  return { url: url + '/emails', apiKey, state, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}
module.exports = { fakeSupabase, fakeResend };
