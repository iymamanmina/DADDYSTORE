# DADDYS STORE — Netlify + Supabase deployment package

This package keeps the existing DADDYS STORE storefront UI and replaces the original local FastAPI/SQLite backend with a Netlify Node.js Function backed by Supabase Postgres and Supabase Storage.

## What's included

- Existing storefront pages, styles, images and browser-side cart/wishlist/compare behavior under `static/`.
- A single Netlify Function at `netlify/functions/api.mjs` implementing the existing `/api/...` contract.
- Supabase Postgres schema and atomic checkout RPC in `supabase/migrations/202611050001_initial_schema.sql`.
- Supabase Storage buckets: public product/store media and private seller-proof uploads.
- PBKDF2 admin password hashing, signed HttpOnly/Secure/SameSite cookies, database-backed request throttling, origin/custom-header checks, audit logging, server-side price calculation and atomic account reservation.
- Environment template and admin bootstrap script.

## Required external setup

This is a deployment-prepared source package, not a live deployed site. No Supabase credentials, Netlify site, GitHub repository target or public Netlify URL have been written into it.

### 1. Create/configure Supabase

1. Create or select your Supabase project.
2. Open **SQL Editor** and run the complete migration file `supabase/migrations/202611050001_initial_schema.sql`.
3. In **Project Settings → Database → Connect**, copy the **Transaction pooler** connection string (port `6543` on the standard shared pooler). Put it in `DATABASE_URL`. Do not use a direct database connection for this serverless deployment.
4. In **Project Settings → API**, copy the Project URL into `SUPABASE_URL` and the `service_role` key into `SUPABASE_SERVICE_ROLE_KEY`. The service-role key is a server secret. Never put it into `static/`, client-side JavaScript, a public repository, or chat.

The migration creates two Storage buckets. `daddys-store-media` is public for storefront images/video; `daddys-seller-proof` is private and is shown to authenticated admins through one-hour signed URLs. On admin approval, seller proof images are copied to public media and attached to the draft listing. Do not upload passwords, OTPs, recovery codes, government IDs or unrelated personal documents.

### 2. Create the first admin

On a trusted local computer:

```bash
cp .env.example .env
# Edit .env and set DATABASE_URL and ADMIN_USERNAME.
npm install
npm run admin:create
```

The script asks for a password with terminal input hidden and stores only a PBKDF2 hash in `public.admins`. Choose a unique password of at least 14 characters. Keep `.env` out of Git; `.gitignore` already excludes it.

### 3. Deploy to Netlify

1. Push this project folder to a GitHub repository you control. Commit the source files, but never `.env`, database passwords, or service-role keys.
2. In Netlify choose **Add new site → Import an existing project**, connect GitHub, and select that repository.
3. Netlify should read `netlify.toml`. The build command is `npm install --no-audit --no-fund`, publish directory is `static`, and functions directory is `netlify/functions`.
4. In **Site configuration → Environment variables**, add the variables below. Set `PUBLIC_BASE_URL` to the exact free Netlify URL after the first site is created, then redeploy.
5. Publish using the assigned `https://YOUR-SITE.netlify.app` address. No paid custom domain is required.

Required Netlify environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase Transaction pooler connection string |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (secret) |
| `APP_SECRET` | At least 32 random characters; generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `PUBLIC_BASE_URL` | Full Netlify HTTPS URL, e.g. `https://your-site.netlify.app` |
| `RESEND_API_KEY` | Optional API email provider key (when using Resend) |
| `EMAIL_FROM` | Sender identity verified with Resend |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Alternative SMTP mail configuration; use an app password where required |

Email delivery must be configured with either Resend (`RESEND_API_KEY` + `EMAIL_FROM`) or SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`). With SMTP you can use a mail provider account and its app-specific password where required; never use an ordinary account password. Customer verification, password resets and price-drop messages will not be delivered until one mail route is configured. Keep development token echo disabled; this package deliberately does not expose verification tokens to public clients.

### 4. Initial verification

After the first deploy:

- Open `/api/health`; expect `{"status":"ok","service":"DADDYS STORE",...}`.
- Open `/api/public/config`; expect default store settings with blank merchant/contact fields.
- Open `/#admin` and sign in using the username and password created above.
- Set the store WhatsApp/Telegram contacts, UPI ID, payee name and enabled methods in Admin Settings.
- Add only genuine authorized BGMI account listings, actual UC packages, and real Armory inventory. The initial database starts empty; it does not seed fake products, stock or reviews.
- Test customer registration email, one account order, one UC order, UPI Intent/QR, UTR submission, manual admin reconciliation, seller submission and upload from a second device.

## Payment and marketplace safeguards

UPI Intent/QR does not verify a payment. An order remains unverified until an admin checks the merchant account and marks it verified. WhatsApp and Telegram are contact/order handoff methods, not payment processors. Do not mark an order paid because a buyer returns from their UPI app. Automated payment verification requires a merchant gateway and signed server-side webhooks, which are not configured in this package.

Only list accounts you are authorized to sell/transfer. Do not ask buyers or sellers for passwords, OTPs or recovery credentials. Confirm applicable game-publisher rules, law, consumer/refund obligations and tax requirements before public transactions; do not imply KRAFTON affiliation without authorization.

## Free-plan caveats

Netlify Free currently includes a 300-credit monthly hard limit; sites pause when the team reaches that limit until the next billing cycle. Supabase Free currently includes 500 MB database and 1 GB file storage, and low-activity projects can be paused after seven days. Free hosting is suitable for a controlled launch/test, not a guarantee of uninterrupted commercial availability. Check current provider billing pages before accepting real customer orders.

## Architecture notes

- Runtime: Netlify Node.js Functions (Node 22 target) + `pg` + Supabase Postgres.
- Database: Supabase Postgres transaction pooler; the connection pool is deliberately small for serverless execution.
- Media: Supabase Storage, not Netlify's ephemeral function filesystem.
- No local SQLite database is used in this deployment package.
- The legacy local SQLite database found in the source folder contained only the three default settings rows and zero accounts, catalog items, UC packages, orders, sellers, users or admins; there is no inventory data to import.
- Browser LocalStorage remains limited to convenience features such as cart, recently viewed and visitor-scoped wishlist identity; business data and orders are stored server-side.

## Project files

```text
static/                                  storefront frontend + assets
netlify/functions/api.mjs                serverless API
supabase/migrations/                     database + RPC + storage setup
scripts/create-admin.mjs                 first-admin bootstrap
netlify.toml                              Netlify build, routing and headers
.env.example                              local template; never commit .env
```

## Provisioning status (6 November 2026)

A Supabase project has been created for this store in the Mumbai region and the initial schema migration has been applied.

- Project ref: `ommwtekpolznlccowevn`
- Project API URL: `https://ommwtekpolznlccowevn.supabase.co`
- Dashboard: <https://supabase.com/dashboard/project/ommwtekpolznlccowevn>
- Schema: 15 application tables with RLS enabled, 2 Storage buckets, default store settings, atomic checkout RPC and foreign-key indexes.
- First admin username: `owner` (the initial password is shared separately with the store owner; it is not stored in this archive).
- BGMI account sales remain disabled by default until the store owner confirms appropriate authorization.

The GitHub repository and Netlify site have **not** been created or deployed from this environment. Netlify environment variables still need to be added in the Netlify dashboard. Do not commit `.env` or any database/service-role secret.