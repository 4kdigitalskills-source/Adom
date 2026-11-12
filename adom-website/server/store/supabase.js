'use strict';
/**
 * Supabase (PostgreSQL via PostgREST) storage adapter. Same interface as sqlite.js.
 * Uses ONLY the server-side service_role key (never sent to browsers) and talks to the database with plain HTTPS (no dependencies).
 * Public/anon access to every table is denied by Row Level Security (see supabase/schema.sql).
 */
const { newReference, UUID_RE } = require('./common');

function create({ url, serviceKey, fetchImpl = fetch, timeoutMs = 10000 }) {
  const base = url.replace(/\/+$/, '') + '/rest/v1';
  const enc = encodeURIComponent;

  async function call(method, path, { body, prefer } = {}) {
    const headers = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    let res;
    try {
      res = await fetchImpl(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) { throw Object.assign(new Error('supabase unreachable: ' + (e.name || 'error')), { code: 'network' }); }
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) throw Object.assign(new Error(`supabase ${res.status} ${(data && data.code) || ''}`.trim()), { code: data && data.code, status: res.status }); // body not echoed: may contain personal data
    return data;
  }
  const idOk = (id) => { if (!UUID_RE.test(String(id))) throw new Error('invalid id'); return id; };
  const nowIso = () => new Date().toISOString();

  const audit = (actor, action, enquiryId, detail) =>
    call('POST', '/audit_log', { body: { actor, action, enquiry_id: enquiryId || null, detail: detail || null } }).then(() => undefined);

  return {
    kind: 'supabase',
    audit,
    async createEnquiry(v, meta) {
      for (let tries = 0; ; tries++) {
        const reference = newReference();
        try {
          const r = await call('POST', '/rpc/create_enquiry', { body: { p: {
            reference, customer_name: v.name, customer_phone: v.phone, customer_area: v.area, service_type: v.service,
            vehicle_details: v.vehicle || null, enquiry_message: v.message || null, privacy_notice_version: meta.privacyVersion, source_page: meta.sourcePage || null } } });
          return { id: r.id, reference: r.reference };
        } catch (e) { if (e.code !== '23505' || tries >= 5) throw e; }
      }
    },
    async findRecentDuplicate(phone, service, sinceIso) {
      const r = await call('GET', `/enquiries?select=reference&customer_phone=eq.${enc(phone)}&service_type=eq.${enc(service)}&created_at=gte.${enc(sinceIso)}&order=created_at.desc&limit=1`);
      return r && r[0] ? { reference: r[0].reference } : null;
    },
    async list(f = {}) {
      const p = ['select=*', 'order=created_at.desc', 'limit=' + Math.min(Number(f.limit) || 200, 1000)];
      const safe = (s) => String(s).replace(/[%_*,()"\\]/g, '');
      if (f.status) p.push('lead_status=eq.' + enc(f.status));
      if (f.service) p.push('service_type=eq.' + enc(f.service));
      if (f.vehicle && safe(f.vehicle)) p.push('vehicle_details=ilike.' + enc('*' + safe(f.vehicle) + '*'));
      if (f.from) p.push('created_at=gte.' + enc(f.from));
      if (f.to) p.push('created_at=lte.' + enc(f.to + 'T23:59:59.999Z'));
      if (f.q && safe(f.q)) { const s = '*' + safe(f.q) + '*'; p.push('or=' + enc(`(customer_name.ilike.${s},customer_phone.ilike.${s},reference.ilike.${s},customer_area.ilike.${s})`)); }
      return call('GET', '/enquiries?' + p.join('&'));
    },
    async get(id) { const r = await call('GET', `/enquiries?select=*&id=eq.${idOk(id)}&limit=1`); return r && r[0] ? r[0] : null; },
    async update(id, patch) {
      if (!Object.keys(patch).length) return this.get(id);
      const r = await call('PATCH', `/enquiries?id=eq.${idOk(id)}`, { body: patch, prefer: 'return=representation' });
      return r && r[0] ? r[0] : null;
    },
    async remove(id) { const r = await call('DELETE', `/enquiries?id=eq.${idOk(id)}`, { prefer: 'return=representation' }); return !!(r && r.length); },
    outboxFor: (id) => call('GET', `/notification_outbox?select=id,recipient_role,channel,status,attempts,created_at,sent_at,last_error&enquiry_id=eq.${idOk(id)}`),
    auditFor: (limit = 100) => call('GET', `/audit_log?select=*&order=id.desc&limit=${Math.min(Number(limit) || 100, 500)}`),
    async stats() {
      const rows = await call('GET', '/enquiries?select=lead_status&limit=10000'); const m = {};
      (rows || []).forEach((r) => { m[r.lead_status] = (m[r.lead_status] || 0) + 1; });
      return Object.keys(m).map((status) => ({ status, n: m[status] }));
    },
    async claimNotifications(limit = 5) { return (await call('POST', '/rpc/claim_notifications', { body: { p_limit: limit } })) || []; },
    async finishNotification(id, { ok, error, final, retryAt }) {
      await call('POST', '/rpc/finish_notification', { body: { p_id: id, p_ok: !!ok, p_error: ok ? null : String(error || '').slice(0, 300), p_final: !!final, p_retry_at: retryAt || nowIso() } });
    },
    async notificationCounts() {
      const rows = await call('GET', '/notification_outbox?select=status&status=in.(pending,sending,failed)&limit=10000'); let pending = 0, failed = 0;
      (rows || []).forEach((r) => { if (r.status === 'failed') failed++; else pending++; });
      return { pending, failed };
    },
    async purgeClosedBefore(iso) { return Number(await call('POST', '/rpc/purge_closed_enquiries', { body: { p_before: iso } })) || 0; },
    async ping() { await call('GET', '/enquiries?select=id&limit=1'); return true; },
    close() {}
  };
}
module.exports = { create };
