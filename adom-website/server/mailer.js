'use strict';
/** Resend (https://resend.com) transactional email over HTTPS. No dependencies. */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim();

function createMailer({ apiKey, from, fetchImpl = fetch, endpoint = 'https://api.resend.com/emails', timeoutMs = 15000 }) {
  return {
    async send({ to, subject, text, html, idempotencyKey }) {
      const headers = { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' };
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey; // avoids duplicate emails if we retry after a timeout
      let res;
      try { res = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify({ from, to: [to], subject: oneLine(subject), text, html }), signal: AbortSignal.timeout(timeoutMs) }); }
      catch (e) { throw Object.assign(new Error('email provider unreachable'), { retryable: true }); }
      if (res.ok) return true;
      let detail = ''; try { const j = await res.json(); detail = j && (j.message || j.name) || ''; } catch { /* ignore */ }
      // 4xx (other than 408/429) means our request/config is wrong; retrying will not help.
      throw Object.assign(new Error(`email provider ${res.status}: ${String(detail).slice(0, 160)}`), { retryable: res.status >= 500 || res.status === 429 || res.status === 408, status: res.status });
    }
  };
}

function buildLeadEmail(e, { siteUrl }) {
  const rows = [['Reference', e.reference], ['Received (UTC)', e.created_at], ['Name', e.customer_name], ['Phone', e.customer_phone], ['Area', e.customer_area],
    ['Service', e.service_type], ['Vehicle', e.vehicle_details || '—'], ['Issue', e.enquiry_message || '—']];
  const link = siteUrl + '/admin';
  const text = ['New ADOM website enquiry', '', ...rows.map(([k, v]) => `${k}: ${String(v).replace(/\r/g, '')}`), '', 'Open the private dashboard to qualify and refer this lead:', link, '',
    'This message contains personal information. Do not forward it; use the dashboard.'].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;color:#15243a;max-width:560px"><h2 style="color:#082b59;margin:0 0 12px">New ADOM website enquiry</h2>` +
    `<table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #e7ebf1;color:#627084;width:130px;vertical-align:top">${esc(k)}</td><td style="padding:6px 10px;border-bottom:1px solid #e7ebf1;white-space:pre-wrap">${esc(v)}</td></tr>`).join('')}</table>` +
    `<p><a href="${esc(link)}" style="display:inline-block;background:#ffc928;color:#15243a;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:700">Open private dashboard</a></p>` +
    `<p style="color:#627084;font-size:12px">This message contains personal information. Do not forward it; use the dashboard.</p></div>`;
  return { subject: `New ADOM enquiry ${e.reference}: ${oneLine(e.service_type)}`, text, html };
}
const buildTestEmail = ({ siteUrl }) => ({ subject: 'ADOM website: test notification', text: `This is a test message from the ADOM website. If you can read it, lead notifications can reach this address.\n\n${siteUrl}/admin`,
  html: `<p style="font-family:Arial,sans-serif">This is a test message from the ADOM website. If you can read it, lead notifications can reach this address.</p>` });

module.exports = { createMailer, buildLeadEmail, buildTestEmail, esc };
