/**
 * lib/tokenStore.js
 * ---------------------------------------------------------------------------
 * Database-backed token store using Prisma + MySQL.
 * Uses getPrisma() for lazy initialization — safe during Next.js build.
 * ---------------------------------------------------------------------------
 */

import { getPrisma } from './db.js';

// ─── GHL Tokens ──────────────────────────────────────────────────────────────

export async function saveGHLTokens(locationId, tokens) {
  await getPrisma().ghlConnection.upsert({
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

export async function getGHLTokens(locationId) {
  const row = await getPrisma().ghlConnection.findUnique({ where: { locationId } });
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

export async function listGHLLocations() {
  const rows = await getPrisma().ghlConnection.findMany({ select: { locationId: true } });
  return rows.map((r) => r.locationId);
}

// ─── Stripe Connect Accounts ─────────────────────────────────────────────────

export async function saveStripeAccount(locationId, data) {
  if (!data) {
    await getPrisma().stripeConnection.deleteMany({ where: { locationId } });
    return;
  }
  await getPrisma().stripeConnection.upsert({
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

export async function getStripeAccount(locationId) {
  const row = await getPrisma().stripeConnection.findUnique({ where: { locationId } });
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

export async function getLocationByStripeAccount(stripeAccountId) {
  const row = await getPrisma().stripeConnection.findUnique({
    where:  { stripeAccountId },
    select: { locationId: true },
  });
  return row?.locationId ?? null;
}

// ─── Payment Events ───────────────────────────────────────────────────────────

export async function upsertPaymentEvent(data) {
  return getPrisma().paymentEvent.upsert({
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

export async function listPaymentEvents(locationId, { limit = 50, offset = 0, status } = {}) {
  return getPrisma().paymentEvent.findMany({
    where:   { locationId, ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take:    limit,
    skip:    offset,
  });
}

// ─── Webhook Idempotency ──────────────────────────────────────────────────────

export async function isWebhookProcessed(eventId) {
  const row = await getPrisma().webhookLog.findUnique({
    where:  { eventId },
    select: { status: true },
  });
  return row?.status === 'PROCESSED';
}

export async function createWebhookLog(data) {
  return getPrisma().webhookLog.create({
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

export async function updateWebhookLog(eventId, status, error) {
  await getPrisma().webhookLog.update({
    where: { eventId },
    data: {
      status,
      error:       error ?? null,
      processedAt: new Date(),
    },
  });
}
