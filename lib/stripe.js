/**
 * lib/stripe.js
 * ---------------------------------------------------------------------------
 * Stripe SDK singleton + helper utilities for Stripe Connect.
 * ---------------------------------------------------------------------------
 */

import Stripe from 'stripe';

/** Platform-level Stripe client (uses your platform secret key). */
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// ─── Connect OAuth ────────────────────────────────────────────────────────────

/**
 * Build the Stripe Connect OAuth URL to onboard a merchant.
 * @param {string} state  – CSRF state token (store in session before redirect)
 * @param {string} [email] – Pre-fill merchant email
 * @returns {string} OAuth URL
 */
export function buildStripeConnectOAuthUrl(state, email) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.STRIPE_CLIENT_ID,
    scope: 'read_write',
    redirect_uri: process.env.STRIPE_CONNECT_REDIRECT_URI,
    state,
    ...(email ? { 'stripe_user[email]': email } : {}),
  });
  return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
}

/**
 * Exchange an OAuth authorization code for a connected account's tokens.
 * @param {string} code
 * @returns {Promise<Stripe.OAuthToken>}
 */
export async function exchangeStripeCode(code) {
  return stripe.oauth.token({ grant_type: 'authorization_code', code });
}

/**
 * Deauthorize (disconnect) a Stripe Connect account from the platform.
 * @param {string} stripeAccountId
 */
export async function deauthorizeStripeAccount(stripeAccountId) {
  await stripe.oauth.deauthorize({
    client_id: process.env.STRIPE_CLIENT_ID,
    stripe_user_id: stripeAccountId,
  });
}

// ─── Payment Intents ──────────────────────────────────────────────────────────

/**
 * Create a PaymentIntent on behalf of a connected account.
 * @param {object} params
 * @param {number}  params.amount          – Amount in smallest currency unit (cents)
 * @param {string}  params.currency        – ISO currency code e.g. 'usd'
 * @param {string}  params.stripeAccountId – Connected account ID
 * @param {number}  [params.applicationFeeAmount] – Platform fee in cents
 * @param {object}  [params.metadata]      – Key/value metadata
 * @returns {Promise<Stripe.PaymentIntent>}
 */
export async function createPaymentIntent({
  amount,
  currency,
  stripeAccountId,
  applicationFeeAmount,
  metadata = {},
}) {
  return stripe.paymentIntents.create(
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

/**
 * Retrieve a PaymentIntent from a connected account.
 * @param {string} paymentIntentId
 * @param {string} stripeAccountId
 */
export async function getPaymentIntent(paymentIntentId, stripeAccountId) {
  return stripe.paymentIntents.retrieve(paymentIntentId, {
    stripeAccount: stripeAccountId,
  });
}

/**
 * Create a Refund on behalf of a connected account.
 * @param {object} params
 * @param {string} params.paymentIntentId
 * @param {string} params.stripeAccountId
 * @param {number} [params.amount]  – Partial refund amount in cents; omit for full
 * @param {string} [params.reason]  – 'duplicate' | 'fraudulent' | 'requested_by_customer'
 */
export async function createRefund({ paymentIntentId, stripeAccountId, amount, reason }) {
  return stripe.refunds.create(
    {
      payment_intent: paymentIntentId,
      ...(amount ? { amount } : {}),
      ...(reason ? { reason } : {}),
    },
    { stripeAccount: stripeAccountId }
  );
}

/**
 * Create an Account Link for hosted onboarding (returns / refresh URLs).
 * @param {string} stripeAccountId
 * @param {string} returnUrl
 * @param {string} refreshUrl
 */
export async function createAccountLink(stripeAccountId, returnUrl, refreshUrl) {
  return stripe.accountLinks.create({
    account: stripeAccountId,
    return_url: returnUrl,
    refresh_url: refreshUrl,
    type: 'account_onboarding',
  });
}

/**
 * Retrieve a connected account's details.
 * @param {string} stripeAccountId
 */
export async function getConnectedAccount(stripeAccountId) {
  return stripe.accounts.retrieve(stripeAccountId);
}

// ─── Webhook Verification ─────────────────────────────────────────────────────

/**
 * Verify and construct a Stripe webhook event.
 * @param {Buffer|string} rawBody
 * @param {string} signature  – Value of stripe-signature header
 * @returns {Stripe.Event}
 */
export function constructWebhookEvent(rawBody, signature) {
  return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}
