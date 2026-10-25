# Expert in Shopify Portfolio — React CMS v1.2

A custom React + Vite portfolio and service checkout website with a Node.js API, SQLite database, admin CMS, Fiverr-style client inbox, and protected project image handling. Preserves the previous Shopify / Wix / Squarespace / Webflow site and existing database schema via additive migrations.

## What's new

- **Admin → Website colors**: six editable CSS theme colors, four presets, live preview, desktop cursor-glow toggle. Color settings are saved in SQLite and loaded on every public page.
- **Admin → Email alerts**: receiving email and toggles for new inquiries, orders, and client messages. Delivery uses the Resend HTTP API with environment-only credentials. Notifications are **not active** until configured.
- **Portfolio project hover previews**: full-page screenshot images scroll vertically on hover/focus if taller than the preview card. Upload screenshots as tall images to see the effect.
- **Mouse effect**: a lightweight, non-blocking decorative halo on desktop; automatically disabled on touchscreens and for reduced-motion preferences.
- **International-facing copy**: dedicated region statement for US/UK/Australia/Canada (editable), worldwide service schema, and clear navigation to packages.
- **SEO**: URL-specific HTTP-served HTML title, description, canonical, Open Graph metadata, robots noindex for private pages, JSON-LD `ProfessionalService`, dynamic `sitemap.xml` and `robots.txt`, text HTML fallback before React boots. Edit title, description and keywords under **Website content**. This improves discovery, but Google rankings/SEO scores are not guaranteed. Site is still a client-rendered SPA; full SSR or route-by-route static generation would further improve crawler coverage.
- **Speed improvements**: cache-busted Vite build support, HTTP gzip for HTML/CSS/JS/SVG static assets, long cache headers for hashed assets, WebP conversion with up to 1600-pixel-width images, lazy decoding for portfolio imagery, CSS-driven hover effects. **Lighthouse scores have not been measured**; measure production pages when deployed.
- **Security**: Content Security Policy with per-request nonce, HTTPS/HSTS when behind TLS, X-Frame-Options, no-sniff, SameSite + HttpOnly session cookies, origin checks, upload rate limits, randomized filenames, input-size/type checks, image raster decoding and WebP re-encoding. Private attachment routes check thread ownership and send `no-store`/download headers. No system can guarantee files are 100% malware-free.
- **Private image attachment endpoint**: image uploads within the Fiverr-style inbox are **disabled by default** and refuse uploads until ClamAV integration is enabled. Only PNG/JPEG/WebP images up to 2MB, decoded and rebuilt as WebP, can be accepted. PDFs, Office documents, SVG, scripts, ZIP and executables are intentionally blocked.

## Requirements

- Node.js **22.13+** and npm
- Persistent disk for `data.sqlite` and images in production
- Optional: verified sending domain and Resend API key for email alerts
- Optional: ClamAV CLI with up-to-date signature database to enable private uploads
- Optional: PayPal Business API credentials for PayPal payments

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

Website http://localhost:5173 · Admin http://localhost:5173/admin · Client register http://localhost:5173/register · Messages http://localhost:5173/account/messages

The first run generates a strong temporary admin password in the backend console unless an `ADMIN_PASSWORD` value (at least 12 characters) is given. **Store it safely.** This variable is only read for first-time admin creation. To change your password later, use **Admin → Security**.

```bash
npm test          # API / messaging / theme / SEO / upload security tests
npm run build     # Vite production static bundle
npm start         # Node API + serves dist (NODE_ENV=production)
```

For a production server, set `NODE_ENV=production`, a final `APP_ORIGIN=https://yourdomain.com`, and `SITE_URL=https://yourdomain.com`. Make sure TLS terminates at your reverse proxy or hosting platform. Point your domain to the service and enforce HTTPS.

## Content management

Visit `/admin`, then use:

| Admin tab | What you can do |
| --- | --- |
| Website content | Edit brand, hero, text, contact, targeted-region line and SEO text |
| Website colors | Edit 6 colors, pick palettes, preview, enable/disable cursor halo |
| Email alerts | Set receiving email and 3 event alerts |
| Services & pricing | Add/edit/remove Shopify, Wix, Squarespace, Webflow gigs |
| Portfolio | Add projects, tall screenshots and website links |
| Partners | Add partner names, logos and links |
| Payments | Enable PayPal (requires server credentials), Payoneer/manual bank |
| Orders / Inquiries | Review customers, verify manual payments, respond |
| Message inbox | Reply to registered clients with instant inbox updates |
| Security | Rotate admin password and invalidate active admin sessions |

Payment notices: **Payoneer/bank transfers require manual verification**, not automatic payment capture. PayPal requires properly configured credentials. Displayed prices use the configured currency; the CMS **does not auto-convert currencies**.

## Email notifications

1. Verify a sending domain with Resend (e.g. `notifications@yourdomain.com`).
2. Put `RESEND_API_KEY` and `MAIL_FROM` in your server's environment variables/secret manager (NOT client-side code or the CMS).
3. Under `/admin` → **Email alerts**, enter the destination email (can be Gmail) and select notification types.
4. Send a test inquiry from another browser to verify receiving mail, including spam folder. Orders and new client messages use the same notification service. Email API failures are logged server-side; the customer request still succeeds.

## Secure file upload policy

