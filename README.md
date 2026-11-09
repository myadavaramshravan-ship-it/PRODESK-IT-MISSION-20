# Nexus Corporate Billing

A small full-stack invoice application with an Express API, a browser dashboard, Stripe Checkout, and emailed PDF receipts.

## Requirements

- Node.js 20+
- A Stripe account and Stripe CLI for local webhook forwarding
- SMTP credentials for receipt delivery
- For Vercel deployment, a MongoDB Atlas cluster and connection string

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and set a random `JWT_SECRET` of at least 32 characters, Stripe test keys, SMTP credentials, and (for MongoDB) `MONGODB_URI` and `MONGODB_DATABASE`.
3. Start the app with `npm start`; open `http://localhost:3000`.
4. Forward Stripe test events to the raw-body webhook endpoint:

   ```sh
   stripe listen --forward-to localhost:3000/api/webhooks/stripe
   ```

   Put the CLI's `whsec_...` value in `STRIPE_WEBHOOK_SECRET` and restart the app.

## Security and payment flow

- Registration and login issue short-lived, HS256 bearer tokens. Passwords are bcrypt-hashed.
- Every invoice route and `/api/me` requires a valid JWT. Invoice lookups, checkout, and receipt downloads are scoped to the authenticated user's ID; a foreign invoice ID returns `403`.
- `/api/auth/register` and `/api/auth/login` are the credential-establishment endpoints. `/api/webhooks/stripe` is intentionally public but accepts only a Stripe signature verified with `stripe.webhooks.constructEvent` against the unparsed request body.
- Clients cannot set invoice status. A paid status is set only after a verified `checkout.session.completed` or `checkout.session.async_payment_succeeded` event reports `payment_status: paid` and matches the stored Checkout Session, invoice, and account.
- Verified payments trigger a generated PDF receipt saved under `RECEIPTS_PATH` and emailed to the account's registered email address. Receipt files are not served as static files; downloads use an authenticated, ownership-checked route.
- Webhook processing is idempotent by Stripe event ID. If receipt delivery fails, the webhook returns an error so Stripe can retry it.

SQLite data is stored at `DATABASE_PATH` (default `./data/nexus.sqlite`). Generated PDFs are stored at `RECEIPTS_PATH` (default `./receipts`). Both directories are ignored by Git.

Run focused API tests with `npm test`.

## Deploy to Vercel with MongoDB Atlas

1. Create a MongoDB Atlas cluster and database user. In Atlas Network Access, allow connections from your deployment environment (for a quick setup, use `0.0.0.0/0` with a strong database password).
2. Push this project to a Git provider and import it into Vercel. Vercel uses `api/[...path].js` as the serverless API entrypoint and serves the frontend from `public/`.
3. Add these environment variables in the Vercel project settings for Production (and Preview if needed): `MONGODB_URI`, `MONGODB_DATABASE`, `JWT_SECRET` (at least 32 random characters), `APP_URL` (your HTTPS deployment URL), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`.
4. Deploy the project. In Stripe Dashboard, create a webhook endpoint at `https://<your-domain>/api/webhooks/stripe` and subscribe to `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Copy the endpoint's signing secret into `STRIPE_WEBHOOK_SECRET` in Vercel and redeploy.
5. Test registration, invoice creation, Checkout, and receipt delivery using Stripe test credentials before switching to live keys.

On Vercel, MongoDB Atlas is used instead of SQLite because serverless local files are not durable. Receipt PDFs are stored in MongoDB with their invoices, so they remain available from the authenticated receipt-download route after a function instance is recycled. Never commit `.env` or paste database, Stripe, JWT, or SMTP secrets into source code.
