# GHL Custom Payment Provider — Stripe Connect

A standalone Next.js app that registers as a **custom payment provider** in the GoHighLevel Marketplace, powered by **Stripe Connect** (Express accounts).

---

## Architecture

```
GHL Checkout → POST /api/webhooks/ghl (PAYMENT_PROVIDER_CHARGE)
                    ↓
            Create Stripe PaymentIntent
            (on connected merchant account)
                    ↓
            Return { clientSecret, publishableKey }
                    ↓
GHL renders Stripe Elements (or redirect to /checkout)
                    ↓
Customer pays → Stripe webhook fires
                    ↓
POST /api/webhooks/stripe (payment_intent.succeeded)
                    ↓
POST to GHL Payment Events API → GHL marks order as paid
```

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.local.example .env.local
# Edit .env.local with your credentials
```

### 3. Run dev server
```bash
npm run dev
```

---

## Environment Variables

| Variable | Where to find |
|---|---|
| `GHL_CLIENT_ID` | GHL Marketplace → Your App → App Details |
| `GHL_CLIENT_SECRET` | GHL Marketplace → Your App → App Details |
| `GHL_REDIRECT_URI` | Set to `https://yourdomain.com/api/auth/ghl/callback` |
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API Keys |
| `STRIPE_PUBLISHABLE_KEY` | Stripe Dashboard → Developers → API Keys |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Webhooks → Signing secret |
| `STRIPE_CLIENT_ID` | Stripe Dashboard → Connect → Settings |
| `STRIPE_CONNECT_REDIRECT_URI` | Set to `https://yourdomain.com/api/auth/stripe/callback` |
| `NEXTAUTH_SECRET` | Generate: `openssl rand -base64 32` |
| `APP_URL` | Your production URL e.g. `https://yourdomain.com` |

---

## GHL Marketplace Setup

1. Go to **GHL Marketplace → Create App**
2. Set **Redirect URI**: `https://yourdomain.com/api/auth/ghl/callback`
3. Enable scopes: `payments.readonly`, `payments.write`, `locations.readonly`
4. Set **Webhook URL**: `https://yourdomain.com/api/webhooks/ghl`
5. Register as **Payment Provider** in your app settings

---

## Stripe Dashboard Setup

1. **Connect Settings** → Enable OAuth → Set redirect URI
2. **Webhooks** → Add endpoint `https://yourdomain.com/api/webhooks/stripe`
3. Select events:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `charge.refunded`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `account.updated`

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/auth/ghl` | Start GHL OAuth |
| `GET` | `/api/auth/ghl/callback` | GHL OAuth callback |
| `GET` | `/api/auth/stripe?locationId=` | Start Stripe Connect |
| `GET` | `/api/auth/stripe/callback` | Stripe OAuth callback |
| `POST` | `/api/auth/stripe/disconnect` | Disconnect Stripe account |
| `POST` | `/api/payments/create-intent` | Create PaymentIntent |
| `GET` | `/api/payments/status` | Get PaymentIntent status |
| `POST` | `/api/payments/refund` | Issue refund |
| `GET` | `/api/connect/account?locationId=` | Get Stripe account status |
| `POST` | `/api/connect/onboard` | Generate Stripe onboarding link |
| `POST` | `/api/webhooks/stripe` | Stripe webhook receiver |
| `POST` | `/api/webhooks/ghl` | GHL webhook receiver |
| `GET` | `/api/locations` | List connected locations |

---

## Pages

| URL | Description |
|---|---|
| `/dashboard?locationId=xxx` | Admin dashboard — connect GHL + Stripe |
| `/checkout?locationId=xxx&entityId=yyy&amount=9900&currency=usd` | Customer checkout page |

---

## Production Notes

- Replace `lib/tokenStore.js` (file-based) with **PostgreSQL / Redis** for production
- Deploy on **Vercel**, **Railway**, or any Node.js host
- Use **Stripe CLI** (`stripe listen --forward-to localhost:3000/api/webhooks/stripe`) for local webhook testing
- Set `NEXTAUTH_SECRET` to a strong random value — never commit it
