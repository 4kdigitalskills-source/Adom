# ADOM Refrigeration & Air Condition Workshop: website

Responsive website (your original design, unchanged) plus a secure enquiry backend and private lead/referral dashboard.

```
public/     site: index.html, privacy-policy.html, 404.html, css/styles.css (original CSS + small additions), js/, assets/ (all 11 original images, byte-identical), robots.txt, sitemap.xml
server/     Node HTTP server, validation, auth, rate limiting, storage adapter (SQLite)
admin/      private dashboard (sign-in required; code is served only to signed-in admins)
supabase/   schema.sql with RLS for the future Supabase move
tests/      34 tests incl. fake Supabase + fake Resend end-to-end
docs/       SETUP.md, ENV-CHECKLIST.txt
```
Go live: follow `docs/OWNER-GUIDE.md`. Developers: `docs/SETUP.md`. `render.yaml` deploys to Render; `supabase/schema.sql` creates the database. Business details used are only those you supplied; no prices, reviews, hours or guarantees were added.
