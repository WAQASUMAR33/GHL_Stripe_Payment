/**
 * POST /api/webhooks/stripe
 * ---------------------------------------------------------------------------
 * Stripe webhook handler with DB logging and idempotency.
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { constructWebhookEvent } from '@/lib/stripe';
import {
  getLocationByStripeAccount,
  upsertPaymentEvent,
  isWebhookProcessed,
  createWebhookLog,
  updateWebhookLog,
} from '@/lib/tokenStore';
import { postPaymentUpdateToGHL, postSubscriptionUpdateToGHL } from '@/lib/ghl';

export async function POST(request) {
  const rawBody   = Buffer.from(await request.arrayBuffer());
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  let event;
  try {
    event = constructWebhookEvent(rawBody, signature);
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  // ── Idempotency: skip already-processed events ────────────────────────────
  if (await isWebhookProcessed(event.id)) {
    return NextResponse.json({ received: true, skipped: true });
  }

  const stripeAccountId = event.account;
  const locationId = stripeAccountId
    ? await getLocationByStripeAccount(stripeAccountId)
    : null;

  await createWebhookLog({
    source:     'STRIPE',
    eventId:    event.id,
    eventType:  event.type,
    locationId: locationId ?? undefined,
    payload:    event,
  });

  console.log(`[Stripe Webhook] ${event.type} | account: ${stripeAccountId ?? 'platform'} | location: ${locationId ?? 'unknown'}`);

  try {
    switch (event.type) {

      case 'payment_intent.succeeded': {
        const intent = event.data.object;
        await upsertPaymentEvent({
          locationId:      locationId ?? intent.metadata?.locationId,
          stripeAccountId: stripeAccountId ?? '',
          paymentIntentId: intent.id,
          entityId:        intent.metadata?.entityId,
          entityType:      intent.metadata?.entityType ?? 'invoice',
          amount:          intent.amount,
          currency:        intent.currency,
          status:          'SUCCESS',
          metadata:        intent.metadata,
        });
        if (locationId) {
          await postPaymentUpdateToGHL(locationId, {
            entityId:              intent.metadata?.entityId,
            entityType:            intent.metadata?.entityType ?? 'invoice',
            externalTransactionId: intent.id,
            amount:                intent.amount,
            currency:              intent.currency,
            status:                'success',
          });
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const intent = event.data.object;
        await upsertPaymentEvent({
          locationId:      locationId ?? intent.metadata?.locationId,
          stripeAccountId: stripeAccountId ?? '',
          paymentIntentId: intent.id,
          entityId:        intent.metadata?.entityId,
          entityType:      intent.metadata?.entityType ?? 'invoice',
          amount:          intent.amount,
          currency:        intent.currency,
          status:          'FAILED',
          failureReason:   intent.last_payment_error?.message ?? null,
          metadata:        intent.metadata,
        });
        if (locationId) {
          await postPaymentUpdateToGHL(locationId, {
            entityId:              intent.metadata?.entityId,
            entityType:            intent.metadata?.entityType ?? 'invoice',
            externalTransactionId: intent.id,
            amount:                intent.amount,
            currency:              intent.currency,
            status:                'failed',
          });
        }
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        await upsertPaymentEvent({
          locationId:      locationId ?? charge.metadata?.locationId,
          stripeAccountId: stripeAccountId ?? '',
          paymentIntentId: charge.payment_intent,
          entityId:        charge.metadata?.entityId,
          entityType:      charge.metadata?.entityType ?? 'invoice',
          amount:          charge.amount,
          currency:        charge.currency,
          status:          charge.amount_refunded === charge.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          refundedAmount:  charge.amount_refunded,
          metadata:        charge.metadata,
        });
        if (locationId) {
          await postPaymentUpdateToGHL(locationId, {
            entityId:              charge.metadata?.entityId,
            entityType:            charge.metadata?.entityType ?? 'invoice',
            externalTransactionId: charge.payment_intent,
            amount:                charge.amount_refunded,
            currency:              charge.currency,
            status:                'refunded',
          });
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        if (locationId) {
          await postSubscriptionUpdateToGHL(locationId, {
            externalSubscriptionId: sub.id,
            status:   sub.status,
            entityId: sub.metadata?.entityId,
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        if (locationId) {
          await postSubscriptionUpdateToGHL(locationId, {
            externalSubscriptionId: sub.id,
            status:   'canceled',
            entityId: sub.metadata?.entityId,
          });
        }
        break;
      }

      default:
        await updateWebhookLog(event.id, 'SKIPPED');
        return NextResponse.json({ received: true });
    }

    await updateWebhookLog(event.id, 'PROCESSED');
  } catch (err) {
    console.error(`[Stripe Webhook] Error processing ${event.type}:`, err.message);
    await updateWebhookLog(event.id, 'FAILED', err.message);
  }

  return NextResponse.json({ received: true });
}
