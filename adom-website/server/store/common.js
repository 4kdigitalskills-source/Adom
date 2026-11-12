'use strict';
const crypto = require('node:crypto');
const REF_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// ADOM-YYMMDD-XXXXX (no look-alike characters). Not a secret; only an identifier customers can quote.
function newReference(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  let s = ''; for (const b of crypto.randomBytes(5)) s += REF_CHARS[b % REF_CHARS.length];
  return `ADOM-${String(d.getUTCFullYear()).slice(2)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${s}`;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
module.exports = { newReference, UUID_RE };
