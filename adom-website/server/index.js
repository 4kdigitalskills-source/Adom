'use strict';
const { config } = require('./config');
const { createApp } = require('./app');
const { createMailer } = require('./mailer');
const { createNotifier } = require('./notifier');

async function main() {
  let store;
  if (config.storeKind === 'supabase') store = require('./store/supabase').create({ url: config.supabase.url, serviceKey: config.supabase.serviceKey });
  else store = require('./store/sqlite').open(config.databasePath);

  const mailer = config.emailConfigured ? createMailer({ apiKey: config.mail.apiKey, from: config.mail.from }) : null;
  const notifier = createNotifier({ store, mailer, config });
  const server = createApp(config, store, { notifier, mailer });

  // Start-up self-check: tells you in the logs whether the database is reachable.
  try { await store.ping(); console.log(`Database (${store.kind}): reachable`); }
  catch (e) { console.error(`Database (${store.kind}) NOT reachable: ${e.message}. Enquiries will fail until this is fixed.`); }

  server.listen(config.port, () => {
    console.log(`ADOM site running on port ${config.port} (${config.isProd ? 'production' : 'development'})`);
    console.log(`Enquiry form: ${config.enquiriesEnabled ? 'ENABLED' : 'DISABLED (visitors are directed to phone/WhatsApp)'}`);
    const missing = config.isProd ? config.productionMissing : config.leadPartnerMissing;
    if (missing.length) console.log('Setup incomplete. Missing: ' + missing.join(', '));
    console.log(`Admin dashboard: ${config.admin.configured ? '/admin' + (config.admin.totpSecret ? ' (two-step sign-in on)' : '') : 'DISABLED (missing ' + config.admin.missing.join(', ') + ')'}`);
    console.log(`Email notifications: ${mailer ? 'configured (Resend)' : 'NOT configured; enquiries are saved but nobody is emailed'}`);
  });
  if (mailer) notifier.start();

  // Optional retention: only runs if RETENTION_DAYS is set. Deletes completed/cancelled enquiries older than that.
  if (config.retentionDays) {
    const purge = async () => { try { const n = await store.purgeClosedBefore(new Date(Date.now() - config.retentionDays * 86400000).toISOString()); if (n) console.log(`[retention] removed ${n} closed enquiries`); } catch (e) { console.error('[retention] failed:', e.message); } };
    setTimeout(purge, 60000).unref(); setInterval(purge, 24 * 3600 * 1000).unref();
  }
  // Light heartbeat so a free-tier database is not paused for inactivity while the site is running.
  if (config.storeKind === 'supabase') setInterval(() => store.ping().catch(() => {}), 6 * 3600 * 1000).unref();

  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { notifier.stop(); server.close(() => { store.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); });
}
main().catch((e) => { console.error('Fatal start-up error:', e.message); process.exit(1); });
