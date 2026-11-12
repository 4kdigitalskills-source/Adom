'use strict';
/**
 * Storage adapter (SQLite via node:sqlite). The rest of the app only uses the methods returned here,
 * so a Supabase/PostgreSQL adapter exposing the same methods can replace this file later (see docs/BACKEND-INTEGRATION.md).
 * Money is stored as integer pesewas.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const { newReference } = require('./common');

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS enquiries (
      id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL, customer_area TEXT NOT NULL,
      service_type TEXT NOT NULL, vehicle_details TEXT, enquiry_message TEXT,
      consent_at TEXT NOT NULL, privacy_notice_version TEXT NOT NULL, source_page TEXT,
      lead_status TEXT NOT NULL DEFAULT 'new' CHECK (lead_status IN ('new','contacted','qualified','referred','booked','completed','cancelled')),
      referred_to TEXT, referral_date TEXT, job_value_pesewas INTEGER, commission_rate_bp INTEGER, commission_pesewas INTEGER,
      internal_notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_enq_created ON enquiries(created_at);
    CREATE INDEX IF NOT EXISTS idx_enq_status ON enquiries(lead_status);
    CREATE INDEX IF NOT EXISTS idx_enq_phone ON enquiries(customer_phone, service_type, created_at);
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, enquiry_id TEXT NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
      recipient_role TEXT NOT NULL DEFAULT 'lead_partner', channel TEXT NOT NULL DEFAULT 'email',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, sent_at TEXT,
      next_attempt_at TEXT NOT NULL, locked_at TEXT, last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
      enquiry_id TEXT, detail TEXT
    );
  `);
  const now = () => new Date().toISOString();
  const q = (sql) => db.prepare(sql);

  const audit = (actor, action, enquiryId, detail) =>
    q('INSERT INTO audit_log(at,actor,action,enquiry_id,detail) VALUES(?,?,?,?,?)').run(now(), actor, action, enquiryId || null, detail ? JSON.stringify(detail) : null);

  return {
    kind: 'sqlite',
    raw: db,
    close: () => db.close(),
    audit,
    createEnquiry(v, meta) {
      const id = crypto.randomUUID(), t = now();
      let ref, tries = 0;
      for (;;) {
        ref = newReference();
        try {
          q(`INSERT INTO enquiries(id,reference,created_at,updated_at,customer_name,customer_phone,customer_area,service_type,vehicle_details,enquiry_message,consent_at,privacy_notice_version,source_page)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, ref, t, t, v.name, v.phone, v.area, v.service, v.vehicle || null, v.message || null, t, meta.privacyVersion, meta.sourcePage || null);
          break;
        } catch (e) { if (++tries > 5 || !/UNIQUE/.test(String(e.message))) throw e; }
      }
      // Notify the lead partner FIRST: queue a notification; a worker/Edge Function delivers it.
      q('INSERT INTO notification_outbox(enquiry_id,recipient_role,channel,status,created_at,next_attempt_at) VALUES(?,?,?,?,?,?)').run(id, 'lead_partner', 'email', 'pending', t, t);
      audit('public-form', 'enquiry.created', id, { reference: ref });
      return { id, reference: ref };
    },
    findRecentDuplicate(phone, service, sinceIso) {
      return q('SELECT reference FROM enquiries WHERE customer_phone=? AND service_type=? AND created_at>=? ORDER BY created_at DESC LIMIT 1').get(phone, service, sinceIso) || null;
    },
    list(f = {}) {
      const w = [], a = [];
      if (f.status) { w.push('lead_status=?'); a.push(f.status); }
      if (f.service) { w.push('service_type=?'); a.push(f.service); }
      if (f.vehicle) { w.push('vehicle_details LIKE ?'); a.push('%' + f.vehicle.replace(/[%_]/g, '') + '%'); }
      if (f.from) { w.push('created_at>=?'); a.push(f.from); }
      if (f.to) { w.push('created_at<=?'); a.push(f.to + 'T23:59:59.999Z'); }
      if (f.q) { w.push('(customer_name LIKE ? OR customer_phone LIKE ? OR reference LIKE ? OR customer_area LIKE ?)'); const s = '%' + f.q.replace(/[%_]/g, '') + '%'; a.push(s, s, s, s); }
      const limit = Math.min(Number(f.limit) || 200, 1000);
      return q(`SELECT * FROM enquiries ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ${limit}`).all(...a);
    },
    get: (id) => q('SELECT * FROM enquiries WHERE id=?').get(id) || null,
    update(id, patch) {
      const cols = Object.keys(patch); if (!cols.length) return this.get(id);
      q(`UPDATE enquiries SET ${cols.map((c) => c + '=?').join(',')}, updated_at=? WHERE id=?`).run(...cols.map((c) => patch[c]), now(), id);
      return this.get(id);
    },
    remove(id) { return q('DELETE FROM enquiries WHERE id=?').run(id).changes > 0; },
    outboxFor: (id) => q('SELECT id,recipient_role,channel,status,attempts,created_at,sent_at,last_error FROM notification_outbox WHERE enquiry_id=?').all(id),
    claimNotifications(limit = 5) {
      const t = now(), stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const ids = q("SELECT id FROM notification_outbox WHERE (status='pending' AND next_attempt_at<=?) OR (status='sending' AND locked_at<?) ORDER BY id LIMIT ?").all(t, stale, limit);
      return ids.map(({ id }) => {
        q("UPDATE notification_outbox SET status='sending', locked_at=?, attempts=attempts+1 WHERE id=?").run(t, id);
        const o = q('SELECT * FROM notification_outbox WHERE id=?').get(id);
        return { id: o.id, attempts: o.attempts, enquiry: this.get(o.enquiry_id) };
      }).filter((n) => n.enquiry);
    },
    finishNotification(id, { ok, error, final, retryAt }) {
      if (ok) q("UPDATE notification_outbox SET status='sent', sent_at=?, locked_at=NULL, last_error=NULL WHERE id=?").run(now(), id);
      else q('UPDATE notification_outbox SET status=?, next_attempt_at=?, locked_at=NULL, last_error=? WHERE id=?').run(final ? 'failed' : 'pending', retryAt || now(), String(error || '').slice(0, 300), id);
    },
    notificationCounts() {
      const r = q("SELECT status, COUNT(*) AS n FROM notification_outbox WHERE status IN ('pending','sending','failed') GROUP BY status").all();
      const g = (k) => (r.find((x) => x.status === k) || { n: 0 }).n;
      return { pending: g('pending') + g('sending'), failed: g('failed') };
    },
    purgeClosedBefore(iso) {
      const n = q("DELETE FROM enquiries WHERE lead_status IN ('completed','cancelled') AND updated_at<?").run(iso).changes;
      if (n) audit('system', 'retention.purge', null, { deleted: n, before: iso });
      return n;
    },
    ping() { q('SELECT 1').get(); return true; },
    auditFor: (limit = 100) => q('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit),
    stats: () => q('SELECT lead_status AS status, COUNT(*) AS n FROM enquiries GROUP BY lead_status').all()
  };
}
module.exports = { open };
