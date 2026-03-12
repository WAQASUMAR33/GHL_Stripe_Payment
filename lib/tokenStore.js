/**
 * lib/tokenStore.js
 * ---------------------------------------------------------------------------
 * Database-backed token store using Prisma + MySQL.
 * Same function signatures as the old file-based store — no other files change.
 * ---------------------------------------------------------------------------
 */

import { prisma } from './db.js';

// ─── GHL Tokens ──────────────────────────────────────────────────────────────

/**
 * Save (upsert) GHL OAuth tokens for a location.
 * @param {string} locationId
 * @param {object} tokens – { access_token, refresh_token, expires_at, companyId, userId }
 */
export async function saveGHLTokens(locationId, tokens) {
  await prisma.ghlConnection.upsert({
    where:  { locationId },
    create: {
      locationId,
      companyId:    tokens.companyId    ?? null,
      userId:       tokens.userId       ?? null,
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt:    new Date(tokens.expires_at),
    },
    update: {
      companyId:    tokens.companyId    ?? undefined,
      userId:       tokens.userId       ?? undefined,
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt:    new Date(tokens.expires_at),
    },
  });
}

/**
 * Retrieve GHL tokens for a location.
 * @param {string} locationId
 * @returns {Promise<object|null>}
 */
export async function getGHLTokens(locationId) {
  const row = await prisma.ghlConnection.findUnique({ where: { locationId } });
  if (!row) return null;

  return {
    access_token:  row.accessToken,
    refresh_token: row.refreshToken,
    expires_at:    row.expiresAt.getTime(),
    companyId:     row.companyId,
    userId:        row.userId,
    locationId:    row.locationId,
  };
}

/**
 * List all connected GHL location IDs.
 * @returns {Promise<string[]>}
 */
export async function listGHLLocations() {
  const rows = await prisma.ghlConnection.findMany({ select: { locationId: true } });
  return rows.map((r) => r.locationId);
}

// ─── Stripe Connect Accounts ─────────────────────────────────────────────────

/**
 * Save (upsert) a Stripe Connect account for a GHL location.
 * Pass null as data to disconnect (deletes the record).
 * @param {string} locationId
 * @param {object|null} data
 */
export async function saveStripeAccount(locationId, data) {
  if (!data) {
    await prisma.stripeConnection.deleteMany({ where: { locationId } });
    return;
  }

  await prisma.stripeConnection.upsert({
    where:  { locationId },
    create: {
      locationId,
      stripeAccountId: data.stripeAccountId,
      accessToken:     data.accessToken,
      refreshToken:    data.refreshToken   ?? null,
      publishableKey:  data.publishableKey,
      livemode:        data.livemode       ?? false,
      tokenType:       data.tokenType      ?? null,
      scope:           data.scope          ?? null,
    },
    update: {
      stripeAccountId: data.stripeAccountId,
      accessToken:     data.accessToken,
      refreshToken:    data.refreshToken   ?? undefined,
      publishableKey:  data.publishableKey,
      livemode:        data.livemode       ?? false,
      tokenType:       data.tokenType      ?? undefined,
      scope:           data.scope          ?? undefined,
    },
  });
}

/**
 * Retrieve Stripe account for a GHL location.
 * @param {string} locationId
 * @returns {Promise<object|null>}
 */
export async function getStripeAccount(locationId) {
  const row = await prisma.stripeConnection.findUnique({ where: { locationId } });
  if (!row) return null;

  return {
    stripeAccountId: row.stripeAccountId,
    accessToken:     row.accessToken,
    refreshToken:    row.refreshToken,
    publishableKey:  row.publishableKey,
    livemode:        row.livemode,
    tokenType:       row.tokenType,
    scope:           row.scope,
  };
}

/**
 * Find a GHL locationId by Stripe account ID (used in webhooks).
 * @param {string} stripeAccountId
 * @returns {Promise<string|null>}
 */
export async function getLocationByStripeAccount(stripeAccountId) {
  const row = await prisma.stripeConnection.findUnique({
    where:  { stripeAccountId },
    select: { locationId: true },
  });
  return row?.locationId ?? null;
}

// ─── Payment Events ───────────────────────────────────────────────────────────

/**
 * Log a payment event (upsert by paymentIntentId — safe for webhook retries).
 * @param {object} data
 */
export async function upsertPaymentEvent(data) {
  return prisma.paymentEvent.upsert({
    where:  { paymentIntentId: data.paymentIntentId },
    create: {
      locationId:      data.locationId,
      stripeAccountId: data.stripeAccountId,
      paymentIntentId: data.paymentIntentId,
      entityId:        data.entityId        ?? null,
      entityType:      data.entityType      ?? null,
      amount:          data.amount,
      currency:        data.currency        ?? 'usd',
      status:          data.status,
      failureReason:   data.failureReason   ?? null,
      refundedAmount:  data.refundedAmount  ?? 0,
      metadata:        data.metadata        ?? undefined,
    },
    update: {
      status:          data.status,
      failureReason:   data.failureReason   ?? undefined,
      refundedAmount:  data.refundedAmount  ?? undefined,
    },
  });
}

/**
 * List payment events for a location, newest first.
 * @param {string} locationId
 * @param {{ limit?: number, offset?: number, status?: string }} opts
 */
export async function listPaymentEvents(locationId, { limit = 50, offset = 0, status } = {}) {
  return prisma.paymentEvent.findMany({
    where:   { locationId, ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take:    limit,
    skip:    offset,
  });
}

// ─── Webhook Idempotency ──────────────────────────────────────────────────────

/**
 * Check if a webhook event has already been processed.
 * @param {string} eventId
 * @returns {Promise<boolean>}
 */
export async function isWebhookProcessed(eventId) {
  const row = await prisma.webhookLog.findUnique({
    where:  { eventId },
    select: { status: true },
  });
  return row?.status === 'PROCESSED';
}

/**
 * Create a webhook log entry (PENDING).
 * @param {{ source: string, eventId: string, eventType: string, locationId?: string, payload: object }} data
 */
export async function createWebhookLog(data) {
  return prisma.webhookLog.create({
    data: {
      source:     data.source,
      eventId:    data.eventId,
      eventType:  data.eventType,
      locationId: data.locationId ?? null,
      payload:    data.payload,
      status:     'PENDING',
    },
  });
}

/**
 * Mark a webhook log entry as processed or failed.
 * @param {string} eventId
 * @param {'PROCESSED'|'FAILED'|'SKIPPED'} status
 * @param {string} [error]
 */
export async function updateWebhookLog(eventId, status, error) {
  await prisma.webhookLog.update({
    where: { eventId },
    data: {
      status,
      error:       error ?? null,
      processedAt: new Date(),
    },
  });
}
