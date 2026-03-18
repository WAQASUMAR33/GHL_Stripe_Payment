/**
 * POST /api/webhooks/ghl
 * ---------------------------------------------------------------------------
 * GHL Payment Provider webhook handler with DB logging.
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { createPaymentIntent, createRefund, createProduct, createPrice, updateProduct } from '@/lib/stripe';
import {
  getStripeAccount,
  createWebhookLog,
  updateWebhookLog,
  saveProductSync,
  getProductSync,
  deleteProductSync,
} from '@/lib/tokenStore';

const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET;

function verifyGHLWebhook(rawBody, signature) {
  const expected = createHmac('sha256', GHL_CLIENT_SECRET)
    .update(rawBody)
    .digest('hex');
  return expected === signature;
}

export async function POST(request) {
  const rawBody   = Buffer.from(await request.arrayBuffer());
  const signature = request.headers.get('x-ghl-signature') ?? '';

  if (GHL_CLIENT_SECRET && !verifyGHLWebhook(rawBody, signature)) {
    console.warn('[GHL Webhook] Invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { type, locationId, data } = payload;
  const eventId = payload.eventId ?? `ghl-${Date.now()}-${Math.random()}`;

  // Log the incoming event
  await createWebhookLog({
    source:     'GHL',
    eventId,
    eventType:  type,
    locationId: locationId ?? undefined,
    payload,
  });

  console.log(`[GHL Webhook] ${type} | location: ${locationId}`);

  try {
    switch (type) {

      case 'PAYMENT_PROVIDER_CHARGE': {
        const stripeAccount = await getStripeAccount(locationId);
        if (!stripeAccount) {
          await updateWebhookLog(eventId, 'FAILED', `No Stripe account for location ${locationId}`);
          return NextResponse.json(
            { error: `No Stripe account connected for location ${locationId}` },
            { status: 404 }
          );
        }

        // Extract customer info from GHL's contact object or top-level fields
        const contact       = data.contact ?? {};
        const customerName  = (contact.firstName || contact.lastName)
          ? [contact.firstName, contact.lastName].filter(Boolean).join(' ')
          : (data.customerName ?? null);
        const customerEmail = contact.email ?? data.email ?? null;
        const customerPhone = contact.phone ?? data.phone ?? null;

        const intent = await createPaymentIntent({
          amount:          data.amount,
          currency:        data.currency ?? 'usd',
          stripeAccountId: stripeAccount.stripeAccountId,
          metadata: {
            locationId,
            entityId:      data.entityId,
            entityType:    data.entityType,
            ghlContactId:  data.contactId ?? null,
            customerName,
            customerEmail,
            customerPhone,
          },
        });

        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({
          clientSecret:   intent.client_secret,
          publishableKey: stripeAccount.publishableKey,
        });
      }

      case 'PAYMENT_PROVIDER_REFUND': {
        const stripeAccount = await getStripeAccount(locationId);
        if (!stripeAccount) {
          await updateWebhookLog(eventId, 'FAILED', `No Stripe account for location ${locationId}`);
          return NextResponse.json({ error: 'Stripe account not connected' }, { status: 404 });
        }

        const refund = await createRefund({
          paymentIntentId: data.externalTransactionId,
          stripeAccountId: stripeAccount.stripeAccountId,
          amount:          data.amount,
          reason:          data.reason,
        });

        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({ refundId: refund.id, status: refund.status });
      }

      case 'INSTALL':
        console.log(`[GHL Webhook] App installed on location ${locationId}`);
        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({ received: true });

      case 'UNINSTALL':
        console.log(`[GHL Webhook] App uninstalled from location ${locationId}`);
        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({ received: true });

      // ── GHL Product events → sync to Stripe ───────────────────────────────
      case 'ProductCreate': {
        const stripeAccount = await getStripeAccount(locationId);
        if (!stripeAccount) { await updateWebhookLog(eventId, 'SKIPPED', 'No Stripe account'); break; }

        // GHL may nest product in data or send it at the top level
        const prod = data ?? payload;
        const ghlProductId = prod.id ?? prod._id;
        const name         = prod.name ?? prod.title;
        if (!name || !ghlProductId) { await updateWebhookLog(eventId, 'SKIPPED', 'Missing product name/id'); break; }

        // Extract price from variants or top-level price field
        const variant      = prod.variants?.[0] ?? prod.prices?.[0] ?? {};
        const priceAmount  = variant.price ?? variant.amount ?? prod.price ?? 0;
        const currency     = (variant.currency ?? prod.currency ?? 'usd').toLowerCase();
        const isRecurring  = prod.recurring ?? prod.productType === 'RECURRING' ?? false;
        const interval     = prod.interval ?? variant.interval ?? 'month';

        const stripeProduct = await createProduct({
          stripeAccountId: stripeAccount.stripeAccountId,
          name,
          description: prod.description ?? undefined,
        });

        let stripePrice = null;
        if (priceAmount > 0) {
          stripePrice = await createPrice({
            stripeAccountId: stripeAccount.stripeAccountId,
            productId:       stripeProduct.id,
            amount:          Math.round(Number(priceAmount) * 100),
            currency,
            recurring:       isRecurring ? { interval } : undefined,
          });
        }

        await saveProductSync(locationId, ghlProductId, stripeProduct.id, stripePrice?.id ?? null);
        console.log(`[GHL Webhook] ProductCreate: GHL ${ghlProductId} → Stripe ${stripeProduct.id}`);
        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({ received: true, stripeProductId: stripeProduct.id });
      }

      case 'ProductUpdate': {
        const stripeAccount = await getStripeAccount(locationId);
        if (!stripeAccount) { await updateWebhookLog(eventId, 'SKIPPED', 'No Stripe account'); break; }

        const prod         = data ?? payload;
        const ghlProductId = prod.id ?? prod._id;
        const name         = prod.name ?? prod.title;
        if (!ghlProductId) { await updateWebhookLog(eventId, 'SKIPPED', 'Missing product id'); break; }

        const mapping = await getProductSync(locationId, ghlProductId);
        if (!mapping) { await updateWebhookLog(eventId, 'SKIPPED', 'No Stripe mapping found — product may not have been synced'); break; }

        await updateProduct(stripeAccount.stripeAccountId, mapping.stripeProductId, {
          ...(name                ? { name }                        : {}),
          ...(prod.description    ? { description: prod.description } : {}),
        });

        console.log(`[GHL Webhook] ProductUpdate: Stripe ${mapping.stripeProductId}`);
        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({ received: true });
      }

      case 'ProductDelete': {
        const stripeAccount = await getStripeAccount(locationId);
        if (!stripeAccount) { await updateWebhookLog(eventId, 'SKIPPED', 'No Stripe account'); break; }

        const prod         = data ?? payload;
        const ghlProductId = prod.id ?? prod._id;
        if (!ghlProductId) { await updateWebhookLog(eventId, 'SKIPPED', 'Missing product id'); break; }

        const mapping = await getProductSync(locationId, ghlProductId);
        if (!mapping) { await updateWebhookLog(eventId, 'SKIPPED', 'No Stripe mapping found'); break; }

        // Archive in Stripe (cannot hard-delete products with associated prices)
        await updateProduct(stripeAccount.stripeAccountId, mapping.stripeProductId, { active: false });
        await deleteProductSync(locationId, ghlProductId);

        console.log(`[GHL Webhook] ProductDelete: archived Stripe ${mapping.stripeProductId}`);
        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({ received: true });
      }

      default:
        await updateWebhookLog(eventId, 'SKIPPED');
        return NextResponse.json({ received: true });
    }
  } catch (err) {
    console.error(`[GHL Webhook] Error handling ${type}:`, err.message);
    await updateWebhookLog(eventId, 'FAILED', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
