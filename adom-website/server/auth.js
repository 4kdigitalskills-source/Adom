'use strict';
const crypto = require('node:crypto');

// scrypt$N$r$p$saltB64$hashB64
function hashPassword(pw) {
  const salt = crypto.randomBytes(16), N = 16384, r = 8, p = 1;
  const h = crypto.scryptSync(pw, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [, N, r, p, salt, hash] = stored.split('$');
    const expected = Buffer.from(hash, 'base64');
    const actual = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
const b64u = (b) => Buffer.from(b).toString('base64url');
function sign(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
}
function verify(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  let given; try { given = Buffer.from(mac, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
const SESSION_MS = 8 * 60 * 60 * 1000;
function parseCookies(h) {
  const o = {}; (h || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return o;
}
module.exports = { hashPassword, verifyPassword, sign, verify, parseCookies, SESSION_MS };

// ---- Optional two-step sign-in (TOTP, RFC 6238; compatible with Google Authenticator, Authy, 1Password, etc.) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; }
function base32Decode(str) { let bits = ''; for (const c of str.replace(/=+$/, '')) { const i = B32.indexOf(c); if (i < 0) return null; bits += i.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
function totpAt(secretB32, timeMs) {
  const key = base32Decode(secretB32); if (!key || !key.length) return null;
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30000)));
  const h = crypto.createHmac('sha1', key).update(counter).digest(); const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, '0');
}
function verifyTotp(secretB32, code, timeMs = Date.now()) {
  if (!/^\d{6}$/.test(String(code || '').trim())) return false;
  let ok = false;
  for (const step of [-1, 0, 1]) { const exp = totpAt(secretB32, timeMs + step * 30000); if (exp && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(String(code).trim()))) ok = true; }
  return ok;
}
const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
module.exports.base32Encode = base32Encode; module.exports.totpAt = totpAt; module.exports.verifyTotp = verifyTotp; module.exports.newTotpSecret = newTotpSecret;
