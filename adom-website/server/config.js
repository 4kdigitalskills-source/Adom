'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader (no dependencies). Real environment variables win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const { hashPassword } = require('./auth');
const ROOT = path.resolve(__dirname, '..');
loadDotEnv(path.join(ROOT, '.env'));

function build(env = process.env) {
  const str = (k) => (env[k] || '').trim();
  const isProd = str('NODE_ENV') === 'production';
  const rateRaw = str('COMMISSION_RATE_PERCENT');
  const rate = rateRaw === '' ? null : Number(rateRaw);
  const rateValid = rate !== null && Number.isFinite(rate) && rate >= 0 && rate <= 100;

  const leadPartner = {
    name: str('LEAD_PARTNER_NAME'),
    email: str('LEAD_PARTNER_EMAIL'),
    phone: str('LEAD_PARTNER_PHONE'),
    commissionRatePercent: rateValid ? rate : null,
    agreementConfirmed: str('REFERRAL_AGREEMENT_CONFIRMED') === 'true'
  };
  const missing = [];
  if (!leadPartner.name) missing.push('LEAD_PARTNER_NAME');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(leadPartner.email)) missing.push('LEAD_PARTNER_EMAIL');
  if (!leadPartner.phone) missing.push('LEAD_PARTNER_PHONE');
  if (!rateValid) missing.push('COMMISSION_RATE_PERCENT');
  if (!leadPartner.agreementConfirmed) missing.push('REFERRAL_AGREEMENT_CONFIRMED');

  const sessionSecret = str('SESSION_SECRET');
  // Admin password: either a ready-made hash, or a long passphrase that the server hashes itself at start-up.
  let passwordHash = str('ADMIN_PASSWORD_HASH');
  if (!passwordHash.startsWith('scrypt$') && str('ADMIN_PASSWORD').length >= 14) passwordHash = hashPassword(str('ADMIN_PASSWORD'));
  const totpSecret = str('ADMIN_TOTP_SECRET').replace(/\s+/g, '').toUpperCase();
  const adminMissing = [];
  if (!str('ADMIN_EMAIL')) adminMissing.push('ADMIN_EMAIL');
  if (!passwordHash.startsWith('scrypt$')) adminMissing.push('ADMIN_PASSWORD (at least 14 characters)');
  if (sessionSecret.length < 32) adminMissing.push('SESSION_SECRET (at least 32 characters)');
  const adminConfigured = adminMissing.length === 0;
  const leadPartnerConfigured = missing.length === 0;

  const supabase = { url: str('SUPABASE_URL'), serviceKey: str('SUPABASE_SERVICE_ROLE_KEY') };
  const storeKind = supabase.url && supabase.serviceKey ? 'supabase' : 'sqlite';
  const mail = { apiKey: str('RESEND_API_KEY'), from: str('MAIL_FROM') };
  const emailConfigured = !!(mail.apiKey && /^[^<>]*<[^@\s]+@[^@\s]+\.[^@\s]+>$|^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail.from));
  const siteUrlRaw = str('SITE_URL');
  const siteUrlOk = /^https:\/\/[^/]+\.[^/]+/.test(siteUrlRaw) && !/YOUR-DOMAIN/i.test(siteUrlRaw);

  // Everything production needs before real customer enquiries are accepted.
  const productionMissing = [...missing];
  if (storeKind !== 'supabase') productionMissing.push('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  if (!emailConfigured) productionMissing.push('RESEND_API_KEY', 'MAIL_FROM');
  if (!siteUrlOk) productionMissing.push('SITE_URL (https address of the live site)');
  const productionReady = productionMissing.length === 0;
  // Production activation is blocked until every item above is configured.
  const devMode = !isProd && str('ENQUIRY_DEV_MODE') === 'true';
  const retentionDays = Number(str('RETENTION_DAYS')) > 0 ? Math.floor(Number(str('RETENTION_DAYS'))) : null; // no default: a business/legal decision
  return {
    root: ROOT,
    isProd,
    port: Number(str('PORT')) || 3000,
    siteUrl: (siteUrlRaw || 'https://YOUR-DOMAIN.com').replace(/\/+$/, ''),
    siteUrlOk,
    trustProxy: str('TRUST_PROXY') === 'true',
    databasePath: path.resolve(ROOT, str('DATABASE_PATH') || './data/adom.sqlite'),
    sessionSecret,
    admin: { email: str('ADMIN_EMAIL').toLowerCase(), passwordHash, totpSecret, configured: adminConfigured, missing: adminMissing },
    leadPartner, leadPartnerMissing: missing, leadPartnerConfigured,
    supabase, storeKind, mail, emailConfigured, productionMissing, productionReady, retentionDays,
    enquiriesEnabled: isProd ? productionReady : (leadPartnerConfigured || devMode),
    devMode,
    privacyNoticeVersion: '2026-11-11-v2'
  };
}
module.exports = { build, config: build() };
