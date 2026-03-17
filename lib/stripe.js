/**
 * lib/stripe.js
 * ---------------------------------------------------------------------------
 * Stripe SDK singleton + helper utilities for Stripe Connect.
 * Lazy-initialized so the build phase never throws on a missing key.
 * ---------------------------------------------------------------------------
 */

import Stripe from 'stripe';

// ─── Lazy singleton ───────────────────────────────────────────────────────────

let _stripe = null;

function getStripe() {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
      apiVersion: '2024-06-20',
    });
  }
  return _stripe;
}

// ─── Connect OAuth ────────────────────────────────────────────────────────────

export function buildStripeConnectOAuthUrl(state, email) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.STRIPE_CLIENT_ID,
    scope:         'read_write',
    redirect_uri:  process.env.STRIPE_CONNECT_REDIRECT_URI,
    state,
    ...(email ? { 'stripe_user[email]': email } : {}),
  });
  return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
}

export async function exchangeStripeCode(code) {
  return getStripe().oauth.token({ grant_type: 'authorization_code', code });
}

export async function deauthorizeStripeAccount(stripeAccountId) {
  await getStripe().oauth.deauthorize({
    client_id:       process.env.STRIPE_CLIENT_ID,
    stripe_user_id:  stripeAccountId,
  });
}

// ─── Payment Intents ──────────────────────────────────────────────────────────

export async function createPaymentIntent({
  amount,
  currency,
  stripeAccountId,
  applicationFeeAmount,
  metadata = {},
}) {
  return getStripe().paymentIntents.create(
    {
      amount,
      currency,
      automatic_payment_methods: { enabled: true },
      application_fee_amount: applicationFeeAmount,
      metadata,
    },
    { stripeAccount: stripeAccountId }
  );
}

export async function getPaymentIntent(paymentIntentId, stripeAccountId) {
  return getStripe().paymentIntents.retrieve(paymentIntentId, {
    stripeAccount: stripeAccountId,
  });
}

/** Retrieve a PaymentIntent with its latest charge expanded to access billing_details. */
export async function getPaymentIntentWithCharge(paymentIntentId, stripeAccountId) {
  return getStripe().paymentIntents.retrieve(
    paymentIntentId,
    { expand: ['latest_charge'] },
    { stripeAccount: stripeAccountId }
  );
}

export async function createRefund({ paymentIntentId, stripeAccountId, amount, reason }) {
  return getStripe().refunds.create(
    {
      payment_intent: paymentIntentId,
      ...(amount ? { amount } : {}),
      ...(reason ? { reason } : {}),
    },
    { stripeAccount: stripeAccountId }
  );
}

export async function createAccountLink(stripeAccountId, returnUrl, refreshUrl) {
  return getStripe().accountLinks.create({
    account:      stripeAccountId,
    return_url:   returnUrl,
    refresh_url:  refreshUrl,
    type:         'account_onboarding',
  });
}

export async function getConnectedAccount(stripeAccountId) {
  return getStripe().accounts.retrieve(stripeAccountId);
}

// ─── Products & Prices ────────────────────────────────────────────────────────

export async function createProduct({ stripeAccountId, name, description, images }) {
  return getStripe().products.create(
    {
      name,
      ...(description ? { description } : {}),
      ...(images?.length ? { images } : {}),
    },
    { stripeAccount: stripeAccountId }
  );
}

export async function updateProduct(stripeAccountId, productId, { name, description, active }) {
  return getStripe().products.update(
    productId,
    {
      ...(name !== undefined        ? { name }        : {}),
      ...(description !== undefined ? { description } : {}),
      ...(active !== undefined      ? { active }      : {}),
    },
    { stripeAccount: stripeAccountId }
  );
}

export async function listProducts(stripeAccountId, { limit = 20, startingAfter } = {}) {
  return getStripe().products.list(
    {
      limit,
      active: true,
      expand: ['data.default_price'],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    },
    { stripeAccount: stripeAccountId }
  );
}

export async function createPrice({ stripeAccountId, productId, amount, currency, recurring }) {
  return getStripe().prices.create(
    {
      product:    productId,
      unit_amount: amount,
      currency,
      ...(recurring
        ? { recurring: { interval: recurring.interval, interval_count: recurring.intervalCount ?? 1 } }
        : {}),
    },
    { stripeAccount: stripeAccountId }
  );
}

export async function listPrices(stripeAccountId, productId) {
  return getStripe().prices.list(
    { product: productId, active: true, limit: 10 },
    { stripeAccount: stripeAccountId }
  );
}

// ─── Webhook Verification ─────────────────────────────────────────────────────

export function constructWebhookEvent(rawBody, signature) {
  return getStripe().webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}
