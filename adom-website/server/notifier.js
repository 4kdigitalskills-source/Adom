'use strict';
/**
 * Delivers queued lead-partner notifications. The lead partner is notified FIRST; ADOM is never emailed directly.
 * Failures are retried with growing delays; after MAX_ATTEMPTS the notification is marked failed and surfaced in the dashboard.
 * The enquiry itself is already safely stored, so an email problem never loses a lead.
 */
const { buildLeadEmail } = require('./mailer');
const MAX_ATTEMPTS = 6;
const backoffMs = (attempts) => Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** (attempts - 1)); // 1m, 2m, 4m, 8m, 16m, ...

function createNotifier({ store, mailer, config, intervalMs = 30000, log = console }) {
  let running = false, timer = null, again = false;
  async function runOnce() {
    if (running) { again = true; return { skipped: true }; }
    running = true; const result = { sent: 0, failed: 0, retried: 0 };
    try {
      if (!mailer || !config.leadPartner.email) return result;
      const batch = await store.claimNotifications(5);
      for (const n of batch) {
        try {
          const mail = buildLeadEmail(n.enquiry, { siteUrl: config.siteUrl });
          await mailer.send({ to: config.leadPartner.email, ...mail, idempotencyKey: `adom-notification-${n.id}` });
          await store.finishNotification(n.id, { ok: true }); result.sent++;
          await store.audit('system', 'notification.sent', n.enquiry.id, { channel: 'email', recipient: 'lead_partner' });
        } catch (e) {
          const final = n.attempts >= MAX_ATTEMPTS || e.retryable === false;
          await store.finishNotification(n.id, { ok: false, error: e.message, final, retryAt: new Date(Date.now() + backoffMs(n.attempts)).toISOString() });
          final ? result.failed++ : result.retried++;
          log.error(`[notify] notification ${n.id} attempt ${n.attempts} ${final ? 'FAILED' : 'will retry'}: ${e.message}`); // no personal data logged
        }
      }
    } catch (e) { log.error('[notify] worker error:', e.message); }
    finally { running = false; }
    if (again) { again = false; setImmediate(() => runOnce()); }
    return result;
  }
  return {
    runOnce,
    kick() { setImmediate(() => { runOnce().catch(() => {}); }); },          // send right after an enquiry is stored
    start() { if (!timer) { timer = setInterval(() => runOnce().catch(() => {}), intervalMs); timer.unref(); runOnce().catch(() => {}); } },
    stop() { clearInterval(timer); timer = null; }
  };
}
module.exports = { createNotifier, MAX_ATTEMPTS, backoffMs };
