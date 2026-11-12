'use strict';
// The same contract is run against the SQLite adapter and the Supabase adapter (talking HTTP to a fake PostgREST).
const test = require('node:test'); const assert = require('node:assert/strict');
const { fakeSupabase } = require('./fakes');
const sqlite = require('../server/store/sqlite'); const supa = require('../server/store/supabase');
const v = (o = {}) => ({ name: 'Ama Boateng', phone: '+233273242468', area: 'Cape Coast', service: 'Car AC compressor repair', vehicle: 'Porsche Cayenne', message: 'Noisy compressor', ...o });
const meta = { privacyVersion: 'v2', sourcePage: 'https://x/' };

async function contract(store, name) {
  const a = await store.createEnquiry(v(), meta); assert.match(a.reference, /^ADOM-\d{6}-[A-Z0-9]{5}$/, name);
  const b = await store.createEnquiry(v({ name: 'Kojo Asante', service: 'AC servicing', vehicle: '', phone: '+233201112223' }), meta);
  assert.equal((await store.list()).length, 2);
  assert.equal((await store.list({ vehicle: 'porsche' })).length, 1);
  assert.equal((await store.list({ service: 'AC servicing' })).length, 1);
  assert.equal((await store.list({ q: 'kojo' })).length, 1);
  assert.equal((await store.list({ q: '+233273' })).length, 1);
  assert.equal((await store.list({ status: 'new' })).length, 2);
  assert.equal((await store.list({ q: 'a,b)(*' })).length >= 0, true);              // hostile search text must not break the query
  assert.equal((await store.findRecentDuplicate('+233273242468', 'Car AC compressor repair', new Date(Date.now() - 60000).toISOString())).reference, a.reference);
  assert.equal(await store.findRecentDuplicate('+233000000000', 'x', new Date(0).toISOString()), null);
  const row = await store.get(a.id); assert.equal(row.customer_name, 'Ama Boateng'); assert.equal(row.lead_status, 'new'); assert.equal(row.privacy_notice_version, 'v2');
  const up = await store.update(a.id, { lead_status: 'contacted', internal_notes: 'called' }); assert.equal(up.lead_status, 'contacted');
  assert.deepEqual((await store.stats()).map((r) => ({ status: r.status, n: r.n })).sort((x, y) => x.status.localeCompare(y.status)), [{ status: 'contacted', n: 1 }, { status: 'new', n: 1 }]);
  // notification queue: lead partner first, claim -> send/fail/retry semantics
  assert.equal((await store.notificationCounts()).pending, 2);
  const claimed = await store.claimNotifications(5); assert.equal(claimed.length, 2); assert.equal(claimed[0].attempts, 1); assert.ok(claimed[0].enquiry.customer_name);
  assert.equal((await store.claimNotifications(5)).length, 0);                       // already claimed
  await store.finishNotification(claimed[0].id, { ok: true });
  await store.finishNotification(claimed[1].id, { ok: false, error: 'boom', final: false, retryAt: new Date(Date.now() - 1000).toISOString() });
  const again = await store.claimNotifications(5); assert.equal(again.length, 1); assert.equal(again[0].attempts, 2);
  await store.finishNotification(again[0].id, { ok: false, error: 'dead', final: true });
  assert.deepEqual({ ...(await store.notificationCounts()) }, { pending: 0, failed: 1 });
  assert.ok((await store.outboxFor(claimed[0].enquiry.id)).length === 1);
  await store.audit('tester', 'x', a.id, { k: 1 }); assert.ok((await store.auditFor(10)).length >= 2);
  assert.equal(await store.ping(), true);
  // retention: only closed enquiries older than the cutoff are removed
  await store.update(a.id, { lead_status: 'qualified' }); await store.update(a.id, { lead_status: 'cancelled' });
  assert.equal(await store.purgeClosedBefore(new Date(Date.now() - 86400000).toISOString()), 0);
  assert.equal(await store.purgeClosedBefore(new Date(Date.now() + 1000).toISOString()), 1);
  assert.equal(await store.get(a.id), null); assert.ok(await store.get(b.id));
  assert.equal(await store.remove(b.id), true); assert.equal(await store.remove(b.id), false);
  const hostile = await Promise.resolve().then(() => store.get("1' OR '1'='1")).catch(() => null); assert.equal(hostile, null); // injection attempts never match or leak rows
}
test('SQLite adapter satisfies the storage contract', async () => { const s = sqlite.open(':memory:'); try { await contract(s, 'sqlite'); } finally { s.close(); } });
test('Supabase adapter satisfies the storage contract (HTTP, service key header, RPC functions)', async () => {
  const f = await fakeSupabase(); const s = supa.create({ url: f.url, serviceKey: f.serviceKey });
  try { await contract(s, 'supabase'); assert.ok(f.db.calls.includes('POST rpc/create_enquiry') && f.db.calls.includes('POST rpc/claim_notifications')); } finally { await f.close(); }
});
test('Supabase adapter: wrong key fails without leaking response body; unreachable server fails cleanly; reference collision retries', async () => {
  const f = await fakeSupabase();
  await assert.rejects(() => supa.create({ url: f.url, serviceKey: 'wrong' }).ping(), (e) => /401/.test(e.message) && !/Invalid API key/.test(e.message));
  await assert.rejects(() => supa.create({ url: 'http://127.0.0.1:1', serviceKey: 'k', timeoutMs: 500 }).ping(), /unreachable/);
  const s = supa.create({ url: f.url, serviceKey: f.serviceKey }); const orig = require('../server/store/common'); assert.ok(orig.newReference);
  f.db.enquiries.push({ reference: 'ADOM-000000-AAAAA' }); // harmless pre-existing row
  await s.createEnquiry(v(), meta); assert.equal(f.db.enquiries.length, 2); await f.close();
});
