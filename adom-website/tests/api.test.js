'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { start, goodEnquiry, post, login, ADMIN_ENV, PARTNER_ENV } = require('./helpers');

test('enquiries are blocked (503) until lead partner is configured; nothing is stored', async () => {
  const s = await start({ ...ADMIN_ENV }); 
  const r = await post(s.base, '/api/enquiries', goodEnquiry());
  assert.equal(r.status, 503); assert.equal(s.store.list().length, 0); await s.close();
});
test('production never activates via dev flag', async () => {
  const s = await start({ NODE_ENV: 'production', ENQUIRY_DEV_MODE: 'true' });
  assert.equal(s.config.enquiriesEnabled, false); await s.close();
});
test('valid enquiry is stored with consent + privacy version, queues lead-partner notification first, returns reference', async () => {
  const s = await start({ ...ADMIN_ENV, ...PARTNER_ENV });
  const r = await post(s.base, '/api/enquiries', goodEnquiry()); const b = await r.json();
  assert.equal(r.status, 201); assert.match(b.reference, /^ADOM-\d{6}-[A-Z0-9]{5}$/);
  const row = s.store.list()[0]; assert.equal(row.lead_status, 'new'); assert.ok(row.consent_at); assert.equal(row.privacy_notice_version, '2026-11-11-v2');
  const out = s.store.outboxFor(row.id); assert.equal(out[0].recipient_role, 'lead_partner'); assert.equal(out[0].status, 'pending');
  await s.close();
});
test('invalid input -> 422, honeypot -> no reference/no row, too-fast -> rejected, wrong content-type -> 415', async () => {
  const s = await start({ ...PARTNER_ENV });
  assert.equal((await post(s.base, '/api/enquiries', goodEnquiry({ phone: '123' }))).status, 422);
  const hp = await post(s.base, '/api/enquiries', goodEnquiry({ website: 'http://spam' })); assert.equal((await hp.json()).reference, undefined);
  assert.equal((await post(s.base, '/api/enquiries', goodEnquiry({ elapsedMs: 100 }))).status, 422);
  const t = await fetch(s.base + '/api/enquiries', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }); assert.equal(t.status, 415);
  assert.equal(s.store.list().length, 0); await s.close();
});
test('rate limit: 6th rapid enquiry from one client gets 429', async () => {
  const s = await start({ ...PARTNER_ENV }); let last;
  for (let i = 0; i < 6; i++) last = await post(s.base, '/api/enquiries', goodEnquiry({ phone: '02412345' + (10 + i), service: 'AC servicing' }));
  assert.equal(last.status, 429); await s.close();
});
test('duplicate submission within 10 minutes returns the same reference', async () => {
  const s = await start({ ...PARTNER_ENV });
  const a = await (await post(s.base, '/api/enquiries', goodEnquiry())).json(); const b = await (await post(s.base, '/api/enquiries', goodEnquiry())).json();
  assert.equal(a.reference, b.reference); assert.equal(s.store.list().length, 1); await s.close();
});
test('oversized body rejected', async () => {
  const s = await start({ ...PARTNER_ENV });
  const r = await post(s.base, '/api/enquiries', goodEnquiry({ message: 'x'.repeat(40000) })); assert.equal(r.status, 413); await s.close();
});

