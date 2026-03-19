/**
 * POST /api/webhooks/stripe
 * ---------------------------------------------------------------------------
 * Stripe webhook handler with DB logging and idempotency.
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { constructWebhookEvent, getPaymentIntentWithCharge } from '@/lib/stripe';
import {
  getLocationByStripeAccount,
  upsertPaymentEvent,
  getPaymentEventByEntityId,
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

        // Fetch the charge to get billing_details (name, email, phone).
        // Fall back to values stored in metadata by the checkout page.
        let customerName  = intent.metadata?.customerName  ?? null;
        let customerEmail = intent.metadata?.customerEmail ?? intent.receipt_email ?? null;
        let customerPhone = intent.metadata?.customerPhone ?? null;
        try {
          const full    = await getPaymentIntentWithCharge(intent.id, stripeAccountId);
          const billing = full.latest_charge?.billing_details ?? {};
          customerName  = billing.name  || customerName;
          customerEmail = billing.email || customerEmail;
          customerPhone = billing.phone || customerPhone;
        } catch (chargeErr) {
          console.warn('[Stripe Webhook] Could not expand charge:', chargeErr.message);
        }

        await upsertPaymentEvent({
          locationId:      locationId ?? intent.metadata?.locationId,
          stripeAccountId: stripeAccountId ?? '',
          paymentIntentId: intent.id,
          entityId:        intent.metadata?.entityId,
          entityType:      intent.metadata?.entityType ?? 'invoice',
          amount:          intent.amount,
          currency:        intent.currency,
          status:          'SUCCESS',
          customerName,
          customerEmail,
          customerPhone,
          metadata:        intent.metadata,
        });
        if (locationId) {
          // Resolve chargeId (the Stripe PI GHL linked its transaction to = PI #1).
          // If checkout created PI #2 with a different ID, look up PI #1 by entityId.
          let chargeId = intent.id;
          if (intent.metadata?.entityId) {
            try {
              const pi1Event = await getPaymentEventByEntityId(locationId, intent.metadata.entityId);
              if (pi1Event && pi1Event.paymentIntentId !== intent.id) {
                console.log(`[Stripe Webhook] PI mismatch — using PI #1 ${pi1Event.paymentIntentId} as chargeId for GHL (current PI #2: ${intent.id})`);
                chargeId = pi1Event.paymentIntentId;
              }
            } catch (lookupErr) {
              console.warn('[Stripe Webhook] PI #1 lookup failed (non-fatal):', lookupErr.message);
            }
          }

          // ghlTransactionId is GHL's internal transaction ID stored in PI metadata
          const ghlTransactionId = intent.metadata?.ghlTransactionId ?? intent.metadata?.entityId ?? null;
          console.log(`[Stripe Webhook] Notifying GHL — chargeId=${chargeId} ghlTransactionId=${ghlTransactionId}`);

          try {
            await postPaymentUpdateToGHL(locationId, {
              chargeId,
              ghlTransactionId,
              amount: intent.amount,
            });
          } catch (ghlErr) {
            console.error('[Stripe Webhook] GHL payment update failed (non-fatal):',
              ghlErr.response?.status,
              JSON.stringify(ghlErr.response?.data ?? ghlErr.message)
            );
          }
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
          customerName:    intent.metadata?.customerName  ?? null,
          customerEmail:   intent.metadata?.customerEmail ?? intent.receipt_email ?? null,
          customerPhone:   intent.metadata?.customerPhone ?? null,
          metadata:        intent.metadata,
        });
        const entityIdFailed = intent.metadata?.entityId ?? null;
        if (locationId && entityIdFailed) {
          try {
            await postPaymentUpdateToGHL(locationId, {
              entityId:              entityIdFailed,
              entityType:            intent.metadata?.entityType ?? 'invoice',
              externalTransactionId: intent.id,
              amount:                intent.amount,
              currency:              intent.currency,
              status:                'failed',
            });
          } catch (ghlErr) {
            console.error('[Stripe Webhook] GHL payment_failed update failed (non-fatal):',
              ghlErr.response?.status,
              JSON.stringify(ghlErr.response?.data ?? ghlErr.message)
            );
          }
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
          try {
            await postPaymentUpdateToGHL(locationId, {
              entityId:              charge.metadata?.entityId,
              entityType:            charge.metadata?.entityType ?? 'invoice',
              externalTransactionId: charge.payment_intent,
              amount:                charge.amount_refunded,
              currency:              charge.currency,
              status:                'refunded',
            });
          } catch (ghlErr) {
            console.error('[Stripe Webhook] GHL refund update failed (non-fatal):',
              ghlErr.response?.status,
              JSON.stringify(ghlErr.response?.data ?? ghlErr.message)
            );
          }
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        if (locationId) {
          // ghlSubscriptionId is the GHL-side subscription ID stored in metadata during creation
          const ghlSubscriptionId = sub.metadata?.ghlSubscriptionId ?? sub.metadata?.entityId;
          console.log(`[Stripe Webhook] subscription ${event.type} sub=${sub.id} status=${sub.status} ghlSubscriptionId=${ghlSubscriptionId}`);
          try {
            await postSubscriptionUpdateToGHL(locationId, {
              externalSubscriptionId: sub.id,
              status:   sub.status,
              entityId: ghlSubscriptionId,
            });
          } catch (ghlErr) {
            console.error('[Stripe Webhook] GHL subscription update failed (non-fatal):',
              ghlErr.response?.status,
              JSON.stringify(ghlErr.response?.data ?? ghlErr.message)
            );
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        if (locationId) {
          const ghlSubscriptionId = sub.metadata?.ghlSubscriptionId ?? sub.metadata?.entityId;
          try {
            await postSubscriptionUpdateToGHL(locationId, {
              externalSubscriptionId: sub.id,
              status:   'canceled',
              entityId: ghlSubscriptionId,
            });
          } catch (ghlErr) {
            console.error('[Stripe Webhook] GHL subscription deleted update failed (non-fatal):',
              ghlErr.response?.status,
              JSON.stringify(ghlErr.response?.data ?? ghlErr.message)
            );
          }
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