**Admin project screenshots/partner logos:** The API accepts only Base64 PNG/JPEG/WebP images up to 2 MB; Sharp decodes the pixels with a 12-million-pixel limit, strips original metadata and rebuilds into WebP, then stores it under a random `.webp` filename. All other formats are rejected. It does not execute source file contents.

**Client message attachments:** Disabled unless `ENABLE_CLIENT_UPLOADS=true` AND `CLAMAV_SCAN=true` and the `clamscan` executable is installed with an updated virus signature database. On each attachment, the unmodified original file is scanned before the cleaned image is stored in a private directory **outside the web root**. Scanner unavailable, timeout or positive result => upload denied. The private attachment URL requires logged-in client membership or an authenticated admin. Never expose `DATA_DIR/private-attachments` using a static file server.

**Important:** No malware scanner detects 100% of threats. Keep ClamAV definitions and the server OS updated, set size quotas, monitor activity, back up data, and consider professional malware scanning/CDR for PDF/Office documents before adding such uploads. This release intentionally disallows those riskier formats.

## Deployment and database options

**You do not need Firebase.** The project already uses a SQLite database (`data.sqlite`) that holds admin settings, services, projects, partners, clients, orders and messages. SQLite is free and needs no separate managed DB account. **But it MUST be kept on persistent disk with regular backups.** Store user-uploaded images on the same backed-up persistent volume. Example on a single small VPS:

```bash
export NODE_ENV=production
export APP_ORIGIN=https://yourdomain.com
export SITE_URL=https://yourdomain.com
export DATA_DIR=/srv/expert-studio/data
export UPLOADS_DIR=/srv/expert-studio/data/uploads
npm ci # npm install if no lockfile
npm run build
npm start
```

Put HTTPS (for example via Caddy or Nginx + Let's Encrypt) in front of Node port `4000`. Use a CDN for image / JS / CSS delivery if desired. A single-server production template is included:

```bash
# On your VPS after uploading and extracting the project folder:
cp .env.example .env
# Edit .env and add DOMAIN=yourdomain.com and ADMIN_PASSWORD=<12+ character random secret>.
# Configure DNS A/AAAA records for yourdomain.com to this VPS before starting.
docker compose -f deploy/compose.yml --env-file .env up -d --build
```

The provided `deploy/compose.yml` starts the Node app behind Caddy (automatic HTTPS) and attaches a persistent Docker volume. Open inbound ports 80/443. Set the correct domain in `.env` and do **not** commit that file. Back up Docker volume `studio_data` frequently. No live deployment was executed as part of creating this project. On a serverless/ephemeral host, do **not** store live customer data only in local SQLite: instances may sleep/redeploy and delete it.

**Hosting comparison:**

- **Single inexpensive Node VPS with a persistent volume (recommended for this exact code)**: one deployment, SQLite and uploads survive restarts, you control backups; not normally free.
- **Render free Node web service**: useful as a preview/test, **not for production with this code's local SQLite**. Its free filesystem is ephemeral and resets on sleep/redeploy; its free database has an expiration limit. A change to an external persistent DB and storage is necessary for serious use.
- **Supabase Free**: provides hosted PostgreSQL + storage + auth, but migrating **this specific SQLite-based server** to Supabase is a **separate development task**, not a switch you can flip. Free projects may pause after inactivity.
- **Firebase Free/Spark**: optional alternative with Firestore/Authentication/Hosting for a **rewritten** implementation, but the current Node/SQLite app cannot simply be uploaded there as a static site and keep its backend. Cloud Functions require the Blaze billing plan (even when usage may be covered by free quotas).
- **Cloudflare D1 / Workers + R2**: possible low-cost/high-global-reach architecture after replacing the current Node backend and local file handling with Cloudflare-specific code.

**Do not publish this ZIP as Netlify-only static files.** Netlify can host a built frontend, but this existing server API, SQLite, messaging, uploads, and admin CMS still need persistent hosting.

## Operations and launch checklist

1. Set strong admin password and the final website domain (`APP_ORIGIN`, `SITE_URL`); connect a TLS certificate and verify HSTS and secure cookies.
2. Upload *actual* tall portfolio screenshots and *authorized* partner logos from the dashboard. Do not claim affiliations that you cannot verify.
3. Set PayPal live credentials only after end-to-end sandbox testing. Confirm bank transfers manually.
4. Set verified email service + notification recipient, and test inquiry/order/message emails.
5. Choose a persistent hosting plan; back up **both** the SQLite database and upload directories. Restore-test backups.
6. Configure Google Search Console, submit `https://yourdomain.com/sitemap.xml`, inspect services/portfolio indexing; measure Core Web Vitals in production.
7. Publish a privacy policy and cookie/international data-transfer disclosures appropriate for your customers; review local tax/payments obligations for the US, UK, AU and CA.
8. Run `npm audit`, keep dependencies patched, and verify the ClamAV definitions are current if enabling client uploads.
9. Conduct an independent penetration/security review before accepting high-value payments or sensitive customer documents. Built-in controls reduce risk but are not a substitute for professional review.

## Code notes

`src/main.jsx` = React frontend, service pages, admin + client portals; `src/styles.css` = styling and configurable palette hooks; `server/index.mjs` = Node REST API, auth, SQLite, attachments and SEO headers; `tests/` = Node HTTP functional tests. The server is a single-instance SQLite design; large multi-node scale will require moving to a managed database and shared object storage.
