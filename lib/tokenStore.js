/**
 * lib/tokenStore.js
 * ---------------------------------------------------------------------------
 * Database-backed token store using Prisma + MySQL.
 * getPrisma() is async (dynamic import), so every call must be awaited
 * before accessing model properties: const db = await getPrisma()
 * ---------------------------------------------------------------------------
 */

import { getPrisma } from './db.js';

// ─── GHL Tokens ──────────────────────────────────────────────────────────────

export async function saveGHLTokens(locationId, tokens) {
  const db = await getPrisma();
  await db.ghlConnection.upsert({
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
  const db  = await getPrisma();
  const row = await db.ghlConnection.findUnique({ where: { locationId } });
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
  const db   = await getPrisma();
  const rows = await db.ghlConnection.findMany({ select: { locationId: true } });
  return rows.map((r) => r.locationId);
}

// ─── Stripe Connect Accounts ─────────────────────────────────────────────────

export async function saveStripeAccount(locationId, data) {
  const db = await getPrisma();
  if (!data) {
    await db.ghlStripeConnection.deleteMany({ where: { locationId } });
    return;
  }
  await db.ghlStripeConnection.upsert({
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
  const db  = await getPrisma();
  const row = await db.ghlStripeConnection.findUnique({ where: { locationId } });
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
  const db  = await getPrisma();
  const row = await db.ghlStripeConnection.findUnique({
    where:  { stripeAccountId },
    select: { locationId: true },
  });
  return row?.locationId ?? null;
}

// ─── Payment Events ───────────────────────────────────────────────────────────

export async function upsertPaymentEvent(data) {
  const db = await getPrisma();
  return db.ghlPaymentEvent.upsert({
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
      customerName:    data.customerName    ?? null,
      customerEmail:   data.customerEmail   ?? null,
      customerPhone:   data.customerPhone   ?? null,
      metadata:        data.metadata ? JSON.stringify(data.metadata) : null,
    },
    update: {
      status:          data.status,
      failureReason:   data.failureReason   ?? undefined,
      refundedAmount:  data.refundedAmount  ?? undefined,
      // Only overwrite customer fields if we actually have values (don't wipe existing data)
      ...(data.customerName  ? { customerName:  data.customerName  } : {}),
      ...(data.customerEmail ? { customerEmail: data.customerEmail } : {}),
      ...(data.customerPhone ? { customerPhone: data.customerPhone } : {}),
    },
  });
}

export async function listPaymentEvents(locationId, { limit = 50, offset = 0, status } = {}) {
  const db = await getPrisma();
  return db.ghlPaymentEvent.findMany({
    where:   { locationId, ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take:    limit,
    skip:    offset,
  });
}

// ─── GHL ↔ Stripe Product Sync Map ───────────────────────────────────────────

export async function saveProductSync(locationId, ghlProductId, stripeProductId, stripePriceId) {
  const db = await getPrisma();
  await db.ghlProductSync.upsert({
    where:  { locationId_ghlProductId: { locationId, ghlProductId } },
    create: { locationId, ghlProductId, stripeProductId, stripePriceId: stripePriceId ?? null },
    update: { stripeProductId, stripePriceId: stripePriceId ?? undefined },
  });
}

export async function getProductSync(locationId, ghlProductId) {
  const db = await getPrisma();
  return db.ghlProductSync.findUnique({
    where: { locationId_ghlProductId: { locationId, ghlProductId } },
  });
}

export async function deleteProductSync(locationId, ghlProductId) {
  const db = await getPrisma();
  await db.ghlProductSync.deleteMany({ where: { locationId, ghlProductId } });
}

// ─── Webhook Idempotency ──────────────────────────────────────────────────────

export async function isWebhookProcessed(eventId) {
  const db  = await getPrisma();
  const row = await db.ghlWebhookLog.findUnique({
    where:  { eventId },
    select: { status: true },
  });
  return row?.status === 'PROCESSED';
}

export async function createWebhookLog(data) {
  const db = await getPrisma();
  return db.ghlWebhookLog.create({
    data: {
      source:     data.source,
      eventId:    data.eventId,
      eventType:  data.eventType,
      locationId: data.locationId ?? null,
      payload:    typeof data.payload === 'string' ? data.payload : JSON.stringify(data.payload),
      status:     'PENDING',
    },
  });
}

export async function updateWebhookLog(eventId, status, error) {
  const db = await getPrisma();
  await db.ghlWebhookLog.update({
    where: { eventId },
    data: {
      status,
      error:       error ?? null,
      processedAt: new Date(),
    },
  });
}