test('unauthorised access: every admin route rejects anonymous users; admin code not served to anonymous', async () => {
  const s = await start({ ...ADMIN_ENV, ...PARTNER_ENV });
  const id = (await (await post(s.base, '/api/enquiries', goodEnquiry())).json()) && s.store.list()[0].id;
  for (const [m, p] of [['GET', '/api/admin/enquiries'], ['GET', '/api/admin/export.csv'], ['GET', '/api/admin/settings'], ['GET', '/api/admin/audit'], ['GET', `/api/admin/enquiries/${id}`], ['PATCH', `/api/admin/enquiries/${id}`], ['DELETE', `/api/admin/enquiries/${id}`]]) {
    const r = await fetch(s.base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'PATCH' ? '{}' : undefined }); assert.equal(r.status, 401, m + ' ' + p);
  }
  assert.equal((await fetch(s.base + '/admin/app.js')).status, 401);
  assert.equal((await fetch(s.base + '/api/admin/enquiries', { headers: { Cookie: 'adom_admin=forged.token' } })).status, 401);
  await s.close();
});
test('admin login: wrong password 401, rate-limited, disabled when not configured; no public signup route', async () => {
  const s = await start({ ...ADMIN_ENV });
  assert.equal((await post(s.base, '/api/admin/login', { email: ADMIN_ENV.ADMIN_EMAIL, password: 'nope' })).status, 401);
  assert.equal((await post(s.base, '/api/admin/signup', { email: 'a@b.c', password: 'x' })).status, 401);
  let last; for (let i = 0; i < 9; i++) last = await post(s.base, '/api/admin/login', { email: 'x@y.z', password: 'bad' }); assert.equal(last.status, 429);
  await s.close();
  const s2 = await start({}); assert.equal((await post(s2.base, '/api/admin/login', { email: 'a', password: 'b' })).status, 503); await s2.close();
});
test('signed-in admin: list/filter, status workflow, referral, commission, CSV export (formula-safe), audit trail, delete', async () => {
  const s = await start({ ...ADMIN_ENV, ...PARTNER_ENV });
  await post(s.base, '/api/enquiries', goodEnquiry({ name: '=HYPERLINK("http://x")' }));
  const { res, cookie } = await login(s.base); assert.equal(res.status, 200); assert.match(res.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const H = { 'Content-Type': 'application/json', Cookie: cookie };
  const list = await (await fetch(s.base + '/api/admin/enquiries?service=Car%20AC%20gas%20refilling&vehicle=BMW', { headers: H })).json(); assert.equal(list.enquiries.length, 1);
  const id = list.enquiries[0].id; const patch = (b) => fetch(`${s.base}/api/admin/enquiries/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify(b) });
  assert.equal((await patch({ status: 'completed' })).status, 422);                 // illegal jump
  for (const st of ['contacted', 'qualified']) assert.equal((await patch({ status: st })).status, 200);
  assert.equal((await patch({ status: 'referred' })).status, 422);                  // needs referred_to
  assert.equal((await patch({ status: 'referred', referred_to: 'ADOM Workshop' })).status, 200);
  assert.equal((await patch({ status: 'booked' })).status, 200);
  assert.equal((await patch({ status: 'completed' })).status, 422);                 // needs job value
  const done = await (await patch({ status: 'completed', job_value_ghs: '1234.56' })).json();
  assert.equal(done.enquiry.commission_rate_percent, '10.00'); assert.equal(done.enquiry.commission_ghs, '123.46'); assert.ok(done.enquiry.referral_date);
  const csv = await (await fetch(s.base + '/api/admin/export.csv', { headers: H })).text(); assert.match(csv, /"'=HYPERLINK/); assert.ok(!/,=HYPERLINK/.test(csv));
  const audit = await (await fetch(s.base + '/api/admin/audit', { headers: H })).json(); assert.ok(audit.audit.some((a) => a.action === 'enquiry.updated') && audit.audit.some((a) => a.action === 'export.csv'));
  assert.equal((await fetch(`${s.base}/api/admin/enquiries/${id}`, { method: 'DELETE', headers: H })).status, 200); assert.equal(s.store.list().length, 0);
  await s.close();
});
test('state-changing admin calls from a foreign origin are refused', async () => {
  const s = await start({ ...ADMIN_ENV, ...PARTNER_ENV }); const { cookie } = await login(s.base);
  const r = await fetch(s.base + '/api/admin/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://evil.example' }, body: '{}' }); assert.equal(r.status, 403); await s.close();
});

test('static site: headers, SITE_URL substitution, preserved content, no path traversal, no dotfiles', async () => {
  const s = await start({});
  const home = await fetch(s.base + '/'); const html = await home.text();
  assert.equal(home.status, 200); assert.match(home.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(!html.includes('YOUR-DOMAIN.com')); assert.match(html, /rel="canonical" href="https:\/\/adom\.example\/"/);
  for (const must of ['+233 24 666 3591', '+233 27 324 2468', 'isaacarthur@gmail.com', 'CCTU Polytechnic Road, Cape Coast, Ghana', 'Mercedes-Benz, BMW and Porsche', 'Car AC Gas, Compressor &amp; Condenser'.replace('&amp;', '&'), 'application/ld+json', 'privacy-policy.html']) assert.ok(html.includes(must), must);
  assert.equal((await fetch(s.base + '/privacy-policy.html')).status, 200);
  assert.match(await (await fetch(s.base + '/sitemap.xml')).text(), /https:\/\/adom\.example\//);
  assert.equal((await fetch(s.base + '/%2e%2e/package.json')).status, 404); assert.equal((await fetch(s.base + '/..%2fserver/config.js')).status, 404);
  assert.equal((await fetch(s.base + '/.env')).status, 404); assert.equal((await fetch(s.base + '/nope')).status, 404);
  assert.equal((await fetch(s.base + '/assets/adom-logo-from-reference.jpg')).headers.get('content-type'), 'image/jpeg');
  await s.close();
});

test('SEO: service pages, sitemap, robots, structured data', async () => {
  const s = await start({}); const fs = require('node:fs');
  const pages = ['refrigerator-repair-cape-coast.html', 'air-conditioning-services-cape-coast.html', 'car-ac-repair-cape-coast.html'];
  const sm = await (await fetch(s.base + '/sitemap.xml')).text();
  for (const p of pages) {
    const html = await (await fetch(s.base + '/' + p)).text();
    assert.match(html, new RegExp(`rel="canonical" href="https://adom\\.example/${p}"`)); assert.ok(sm.includes('/' + p), p); assert.ok(html.includes('application/ld+json') && html.includes('<h1>'));
    assert.ok(!/\$\d|GHS|GH₵|guarantee|warranty|years of experience|\d+ ?%|★/i.test(html), 'no invented prices/guarantees/reviews: ' + p);
  }
  const car = await (await fetch(s.base + '/car-ac-repair-cape-coast.html')).text();
  for (const k of ['Mercedes-Benz, BMW and Porsche', 'gas refilling', 'Compressor repairs', 'Condenser repairs', 'diagnosis']) assert.ok(car.includes(k), k);
  const robots = await (await fetch(s.base + '/robots.txt')).text(); assert.match(robots, /Disallow: \/admin/); assert.match(robots, /Sitemap: https:\/\/adom\.example\/sitemap\.xml/);
  const home = await (await fetch(s.base + '/')).text(); assert.ok(home.includes('hasOfferCatalog') && home.includes('Car AC compressor repair') && home.includes('privacy-policy.html'));
  assert.match((await fetch(s.base + '/admin')).headers.get('x-robots-tag'), /noindex/);
  await s.close();
});
