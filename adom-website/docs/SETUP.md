# Technical runbook (for developers/support)

Node >= 22.13, zero npm dependencies. `npm test` runs 34 tests. `npm run dev` runs locally with SQLite (`ENQUIRY_DEV_MODE=true` to accept test enquiries before the partner is configured).

## Architecture
`public/` static site -> `server/app.js` (HTTP, validation, rate limits, CSP, admin API) -> `server/store/{sqlite,supabase}.js` (same async interface; Supabase chosen automatically when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set) -> `server/notifier.js` + `server/mailer.js` (outbox worker, Resend over HTTPS).

## Production gate
When `NODE_ENV=production`, `POST /api/enquiries` returns 503 (nothing stored) until: Supabase, Resend + `MAIL_FROM`, https `SITE_URL`, lead partner name/email/phone, `COMMISSION_RATE_PERCENT`, `REFERRAL_AGREEMENT_CONFIRMED=true` are all valid. The dashboard banner lists what is missing.

## Data flow
Form -> validate -> `rpc/create_enquiry` (enquiry + outbox row + audit in one transaction) -> response with reference -> `notifier.kick()` -> Resend to the lead partner (Idempotency-Key `adom-notification-<id>`). Failures retry (1m, 2m, 4m... capped 1h, 6 attempts; 4xx other than 408/429 fail immediately) and show in the dashboard. ADOM is never emailed directly.

## Security controls
RLS on, no policies, anon/authenticated revoked; service-role key server-side only; CSP/HSTS/frame/nosniff headers; strict validation + honeypot + fill-time + per-IP rate limit (in memory, single instance) + duplicate suppression; scrypt admin password, signed HttpOnly SameSite=Strict cookie, login rate limit, optional TOTP, origin check on state changes, audit log; formula-safe CSV; no personal data in logs; errors never echo database responses.

## Testing limits (be aware)
No network/Postgres was available during development. The SQL in `supabase/schema.sql` has NOT been executed against a real Postgres; the Supabase adapter and Resend client are tested against in-process fakes that mimic their HTTP APIs. The acceptance test in OWNER-GUIDE.md Step 7 is the real end-to-end verification and must be run on the live deployment. `/readyz` and the dashboard system check report database reachability.

## Known gaps / future
CAPTCHA (Cloudflare Turnstile) if spam appears; shared rate-limit store if scaled beyond one instance; self-hosted fonts; WhatsApp notifications; backups depend on the Supabase plan (Free has none: use CSV export or upgrade).
