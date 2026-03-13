/**
 * lib/ghl.js
 * ---------------------------------------------------------------------------
 * GoHighLevel API v2 helpers.
 * Handles OAuth token exchange / refresh and payment-provider related calls.
 * ---------------------------------------------------------------------------
 */

import axios from 'axios';
import { saveGHLTokens, getGHLTokens } from './tokenStore.js';

const GHL_API_BASE   = process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com';
const GHL_AUTH_BASE  = 'https://marketplace.gohighlevel.com/oauth';   // authorization redirect
const GHL_TOKEN_BASE = 'https://services.leadconnectorhq.com/oauth';  // token exchange / refresh

// ─── OAuth ────────────────────────────────────────────────────────────────────

/**
 * Build the GHL OAuth authorization URL.
 * @param {string} state – CSRF state token
 * @returns {string}
 */
export function buildGHLOAuthUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: process.env.GHL_REDIRECT_URI,
    client_id: process.env.GHL_CLIENT_ID,
    scope: [
      'payments/integration.write',
      'payments/integration.readonly',
      'payments/custom-provider.write',
      'payments/custom-provider.readonly',
      'payments/orders.write',
      'payments/orders.readonly',
      'payments/orders.collectPayment',
      'payments/transactions.readonly',
      'payments/subscriptions.readonly',
    ].join(' '),
    state,
  });
  return `${GHL_AUTH_BASE}/chooselocation?${params.toString()}`;
}

/**
 * Exchange an authorization code for GHL access/refresh tokens.
 * @param {string} code
 * @returns {Promise<object>} Token response
 */
export async function exchangeGHLCode(code) {
  const params = new URLSearchParams({
    client_id: process.env.GHL_CLIENT_ID,
    client_secret: process.env.GHL_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.GHL_REDIRECT_URI,
    user_type: 'Location',
  });

  const { data } = await axios.post(`${GHL_TOKEN_BASE}/token`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return data;
}

/**
 * Refresh an expired GHL access token.
 * @param {string} locationId
 * @returns {Promise<object>} New token data
 */
export async function refreshGHLToken(locationId) {
  const stored = await getGHLTokens(locationId);
  if (!stored) throw new Error(`No tokens stored for location: ${locationId}`);

  const params = new URLSearchParams({
    client_id: process.env.GHL_CLIENT_ID,
    client_secret: process.env.GHL_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: stored.refresh_token,
    user_type: 'Location',
  });

  const { data } = await axios.post(`${GHL_TOKEN_BASE}/token`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const updated = {
    ...stored,
    access_token: data.access_token,
    refresh_token: data.refresh_token || stored.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  await saveGHLTokens(locationId, updated);
  return updated;
}

// ─── Authenticated API Client ─────────────────────────────────────────────────

/**
 * Get a valid (auto-refreshed) access token for a location.
 * @param {string} locationId
 * @returns {Promise<string>} access_token
 */
export async function getValidAccessToken(locationId) {
  let tokens = await getGHLTokens(locationId);
  if (!tokens) throw new Error(`Location ${locationId} not connected.`);

  // Refresh if expiring within 5 minutes
  if (tokens.expires_at < Date.now() + 5 * 60 * 1000) {
    tokens = await refreshGHLToken(locationId);
  }
  return tokens.access_token;
}

/**
 * Create an Axios instance pre-configured for a GHL location.
 * @param {string} locationId
 * @returns {Promise<import('axios').AxiosInstance>}
 */
export async function ghlClient(locationId) {
  const accessToken = await getValidAccessToken(locationId);
  return axios.create({
    baseURL: GHL_API_BASE,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
    },
  });
}

// ─── Location ─────────────────────────────────────────────────────────────────

/**
 * Fetch GHL location details.
 * @param {string} locationId
 */
export async function getLocation(locationId) {
  const client = await ghlClient(locationId);
  const { data } = await client.get(`/locations/${locationId}`);
  return data.location;
}

// ─── Payment Provider ─────────────────────────────────────────────────────────

/**
 * List payment integrations for a location.
 * @param {string} locationId
 */
export async function listPaymentIntegrations(locationId) {
  const client = await ghlClient(locationId);
  const { data } = await client.get(`/payments/integrations/provider/whitelabel?locationId=${locationId}`);
  return data;
}

/**
 * Register this app as a custom payment provider for a GHL location.
 * Safe to call multiple times — GHL will update if already exists.
 * @param {string} locationId
 */
export async function createGHLPaymentProvider(locationId) {
  const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  const client = await ghlClient(locationId);
  const { data } = await client.post(`/payments/custom-provider/provider?locationId=${locationId}`, {
    name:        'ChangeWorks',
    description: 'Accept payments via Stripe Connect',
    paymentsUrl: `${appUrl}/checkout`,
    queryUrl:    `${appUrl}/api/payments/status`,
    imageUrl:    'https://upload.wikimedia.org/wikipedia/commons/b/ba/Stripe_Logo%2C_revised_2016.svg',
  });
  return data;
}

/**
 * Mark the custom payment provider as connected (active) for a location.
 * Call this after a Stripe account has been linked to the location.
 * @param {string} locationId
 * @param {boolean} liveMode
 */
export async function connectGHLPaymentProvider(locationId) {
  // Creating the provider is sufficient to register it in GHL.
  // Connect is called for both test and live modes so neither shows as "disabled".
  const providerData = await createGHLPaymentProvider(locationId);
  const providerId   = providerData?._id ?? providerData?.id ?? providerData?.providerId;

  const client = await ghlClient(locationId);
  const connectBody = (liveMode) => ({
    liveMode,
    enabled: true,
    providerId,
  });

  for (const liveMode of [false, true]) {
    try {
      await client.post(`/payments/custom-provider/connect?locationId=${locationId}`, connectBody(liveMode));
    } catch (err) {
      console.warn(`[GHL] connect(liveMode=${liveMode}) failed (non-fatal): ${err.response?.status} ${JSON.stringify(err.response?.data ?? err.message)}`);
    }
  }

  return providerData;
}

/**
 * Mark the custom payment provider as disconnected for a location.
 * @param {string} locationId
 */
export async function disconnectGHLPaymentProvider(locationId) {
  const client = await ghlClient(locationId);
  const { data } = await client.delete('/payments/custom-provider/disconnect', {
    data: { locationId },
  });
  return data;
}

/**
 * Post a payment success event back to GHL.
 * Called after Stripe confirms payment so GHL can update order status.
 *
 * @param {string} locationId
 * @param {object} payload
 * @param {string} payload.entityId         – GHL order/transaction entity ID
 * @param {string} payload.entityType       – e.g. 'invoice', 'order', 'subscription'
 * @param {string} payload.externalTransactionId  – Stripe PaymentIntent ID
 * @param {number} payload.amount           – Amount in cents
 * @param {string} payload.currency
 * @param {string} payload.status           – 'success' | 'failed' | 'refunded'
 */
export async function postPaymentUpdateToGHL(locationId, payload) {
  const client = await ghlClient(locationId);
  const { data } = await client.post(
    `/payments/integrations/provider/whitelabel/payment-events`,
    { locationId, ...payload }
  );
  return data;
}

/**
 * Notify GHL of a subscription update.
 * @param {string} locationId
 * @param {object} payload
 */
export async function postSubscriptionUpdateToGHL(locationId, payload) {
  const client = await ghlClient(locationId);
  const { data } = await client.post(
    `/payments/integrations/provider/whitelabel/subscription-events`,
    { locationId, ...payload }
  );
  return data;
}
