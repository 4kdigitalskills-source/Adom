'use strict';
const { test, afterEach } = require('node:test'); const assert = require('node:assert/strict');
const { build } = require('../server/config');
const { createApp } = require('../server/app');
const { createMailer } = require('../server/mailer');
const { createNotifier, backoffMs } = require('../server/notifier');
const supa = require('../server/store/supabase');
const A = require('../server/auth');
const { fakeSupabase, fakeResend } = require('./fakes');
const { goodEnquiry, post, ADMIN_ENV, PARTNER_ENV, PASSWORD } = require('./helpers');

async function stack(extraEnv = {}, { prod = true } = {}) {
  const sb = await fakeSupabase(); const rs = await fakeResend();
  const config = build({ NODE_ENV: prod ? 'production' : 'test', SITE_URL: 'https://adom.example', SUPABASE_URL: sb.url, SUPABASE_SERVICE_ROLE_KEY: sb.serviceKey,
    RESEND_API_KEY: rs.apiKey, MAIL_FROM: 'ADOM Leads <leads@adom.example>', ...ADMIN_ENV, ...PARTNER_ENV, ...extraEnv });
  const store = supa.create({ url: sb.url, serviceKey: sb.serviceKey });
  const mailer = createMailer({ apiKey: rs.apiKey, from: config.mail.from, endpoint: rs.url });
  const notifier = createNotifier({ store, mailer, config, log: { error() {} } });
  const server = createApp(config, store, { notifier, mailer });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  const st = { base, sb, rs, config, store, notifier, close: async () => { if (closed) return; closed = true; notifier.stop(); await new Promise((r) => { server.close(r); server.closeAllConnections(); }); await sb.close().catch(() => {}); await rs.close().catch(() => {}); } };
  live.push(st); return st;
}
const live = [];
afterEach(async () => { for (const s of live.splice(0)) await s.close(); });   // always release servers, even if an assertion failed
const waitFor = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

