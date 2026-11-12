'use strict';
// Usage: npm run admin:hash   (prompts without echo is not available in plain Node; pass via env instead)
//   ADMIN_PASSWORD='long passphrase' npm run admin:hash
const { hashPassword } = require('./auth');
const pw = process.env.ADMIN_PASSWORD;
if (!pw || pw.length < 12) { console.error('Set ADMIN_PASSWORD (min 12 chars) in the environment, then run again.'); process.exit(1); }
console.log(hashPassword(pw));
