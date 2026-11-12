# ADOM website: owner's go-live guide

You never edit code. Every step below is clicking, copying and pasting in a website.
**Never send passwords, API keys or secret keys to anyone (including Claude).** You paste them only into the Render settings page in Step 6.

## Step 0: decisions and details (reply to Claude; no accounts needed yet)
1. **Domain.** Does the business already own a web address (e.g. `adomcooling.com`)? If yes, what is it? If no, say so and Claude will guide you to buy one. It is needed to send lead emails from a professional address.
2. **Lead partner** (the person/company who receives enquiries first): full name, private email address for notifications, phone number.
3. **Commission %** from the written referral arrangement. Say "no written agreement yet" if there isn't one. Nothing goes live until this is confirmed.
4. **Admin email** for the private dashboard (can be the lead partner's).
5. **Budget choices** (details in "Costs" below): hosting always-on or free-with-sleep; database Free or Pro.

## Costs (verified when this guide was written; confirm on each site before paying)
| Service | Free | Paid |
|---|---|---|
| Supabase (database) | Free, but it **pauses after a week of inactivity and has no backups** | Pro from $25/month: no pausing, daily backups |
| Render (hosting) | Free, but the site **sleeps after 15 minutes idle** (slow first visit) | Starter: always on (price shown before you confirm) |
| Resend (email) | 3,000 emails/month, 100/day | Pro $20/month |
| Domain name | none | yearly fee at the registrar |
Recommendation for real customer data: Supabase Pro + Render Starter. Resend free is enough.

## Step 1: GitHub (holds the website files; Render reads from here)
1. Create an account: https://github.com/signup
2. Create a **private** repository: https://github.com/new  Name: `adom-website`. Choose **Private**. Click **Create repository**.
3. On the next page click **uploading an existing file**.
4. On your computer unzip `adom-website.zip`. Open the `adom-website` folder, select **everything inside it** (not the folder itself) and drag it into the GitHub page. Wait for the upload to finish.
5. Check you can see `render.yaml`, `package.json`, `server`, `public` listed at the top level. Click **Commit changes**.

## Step 2: Supabase (database)
1. Create an account: https://supabase.com/dashboard/sign-up
2. Click **New project**. Name `adom`. Create and **save the database password** in your password manager. Pick the region nearest to Ghana that is offered (Claude can advise). Wait until the project is ready.
3. In the left menu open **SQL Editor** → **New query**.
4. Open `supabase/schema.sql` from the unzipped folder, copy **all** of it, paste it in, click **Run**. It should say "Success".
5. Open **Project Settings → API** (or **API Keys**). Keep this tab open; you need two values in Step 6:
   * **Project URL** (looks like `https://abcd1234.supabase.co`) → becomes `SUPABASE_URL`
   * The **service_role** secret key → becomes `SUPABASE_SERVICE_ROLE_KEY`. Treat like a bank PIN. Never use the "anon/public" key.

## Step 3: Resend (email)
1. Create an account: https://resend.com/signup
2. **Domains → Add Domain**, enter your domain. Resend shows DNS records. Add them at the company where you bought the domain (Claude will guide you through that site once you tell it which one). Click **Verify**; it can take minutes to hours.
3. **API Keys → Create API Key**, permission "Sending access". Copy it once → `RESEND_API_KEY`.
4. Sender address: choose something like `ADOM Leads <leads@yourdomain>` → `MAIL_FROM`.
*Interim option if the domain is not ready:* register Resend with the lead partner's own email; Resend then lets you send test messages only to that address, from `onboarding@resend.dev`. Do not go live this way.

## Step 4: Render (hosting)
1. Create an account with your GitHub login: https://dashboard.render.com/register
2. **New → Blueprint**, choose the `adom-website` repository, continue. Render reads `render.yaml`, shows the service and asks for the secret values.

## Step 5: What to paste where (Render shows these fields)
| Field | Value |
|---|---|
| SITE_URL | `https://your-domain` (or the temporary `https://adom-website.onrender.com`) |
| SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY | from Step 2 |
| RESEND_API_KEY / MAIL_FROM | from Step 3 |
| LEAD_PARTNER_NAME / _EMAIL / _PHONE | from Step 0 |
| COMMISSION_RATE_PERCENT | e.g. `10` (only the agreed figure) |
| REFERRAL_AGREEMENT_CONFIRMED | `true` only if the written agreement exists |
| ADMIN_EMAIL | from Step 0 |
| ADMIN_PASSWORD | a long passphrase (14+ characters) that only you know |
`SESSION_SECRET` is generated automatically. Click **Apply / Create**. Wait for "Live".

## Step 6: Connect your domain
In Render: your service → **Settings → Custom Domains → Add**. Render shows DNS records; add them at your domain registrar. Then change `SITE_URL` to your https address and redeploy.

## Step 7: Acceptance test (about 10 minutes)
1. Open `https://your-domain/healthz` → shows `{"ok":true}`.
2. Open `https://your-domain/admin`, sign in. The banner at the top should read "System check passed". If it lists problems, tell Claude exactly what it says.
3. Click **Send test email to lead partner**. The lead partner confirms it arrived (also check spam).
4. On the website, submit a test enquiry with a **test name** and your own phone. You should see a reference like `ADOM-261111-ABCDE`.
5. It appears in the dashboard and the lead partner gets an email.
6. In the dashboard delete the test enquiry.
7. Optional but recommended: click **Set up two-step sign-in** in the dashboard, type the key into an authenticator app (Google Authenticator, Authy, etc.), then in Render open your service > **Environment** > add a variable named `ADMIN_TOTP_SECRET` with the same key and save. From then on sign-in asks for the 6-digit code.

## Step 8: After launch
* Google Search Console (https://search.google.com/search-console): add your site, submit `https://your-domain/sitemap.xml`.
* Google Business Profile: https://business.google.com (the business owner must verify it).
* Have a Ghanaian adviser confirm the privacy policy and whether the business/partner must register with the Data Protection Commission.
* Replace the illustrative photographs with real ADOM work photos when available (send them to Claude).
