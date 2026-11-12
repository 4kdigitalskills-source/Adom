'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const V = require('./validate');
const A = require('./auth');
const { createLimiter } = require('./ratelimit');
const { buildTestEmail } = require('./mailer');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };

function createApp(config, store, { notifier = null, mailer = null } = {}) {
  const PUBLIC = path.join(config.root, 'public');
  const ADMIN = path.join(config.root, 'admin');
  const enquiryLimiter = createLimiter({ max: 5, windowMs: 10 * 60 * 1000 });
  const loginLimiter = createLimiter({ max: 8, windowMs: 15 * 60 * 1000 });
  const ipSalt = crypto.randomBytes(16);

  const clientIp = (req) => (config.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
  const ipKey = (req) => crypto.createHmac('sha256', ipSalt).update(clientIp(req)).digest('hex').slice(0, 24); // never stored or logged raw

  function securityHeaders(res, { admin = false } = {}) {
    res.setHeader('Content-Security-Policy', ["default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
      "img-src 'self' data:", "connect-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'"].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (admin) { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); res.setHeader('Cache-Control', 'no-store'); }
  }
  function json(res, status, body, extra = {}) {
    securityHeaders(res);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  }
  function readJson(req, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0, tooLarge = false; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 1024 * 1024) { req.destroy(); return; }   // hard cap: drop abusive connections
        if (size > limit) { tooLarge = true; chunks.length = 0; } else if (!tooLarge) chunks.push(c);
      });
      req.on('end', () => {
        if (tooLarge) return reject(Object.assign(new Error('too large'), { status: 413 }));
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }
  const isJsonReq = (req) => /^application\/json\b/i.test(req.headers['content-type'] || '');

  // ---------- sessions ----------
  function session(req) {
    if (!config.admin.configured) return null;
    const t = A.parseCookies(req.headers.cookie).adom_admin;
    const p = A.verify(t, config.sessionSecret);
    return p && p.sub === config.admin.email ? p : null;
  }
  const cookieFlags = () => `Path=/; HttpOnly; SameSite=Strict${config.isProd ? '; Secure' : ''}`;

  // ---------- public API ----------
  async function postEnquiry(req, res) {
    if (!isJsonReq(req)) return json(res, 415, { error: 'unsupported_media_type' });
    if (!config.enquiriesEnabled) return json(res, 503, { error: 'not_configured' }); // never pretend to accept
    const rl = enquiryLimiter.take(ipKey(req));
    if (!rl.allowed) return json(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(rl.retryAfterSec) });
    let body; try { body = await readJson(req); } catch (e) { return json(res, e.status || 400, { error: 'bad_request' }); }
    if (body && typeof body.website === 'string' && body.website.trim() !== '') return json(res, 200, { ok: true }); // honeypot: no reference issued
    if (Number(body.elapsedMs) < 2500) return json(res, 422, { errors: { form: 'Please take a moment to complete the form, then submit again.' } });
    const v = V.validateEnquiry(body);
    if (!v.ok) return json(res, 422, { errors: v.errors });
    const dup = await store.findRecentDuplicate(v.value.phone, v.value.service, new Date(Date.now() - 10 * 60 * 1000).toISOString());
    if (dup) return json(res, 200, { ok: true, reference: dup.reference });
    try {
      const r = await store.createEnquiry(v.value, { privacyVersion: config.privacyNoticeVersion, sourcePage: String(req.headers.referer || '').slice(0, 200).replace(/[?#].*$/, '') });
      console.log(`[enquiry] stored ${r.reference}`); // no personal data in logs
      if (notifier) notifier.kick();                       // lead partner is notified first, in the background
      return json(res, 201, { ok: true, reference: r.reference });
    } catch (e) { console.error('[enquiry] store failed:', e.message); return json(res, 500, { error: 'storage_failed' }); }
  }

  // ---------- admin API ----------
  const publicRow = (r) => r && ({
    id: r.id, reference: r.reference, created_at: r.created_at, updated_at: r.updated_at, name: r.customer_name, phone: r.customer_phone, area: r.customer_area,
    service: r.service_type, vehicle: r.vehicle_details, message: r.enquiry_message, consent_at: r.consent_at, privacy_notice_version: r.privacy_notice_version,
    status: r.lead_status, referred_to: r.referred_to, referral_date: r.referral_date,
    job_value_ghs: r.job_value_pesewas == null ? null : (r.job_value_pesewas / 100).toFixed(2),
    commission_rate_percent: r.commission_rate_bp == null ? null : (r.commission_rate_bp / 100).toFixed(2),
    commission_ghs: r.commission_pesewas == null ? null : (r.commission_pesewas / 100).toFixed(2), notes: r.internal_notes
  });
  const csvCell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }; // neutralise spreadsheet formula injection

  async function admin(req, res, url) {
    const m = req.method, p = url.pathname;
    if (p === '/api/admin/login' && m === 'POST') {
      if (!config.admin.configured) return json(res, 503, { error: 'admin_not_configured' });
      const rl = loginLimiter.take(ipKey(req)); if (!rl.allowed) return json(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(rl.retryAfterSec) });
      if (!isJsonReq(req)) return json(res, 415, { error: 'unsupported_media_type' });
      let b; try { b = await readJson(req, 2048); } catch { return json(res, 400, { error: 'bad_request' }); }
      const okEmail = typeof b.email === 'string' && b.email.trim().toLowerCase() === config.admin.email;
      const okPw = typeof b.password === 'string' && A.verifyPassword(b.password, config.admin.passwordHash); // always run to keep timing similar
      const okCode = !config.admin.totpSecret || A.verifyTotp(config.admin.totpSecret, b.code);              // two-step sign-in, when enabled
      if (!(okEmail && okPw && okCode)) { await store.audit('unknown', 'admin.login_failed', null); return json(res, 401, { error: 'invalid_credentials' }); }
      loginLimiter.reset(ipKey(req));
      const token = A.sign({ sub: config.admin.email, exp: Date.now() + A.SESSION_MS }, config.sessionSecret);
      await store.audit(config.admin.email, 'admin.login', null);
      return json(res, 200, { ok: true }, { 'Set-Cookie': `adom_admin=${encodeURIComponent(token)}; ${cookieFlags()}; Max-Age=${A.SESSION_MS / 1000}` });
    }
    const s = session(req);
    if (!s) return json(res, 401, { error: 'unauthorized' });
    // CSRF defence in depth: SameSite=Strict cookie + require JSON content type / same-origin on state changes.
    if (m !== 'GET' && m !== 'HEAD') {
      const origin = req.headers.origin; if (origin && origin !== new URL(config.siteUrl).origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return json(res, 403, { error: 'bad_origin' });
      if (m !== 'DELETE' && !isJsonReq(req)) return json(res, 415, { error: 'unsupported_media_type' });
    }
    if (p === '/api/admin/logout' && m === 'POST') { await store.audit(s.sub, 'admin.logout', null); return json(res, 200, { ok: true }, { 'Set-Cookie': `adom_admin=; ${cookieFlags()}; Max-Age=0` }); }
    if (p === '/api/admin/me') return json(res, 200, { email: s.sub });
    if (p === '/api/admin/settings') {
      let db = 'ok', counts = { pending: 0, failed: 0 }, stats = [];
      try { await store.ping(); counts = await store.notificationCounts(); stats = await store.stats(); } catch (e) { db = 'error'; }
      return json(res, 200, {
        statuses: V.STATUSES, transitions: V.TRANSITIONS, services: V.SERVICES,
        readiness: { leadPartnerConfigured: config.leadPartnerConfigured, missing: config.isProd ? config.productionMissing : config.leadPartnerMissing, enquiriesEnabled: config.enquiriesEnabled, devMode: config.devMode,
          commissionRatePercent: config.leadPartner.commissionRatePercent, siteUrlConfigured: config.siteUrlOk, database: store.kind, databaseStatus: db,
          emailConfigured: config.emailConfigured, twoStepEnabled: !!config.admin.totpSecret, pendingNotifications: counts.pending, failedNotifications: counts.failed,
          retentionDays: config.retentionDays },
        stats
      });
    }
    if (p === '/api/admin/test-email' && m === 'POST') {
      if (!mailer || !config.leadPartner.email) return json(res, 422, { error: 'email_not_configured' });
      try { await mailer.send({ to: config.leadPartner.email, ...buildTestEmail({ siteUrl: config.siteUrl }) }); await store.audit(s.sub, 'email.test_sent', null); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 502, { error: 'send_failed', detail: e.message }); }
    }
    if (p === '/api/admin/totp-setup' && m === 'GET') {
      const secret = A.newTotpSecret();
      return json(res, 200, { secret, otpauth: `otpauth://totp/ADOM%20Dashboard:${encodeURIComponent(config.admin.email)}?secret=${secret}&issuer=ADOM%20Dashboard`, alreadyEnabled: !!config.admin.totpSecret });
    }
    if (p === '/api/admin/audit') return json(res, 200, { audit: await store.auditFor(200) });
    if (p === '/api/admin/enquiries' && m === 'GET') {
      const f = Object.fromEntries(url.searchParams); if (f.status && !V.STATUSES.includes(f.status)) delete f.status;
      return json(res, 200, { enquiries: (await store.list(f)).map(publicRow) });
    }
    if (p === '/api/admin/export.csv' && m === 'GET') {
      const rows = (await store.list({ ...Object.fromEntries(url.searchParams), limit: 1000 })).map(publicRow);
      const cols = ['reference', 'created_at', 'name', 'phone', 'area', 'service', 'vehicle', 'status', 'referred_to', 'referral_date', 'job_value_ghs', 'commission_rate_percent', 'commission_ghs'];
      await store.audit(s.sub, 'export.csv', null, { rows: rows.length });
      securityHeaders(res, { admin: true });
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="adom-enquiries.csv"' });
      return res.end('\ufeff' + [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))).join('\r\n'));
    }
    const mm = p.match(/^\/api\/admin\/enquiries\/([0-9a-f-]{36})$/);
    if (mm) {
      const row = await store.get(mm[1]); if (!row) return json(res, 404, { error: 'not_found' });
      if (m === 'GET') return json(res, 200, { enquiry: publicRow(row), notifications: await store.outboxFor(row.id) });
      if (m === 'DELETE') { await store.remove(row.id); await store.audit(s.sub, 'enquiry.deleted', row.id, { reference: row.reference }); return json(res, 200, { ok: true }); }
      if (m === 'PATCH') {
        let b; try { b = await readJson(req, 4096); } catch { return json(res, 400, { error: 'bad_request' }); }
        const patch = {}, errors = {};
        if (b.status !== undefined) {
          if (!V.STATUSES.includes(b.status)) errors.status = 'Unknown status.';
          else if (!V.canTransition(row.lead_status, b.status)) errors.status = `Cannot move from ${row.lead_status} to ${b.status}.`;
          else patch.lead_status = b.status;
        }
        const target = patch.lead_status || row.lead_status;
        if (b.referred_to !== undefined) patch.referred_to = V.clean(b.referred_to, 120) || null;
        if (b.notes !== undefined) patch.internal_notes = V.cleanMultiline(b.notes, 2000) || null;
        if (patch.lead_status === 'referred' && !row.referral_date) patch.referral_date = new Date().toISOString();
        if (b.job_value_ghs !== undefined) {
          const pes = V.parseGhs(b.job_value_ghs);
          if (Number.isNaN(pes)) errors.job_value_ghs = 'Enter an amount in GHS, e.g. 450 or 450.50.'; else patch.job_value_pesewas = pes;
        }
        if (target === 'referred' || target === 'booked' || target === 'completed') {
          if (!(patch.referred_to || row.referred_to) && target === 'referred') errors.referred_to = 'Record who the lead was referred to.';
        }
        const jv = patch.job_value_pesewas !== undefined ? patch.job_value_pesewas : row.job_value_pesewas;
        if (target === 'completed') {
          if (jv == null) errors.job_value_ghs = 'Enter the completed job value before marking completed.';
          else if (config.leadPartner.commissionRatePercent == null) { patch.commission_rate_bp = null; patch.commission_pesewas = null; } // no agreed rate configured: never assume one
          else { patch.commission_rate_bp = V.rateToBp(config.leadPartner.commissionRatePercent); patch.commission_pesewas = V.commissionPesewas(jv, patch.commission_rate_bp); }
        } else if (patch.lead_status && patch.lead_status !== 'completed' && row.lead_status === 'completed') { /* completed is terminal */ }
        if (Object.keys(errors).length) return json(res, 422, { errors });
        const updated = await store.update(row.id, patch);
        await store.audit(s.sub, 'enquiry.updated', row.id, { fields: Object.keys(patch), from: row.lead_status, to: updated.lead_status });
        return json(res, 200, { enquiry: publicRow(updated) });
      }
    }
    return json(res, 404, { error: 'not_found' });
  }

  // ---------- static ----------
  const cache = new Map();
  function serveFile(req, res, file, { admin = false } = {}) {
    let data;
    try { data = fs.readFileSync(file); } catch { return false; }
    const ext = path.extname(file).toLowerCase();
    securityHeaders(res, { admin });
    if (['.html', '.xml', '.txt'].includes(ext)) data = Buffer.from(data.toString('utf8').replaceAll('https://YOUR-DOMAIN.com', config.siteUrl));
    const etag = '"' + crypto.createHash('sha1').update(data).digest('base64url') + '"';
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', ETag: etag };
    if (!admin) headers['Cache-Control'] = ext === '.html' || ext === '.xml' || ext === '.txt' ? 'public, max-age=300' : ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? 'public, max-age=604800' : 'public, max-age=3600';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
    res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : data); return true;
  }
  function safeJoin(base, rel) {
    const full = path.normalize(path.join(base, rel));
    return full.startsWith(base + path.sep) || full === base ? full : null;
  }
  function notFound(req, res) {
    const f = path.join(PUBLIC, '404.html');
    securityHeaders(res);
    let data = fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from('Not found');
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : data);
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let p; try { p = decodeURIComponent(url.pathname); } catch { return notFound(req, res); }
      if (p === '/healthz') return json(res, 200, { ok: true });
      if (p === '/readyz') { try { await store.ping(); return json(res, 200, { ok: true, database: store.kind, enquiries: config.enquiriesEnabled }); } catch { return json(res, 503, { ok: false }); } }
      if (p === '/api/enquiries') { if (req.method === 'POST') return await postEnquiry(req, res); return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' }); }
      if (p.startsWith('/api/admin/')) return await admin(req, res, url);
      if (p.startsWith('/api/')) return json(res, 404, { error: 'not_found' });
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
      if (p === '/admin' || p === '/admin/') return serveFile(req, res, path.join(ADMIN, 'index.html'), { admin: true }) || notFound(req, res);
      if (p === '/admin/app.js' || p === '/admin/admin.css') {
        if (p.endsWith('.js') && !session(req)) { res.writeHead(401); return res.end(); } // dashboard code only for signed-in admins
        return serveFile(req, res, path.join(ADMIN, path.basename(p)), { admin: true }) || notFound(req, res);
      }
      if (p === '/admin/login.js') return serveFile(req, res, path.join(ADMIN, 'login.js'), { admin: true }) || notFound(req, res);
      if (p === '/') p = '/index.html';
      const full = safeJoin(PUBLIC, p);
      if (full && /(^|\/)\./.test(p)) return notFound(req, res);
      if (full && fs.existsSync(full) && fs.statSync(full).isFile() && serveFile(req, res, full)) return;
      return notFound(req, res);
    } catch (e) {
      console.error('[error]', e.message);
      if (!res.headersSent) json(res, 500, { error: 'server_error' });
    }
  });
}
module.exports = { createApp };
