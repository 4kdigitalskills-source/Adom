'use strict';
const { build } = require('../server/config');
const { open } = require('../server/store/sqlite');
const { createApp } = require('../server/app');
const { hashPassword } = require('../server/auth');

const PASSWORD = 'correct horse battery staple';
const ADMIN_ENV = { ADMIN_EMAIL: 'owner@example.test', ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), SESSION_SECRET: 'x'.repeat(40) };
const PARTNER_ENV = { LEAD_PARTNER_NAME: 'Test Partner', LEAD_PARTNER_EMAIL: 'partner@example.test', LEAD_PARTNER_PHONE: '+233200000000', COMMISSION_RATE_PERCENT: '10', REFERRAL_AGREEMENT_CONFIRMED: 'true' };

async function start(env = {}) {
  const config = build({ NODE_ENV: 'test', SITE_URL: 'https://adom.example', ...env });
  const store = open(':memory:');
  const server = createApp(config, store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store, config, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}
const goodEnquiry = (o = {}) => ({ name: 'Kofi Mensah', phone: '024 123 4567', location: 'Cape Coast', service: 'Car AC gas refilling', vehicle: 'BMW 5 Series', message: 'AC blowing warm', consent: true, website: '', elapsedMs: 9000, ...o });
const post = (base, path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function login(base) {
  const r = await post(base, '/api/admin/login', { email: ADMIN_ENV.ADMIN_EMAIL, password: PASSWORD });
  return { res: r, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
module.exports = { start, goodEnquiry, post, login, ADMIN_ENV, PARTNER_ENV, PASSWORD };
