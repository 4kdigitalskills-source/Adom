# Lovable backend implementation prompt — ADOM

Build on the supplied ADOM website. Preserve its approved homepage layout, palette, full-width slider,
transparent hero headline, responsive navigation and visual style. Do not replace it with a generic template.

## Verified business information
ADOM Refrigeration & Air Condition Workshop; Isaac Arthur; CCTU Polytechnic Road, Cape Coast, Ghana.
Phone +233 24 666 3591; alternate +233 27 324 2468; WhatsApp +233 24 666 3591;
email isaacarthur@gmail.com.

## Confirmed services
Refrigerator repair/servicing; refrigeration work; home and commercial AC installation, servicing and
maintenance; automotive AC diagnosis and servicing; car AC gas refilling; compressor and condenser
repairs; enquiries for Mercedes-Benz, BMW and Porsche. Do not invent prices, warranties, opening hours,
response-time promises or guaranteed compatibility.

## Essential lead ownership and referral model
The website operator is an independent SEO/web-design lead partner. Intended workflow:
customer enquiry -> secure private lead inbox -> notify lead partner first -> lead partner qualifies and
refers to ADOM -> record contact, booking, completed job, job value and agreed commission.
The lead partner's private email, phone and commission rate have NOT been provided. Do not invent them.
Build settings fields and block production activation until they are configured and the written referral
arrangement is confirmed. Do not bypass the lead partner by sending new leads directly to ADOM by default.

## Backend
Use Supabase Auth, PostgreSQL and server-side Edge Functions. Use `supabase-schema.sql` as a starter.
- Admin-only authentication; no public admin signup.
- RLS: public visitors cannot read or modify lead records.
- Public submissions go through server-side validation, rate limiting and spam prevention.
- Never expose service-role keys, SMTP secrets or private lead-partner details in browser code.
- Store consent timestamp, privacy notice version, source page and created timestamp.
- Ghana phone normalization, audit trail, authorized CSV export and deletion.
- Create protected admin dashboard for statuses new/contacted/qualified/referred/booked/completed/cancelled.
- Search/filter by date, service, status and vehicle.
- Track referred destination, referral date, job value, commission rate and calculated commission in GHS.
- Commission must use an agreed configured rate; do not assume a percentage.
- Notify the configured lead partner first; optional WhatsApp follow-up after successful database save.
- Do not say an enquiry was sent unless the server confirms storage and the user actually sends any WhatsApp message.

## Form
Name, phone, area, service, vehicle make/model (optional), issue description and required consent.
After successful secure save, show a reference number and confirmation. Send notification to the lead
partner first. Add optional WhatsApp follow-up. Add honeypot and rate limit or CAPTCHA if needed.

## SEO, accessibility and privacy
Preserve semantic HTML; unique title/meta description, canonical final domain, Open Graph, verified
HVACBusiness/LocalBusiness JSON-LD, sitemap, robots, descriptive alt text, lazy loading, responsive
performance, keyboard navigation and reduced-motion support. Do not add fake reviews, ratings, awards,
business age, opening hours or guarantees. Update privacy notice to match actual providers, data flow,
retention, access and user rights. Get business owner approval before launch.

## Deliverables
Working responsive website, secure enquiry backend, protected lead/referral dashboard, lead-partner email
notifications, optional WhatsApp action, setup guide, environment variable list and tests for RLS,
unauthorized access, form validation, status transitions and commission math. Clearly list missing setup
details (domain, lead-partner email/phone, written referral terms, SMTP and admin account). Do not claim
production-ready until end-to-end tests pass.
