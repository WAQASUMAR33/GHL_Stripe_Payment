/**
 * POST /api/webhooks/ghl
 * ---------------------------------------------------------------------------
 * GHL Payment Provider webhook handler with DB logging.
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { createPaymentIntent, createRefund } from '@/lib/stripe';
import { getStripeAccount, createWebhookLog, updateWebhookLog } from '@/lib/tokenStore';

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

        const intent = await createPaymentIntent({
          amount:          data.amount,
          currency:        data.currency ?? 'usd',
          stripeAccountId: stripeAccount.stripeAccountId,
          metadata: {
            locationId,
            entityId:   data.entityId,
            entityType: data.entityType,
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
