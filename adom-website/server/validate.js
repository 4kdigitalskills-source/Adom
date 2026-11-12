'use strict';

const SERVICES = [
  'Refrigerator repair', 'Refrigerator servicing', 'AC servicing', 'AC installation',
  'Car AC diagnosis', 'Car AC gas refilling', 'Car AC compressor repair',
  'Car AC condenser repair', 'Car AC servicing', 'Other refrigeration enquiry'
];
const STATUSES = ['new', 'contacted', 'qualified', 'referred', 'booked', 'completed', 'cancelled'];
const TRANSITIONS = {
  new: ['contacted', 'cancelled'],
  contacted: ['qualified', 'cancelled'],
  qualified: ['referred', 'cancelled'],
  referred: ['booked', 'cancelled'],
  booked: ['completed', 'cancelled'],
  completed: [],
  cancelled: ['new']
};

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
// Keep newlines in the free-text message but drop other control characters.
const cleanMultiline = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);

// Ghana numbers -> +233XXXXXXXXX. Accepts 0XXXXXXXXX, 233XXXXXXXXX, +233XXXXXXXXX (spaces, dashes, brackets ignored).
function normalizeGhanaPhone(input) {
  let d = String(input || '').replace(/[\s\-().]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  if (!/^\d+$/.test(d)) return null;
  let national;
  if (d.startsWith('233') && d.length === 12) national = d.slice(3);
  else if (d.startsWith('0') && d.length === 10) national = d.slice(1);
  else return null;
  return /^[2-5]\d{8}$/.test(national) ? '+233' + national : null;
}

function validateEnquiry(body) {
  const errors = {};
  const b = body && typeof body === 'object' ? body : {};
  const out = {
    name: clean(b.name, 80), phone_raw: clean(b.phone, 20), area: clean(b.location, 80),
    service: clean(b.service, 60), vehicle: clean(b.vehicle, 80), message: cleanMultiline(b.message, 1500)
  };
  if (out.name.length < 2) errors.name = 'Enter your name.';
  out.phone = normalizeGhanaPhone(out.phone_raw);
  if (!out.phone) errors.phone = 'Enter a valid Ghana phone number, e.g. 024 123 4567 or +233 24 123 4567.';
  if (out.area.length < 2) errors.location = 'Enter your area.';
  if (!SERVICES.includes(out.service)) errors.service = 'Choose a service from the list.';
  if (b.consent !== true) errors.consent = 'Please tick the consent box to continue.';
  return { ok: Object.keys(errors).length === 0, errors, value: out };
}

// Money in integer pesewas (1 GHS = 100 pesewas) so commission maths never uses floating point.
function parseGhs(input) {
  if (input === null || input === undefined || input === '') return null;
  const s = String(input).trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) return NaN;
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}
// rate in percent (may have up to 2 decimals) -> basis points
const rateToBp = (pct) => Math.round(Number(pct) * 100);
// Round half up, integer arithmetic.
function commissionPesewas(jobValuePesewas, rateBp) {
  if (!Number.isInteger(jobValuePesewas) || !Number.isInteger(rateBp)) return null;
  return Math.floor((jobValuePesewas * rateBp + 5000) / 10000);
}
const canTransition = (from, to) => from === to || (TRANSITIONS[from] || []).includes(to);

module.exports = { SERVICES, STATUSES, TRANSITIONS, clean, cleanMultiline, normalizeGhanaPhone, validateEnquiry, parseGhs, rateToBp, commissionPesewas, canTransition };