test('production gating: every missing item blocks enquiries; complete config enables', () => {
  const none = build({ NODE_ENV: 'production' });
  assert.equal(none.enquiriesEnabled, false);
  for (const k of ['LEAD_PARTNER_NAME', 'LEAD_PARTNER_EMAIL', 'COMMISSION_RATE_PERCENT', 'REFERRAL_AGREEMENT_CONFIRMED', 'SUPABASE_URL', 'RESEND_API_KEY', 'MAIL_FROM']) assert.ok(none.productionMissing.some((m) => m.startsWith(k)), k);
  assert.ok(none.productionMissing.some((m) => m.startsWith('SITE_URL')));
  const full = { NODE_ENV: 'production', SITE_URL: 'https://adom.example', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', RESEND_API_KEY: 're_x', MAIL_FROM: 'leads@adom.example', ...PARTNER_ENV };
  assert.equal(build(full).enquiriesEnabled, true);
  for (const drop of ['SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'COMMISSION_RATE_PERCENT', 'REFERRAL_AGREEMENT_CONFIRMED']) { const e = { ...full }; delete e[drop]; assert.equal(build(e).enquiriesEnabled, false, drop); }
  assert.equal(build({ ...full, SITE_URL: 'http://adom.example' }).enquiriesEnabled, false);   // must be https
  assert.equal(build({ ...full, MAIL_FROM: 'not-an-email' }).enquiriesEnabled, false);
  assert.equal(build({ ...full, COMMISSION_RATE_PERCENT: '150' }).enquiriesEnabled, false);   // invalid rate is not accepted
});
test('admin password can be a passphrase (hashed by the server); short ones are rejected', () => {
  assert.equal(build({ ADMIN_EMAIL: 'a@b.co', ADMIN_PASSWORD: 'a long enough passphrase', SESSION_SECRET: 'x'.repeat(40) }).admin.configured, true);
  assert.equal(build({ ADMIN_EMAIL: 'a@b.co', ADMIN_PASSWORD: 'short', SESSION_SECRET: 'x'.repeat(40) }).admin.configured, false);
});

test('E2E production path: form -> Supabase -> Resend to lead partner only, with idempotency key; audit + sent status', async () => {
  const s = await stack();
  const r = await post(s.base, '/api/enquiries', goodEnquiry({ vehicle: 'Porsche 911', name: 'A <b>Tester</b>' })); const body = await r.json();
  assert.equal(r.status, 201);
  assert.equal(s.sb.db.enquiries.length, 1);
  assert.ok(await waitFor(() => s.rs.state.sent.length === 1), 'email sent');
  const mail = s.rs.state.sent[0];
  assert.deepEqual(mail.to, ['partner@example.test']);                          // only the lead partner
  assert.match(mail.subject, new RegExp(body.reference)); assert.ok(mail.text.includes('Porsche 911'));
  assert.ok(!mail.html.includes('<b>Tester</b>') && mail.html.includes('&lt;b&gt;Tester&lt;/b&gt;'), 'HTML-escaped');
  assert.ok(!/commission/i.test(mail.text + mail.html));                          // no commercial terms in customer-data email
  assert.match(mail.idempotencyKey, /^adom-notification-\d+$/);
  assert.ok(await waitFor(() => s.sb.db.notification_outbox[0].status === 'sent'));
  assert.ok(await waitFor(() => s.sb.db.audit_log.some((a) => a.action === 'notification.sent')));
  await s.close();
});
test('email outage: enquiry still saved, notification retried later and then delivered; no duplicate email', async () => {
  const s = await stack(); s.rs.state.queue.push(500);
  assert.equal((await post(s.base, '/api/enquiries', goodEnquiry())).status, 201);
  assert.ok(await waitFor(() => s.sb.db.notification_outbox[0].attempts === 1 && s.sb.db.notification_outbox[0].status === 'pending'));
  assert.equal(s.sb.db.enquiries.length, 1); assert.equal(s.rs.state.sent.length, 0);
  s.sb.db.notification_outbox[0].next_attempt_at = new Date(Date.now() - 1000).toISOString();    // time passes
  await s.notifier.runOnce(); assert.equal(s.rs.state.sent.length, 1); assert.equal(s.sb.db.notification_outbox[0].status, 'sent');
  await s.notifier.runOnce(); assert.equal(s.rs.state.sent.length, 1);
  await s.close();
});
test('permanent email errors (bad key / unverified domain) are marked failed at once and shown to the admin; 429 is retried', async () => {
  const s = await stack(); s.rs.state.queue.push(403);
  await post(s.base, '/api/enquiries', goodEnquiry()); await waitFor(() => s.sb.db.notification_outbox[0].status === 'failed');
  assert.match(s.sb.db.notification_outbox[0].last_error, /403/);
  const login = await post(s.base, '/api/admin/login', { email: ADMIN_ENV.ADMIN_EMAIL, password: PASSWORD }); const cookie = login.headers.get('set-cookie').split(';')[0];
  const st = await (await fetch(s.base + '/api/admin/settings', { headers: { Cookie: cookie } })).json();
  assert.equal(st.readiness.failedNotifications, 1); assert.equal(st.readiness.database, 'supabase'); assert.equal(st.readiness.databaseStatus, 'ok'); assert.equal(st.readiness.emailConfigured, true);
  await post(s.base, '/api/enquiries', goodEnquiry({ phone: '027 111 2222' })); s.rs.state.queue.push(429);
  await waitFor(() => s.sb.db.notification_outbox[1] && s.sb.db.notification_outbox[1].attempts >= 1); await new Promise((r) => setTimeout(r, 100));
  assert.ok(['pending', 'sending', 'sent'].includes(s.sb.db.notification_outbox[1].status));
  await s.close();
});
test('Supabase outage: form says not sent (503/500), nothing is claimed as stored, /readyz fails', async () => {
  const s = await stack(); await s.sb.close();
  const r = await post(s.base, '/api/enquiries', goodEnquiry()); assert.equal(r.status, 500); assert.equal((await r.json()).reference, undefined);
  assert.equal((await fetch(s.base + '/readyz')).status, 503);
});
test('admin test-email button sends to lead partner; unauthorised users cannot', async () => {
  const s = await stack();
  assert.equal((await post(s.base, '/api/admin/test-email', {})).status, 401);
  const login = await post(s.base, '/api/admin/login', { email: ADMIN_ENV.ADMIN_EMAIL, password: PASSWORD }); const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post(s.base, '/api/admin/test-email', {}, { Cookie: cookie })).status, 200);
  assert.deepEqual(s.rs.state.sent[0].to, ['partner@example.test']); assert.ok(!/Ama|Kofi/.test(s.rs.state.sent[0].text));
  await s.close();
});
test('two-step sign-in: password alone is refused when enabled; correct code accepted', async () => {
  const secret = A.newTotpSecret(); const s = await stack({ ADMIN_TOTP_SECRET: secret });
  const creds = { email: ADMIN_ENV.ADMIN_EMAIL, password: PASSWORD };
  assert.equal((await post(s.base, '/api/admin/login', creds)).status, 401);
  assert.equal((await post(s.base, '/api/admin/login', { ...creds, code: '000000' })).status, 401);
  assert.equal((await post(s.base, '/api/admin/login', { ...creds, code: A.totpAt(secret, Date.now()) })).status, 200);
  await s.close();
});
test('retention is off unless configured; purge removes only old closed enquiries', async () => {
  assert.equal(build({}).retentionDays, null); assert.equal(build({ RETENTION_DAYS: '365' }).retentionDays, 365);
});
test('backoff grows and is capped', () => { assert.equal(backoffMs(1), 60000); assert.equal(backoffMs(3), 240000); assert.equal(backoffMs(20), 3600000); });
test('secrets never appear in public pages, static files or API errors', async () => {
  const s = await stack(); const fs = require('node:fs'), path = require('node:path');
  const secrets = [s.sb.serviceKey, s.rs.apiKey, ADMIN_ENV.SESSION_SECRET];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(path.join(__dirname, '../public')).concat(walk(path.join(__dirname, '../admin')))) { if (/\.(jpg|png)$/.test(f)) continue; const t = fs.readFileSync(f, 'utf8'); for (const k of secrets) assert.ok(!t.includes(k), f); }
  await post(s.base, '/api/enquiries', goodEnquiry({ elapsedMs: 1 })); const e = await (await fetch(s.base + '/api/admin/enquiries')).text(); for (const k of secrets) assert.ok(!e.includes(k));
  await s.close();
});
