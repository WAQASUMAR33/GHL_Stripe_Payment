/**
 * POST /api/payments/create-intent
 * ---------------------------------------------------------------------------
 * Creates either a Stripe PaymentIntent (one-time) or a Subscription
 * (recurring) depending on whether a priceId is supplied and that price
 * has a recurring interval.
 *
 * Request body:
 * {
 *   locationId:          string,
 *   amount?:             number,   // cents — used when no priceId
 *   currency?:           string,   // default "usd"
 *   priceId?:            string,   // Stripe Price ID — drives mode detection
 *   entityId?:           string,
 *   entityType?:         string,
 *   applicationFeeRate?: number,   // decimal e.g. 0.02 = 2%
 *   metadata?:           object    // extra metadata (customerName/Email/Phone etc.)
 * }
 *
 * Response:
 * {
 *   clientSecret, publishableKey, stripeAccountId,
 *   mode: 'payment' | 'subscription',
 *   paymentIntentId?,   // one-time
 *   subscriptionId?,    // recurring
 * }
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  createPaymentIntent,
  createCustomer,
  createSubscription,
  createInlineSubscription,
  getPrice,
} from '@/lib/stripe';
import { getStripeAccount, upsertPaymentEvent, getPriceSync } from '@/lib/tokenStore';
import { getTransaction } from '@/lib/ghl';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const {
    locationId,
    amount,
    currency = 'usd',
    priceId,
    entityId,
    entityType,
    interval,
    isRecurring: isRecurringFlag,
    ghlSubscriptionId,
    applicationFeeRate = 0,
    metadata = {},
  } = body;

  // Log full request body so we can see what GHL sends for recurring products
  console.log('[create-intent] body:', JSON.stringify({
    locationId, amount, currency, priceId, entityId, entityType, interval,
    isRecurring: isRecurringFlag, ghlSubscriptionId,
  }));

  if (!locationId) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  }
  if (!priceId && !amount) {
    return NextResponse.json({ error: 'Either priceId or amount is required' }, { status: 400 });
  }

  const finalEntityId   = entityId   || `ghl-${Date.now()}`;
  const finalEntityType = entityType || 'invoice';

  // Detect recurring from entityType (GHL may send 'subscription', 'SUBSCRIPTION', 'RECURRING')
  const RECURRING_ENTITY_TYPES = new Set(['subscription', 'subscription_order', 'recurring', 'recurring_order', 'subscriptions']);
  const entityTypeIsRecurring = RECURRING_ENTITY_TYPES.has((entityType ?? '').toLowerCase());
  let resolvedInterval = interval || 'month';

  // Look up the GHL transaction to check if it's a subscription order.
  // GHL sends entityType='invoice' for both one-time AND subscription orders,
  // so we must query the transaction to distinguish them.
  let ghlTransactionIsSubscription = false;
  const ghlTransactionId = metadata?.ghlTransactionId ?? null;
  if (ghlTransactionId && locationId) {
    const txn = await getTransaction(locationId, ghlTransactionId);
    console.log(`[create-intent] GHL transaction lookup: id=${ghlTransactionId} entitySourceType=${txn?.entitySourceType} status=${txn?.status}`);
    if (txn) {
      const sourceType = (txn.entitySourceType ?? '').toLowerCase();
      ghlTransactionIsSubscription = sourceType === 'subscriptions' || sourceType === 'subscription';
      // If GHL provides an interval on the transaction, use it
      if (txn.interval) resolvedInterval = txn.interval;
    }
  }

  const stripeAccount = await getStripeAccount(locationId);
  if (!stripeAccount) {
    return NextResponse.json(
      { error: 'This location has not connected a Stripe account yet' },
      { status: 404 }
    );
  }

  const sharedMeta = {
    locationId,
    entityId:   finalEntityId,
    entityType: finalEntityType,
    ...metadata,
  };

  // ── If a priceId is provided, resolve it (may be GHL or Stripe price ID) ─
  if (priceId) {
    // First try to resolve as a GHL price ID via our sync DB
    let resolvedPriceId = priceId;
    try {
      const priceSync = await getPriceSync(locationId, priceId);
      if (priceSync?.stripePriceId) {
        resolvedPriceId = priceSync.stripePriceId;
        console.log(`[create-intent] Resolved GHL priceId ${priceId} → Stripe ${resolvedPriceId}`);
      }
    } catch {}

    let price;
    try {
      price = await getPrice(resolvedPriceId, stripeAccount.stripeAccountId);
    } catch (err) {
      console.error('[create-intent] getPrice error:', err.message);
      return NextResponse.json({ error: `Invalid price: ${err.message}` }, { status: 400 });
    }

    // ── Recurring → create Subscription ────────────────────────────────────
    if (price.recurring) {
      const customerEmail = metadata.customerEmail ?? null;
      const customerName  = metadata.customerName  ?? null;
      const customerPhone = metadata.customerPhone ?? null;

      let customer;
      try {
        customer = await createCustomer({
          stripeAccountId: stripeAccount.stripeAccountId,
          email:    customerEmail,
          name:     customerName,
          phone:    customerPhone,
          metadata: { locationId, entityId: finalEntityId },
        });
      } catch (err) {
        console.error('[create-intent] createCustomer error:', err.message);
        return NextResponse.json({ error: `Failed to create customer: ${err.message}` }, { status: 500 });
      }

      const applicationFeePercent =
        applicationFeeRate > 0 ? applicationFeeRate * 100 : undefined;

      let subscription;
      try {
        subscription = await createSubscription({
          stripeAccountId:     stripeAccount.stripeAccountId,
          customerId:          customer.id,
          priceId,
          applicationFeePercent,
          metadata:            { ...sharedMeta, entityType: 'subscription' },
        });
      } catch (err) {
        console.error('[create-intent] createSubscription error:', err.message);
        return NextResponse.json({ error: `Failed to create subscription: ${err.message}` }, { status: 500 });
      }

      const paymentIntent = subscription.latest_invoice?.payment_intent;
      if (!paymentIntent?.client_secret) {
        return NextResponse.json(
          { error: 'Subscription created but no payment required yet' },
          { status: 422 }
        );
      }

      return NextResponse.json({
        clientSecret:    paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        subscriptionId:  subscription.id,
        publishableKey:  stripeAccount.publishableKey,
        stripeAccountId: stripeAccount.stripeAccountId,
        mode:            'subscription',
      });
    }

    // ── One-time price → use price amount ──────────────────────────────────
    const priceAmount    = price.unit_amount ?? amount;
    const priceCurrency  = price.currency   ?? currency;
    const applicationFeeAmount =
      applicationFeeRate > 0 ? Math.round(priceAmount * applicationFeeRate) : 0;

    let intent;
    try {
      intent = await createPaymentIntent({
        amount:               priceAmount,
        currency:             priceCurrency,
        stripeAccountId:      stripeAccount.stripeAccountId,
        applicationFeeAmount: applicationFeeAmount || undefined,
        metadata:             sharedMeta,
      });
    } catch (err) {
      console.error('[create-intent] createPaymentIntent (price) error:', err.message);
      return NextResponse.json({ error: err.message }, { status: 500 });
    }

    return NextResponse.json({
      clientSecret:    intent.client_secret,
      paymentIntentId: intent.id,
      publishableKey:  stripeAccount.publishableKey,
      stripeAccountId: stripeAccount.stripeAccountId,
      mode:            'payment',
    });
  }

  // ── No priceId → check if recurring indicated by any signal ─────────────────
  // ghlSubscriptionId present = GHL explicitly told us this is a subscription checkout
  const shouldCreateSubscription = !!ghlSubscriptionId || isRecurringFlag || entityTypeIsRecurring || ghlTransactionIsSubscription;
  console.log(`[create-intent] no priceId — ghlSubscriptionId=${ghlSubscriptionId ?? 'none'} entityType=${finalEntityType} entityTypeIsRecurring=${entityTypeIsRecurring} isRecurringFlag=${isRecurringFlag} ghlTxnIsSubscription=${ghlTransactionIsSubscription} → shouldCreateSubscription=${shouldCreateSubscription}`);

  if (shouldCreateSubscription && amount) {
    const customerEmail = metadata.customerEmail ?? null;
    const customerName  = metadata.customerName  ?? null;
    const customerPhone = metadata.customerPhone ?? null;

    let customer;
    try {
      customer = await createCustomer({
        stripeAccountId: stripeAccount.stripeAccountId,
        email: customerEmail, name: customerName, phone: customerPhone,
        metadata: { locationId, entityId: finalEntityId },
      });
    } catch (err) {
      console.error('[create-intent] createCustomer error:', err.message);
      return NextResponse.json({ error: `Failed to create customer: ${err.message}` }, { status: 500 });
    }

    let subscription;
    try {
      subscription = await createInlineSubscription({
        stripeAccountId: stripeAccount.stripeAccountId,
        customerId:      customer.id,
        amount,
        currency,
        interval:        resolvedInterval,
        productName:     'Subscription',
        metadata: {
          ...sharedMeta,
          entityType:        'subscription',
          ghlSubscriptionId: ghlSubscriptionId ?? null,
        },
      });
    } catch (err) {
      console.error('[create-intent] createInlineSubscription error:', err.message);
      return NextResponse.json({ error: `Failed to create subscription: ${err.message}` }, { status: 500 });
    }

    const paymentIntent = subscription.latest_invoice?.payment_intent;
    if (!paymentIntent?.client_secret) {
      return NextResponse.json({ error: 'Subscription created but no payment required yet' }, { status: 422 });
    }

    console.log(`[create-intent] inline subscription ${subscription.id} PI ${paymentIntent.id}`);
    return NextResponse.json({
      clientSecret:    paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      subscriptionId:  subscription.id,
      publishableKey:  stripeAccount.publishableKey,
      stripeAccountId: stripeAccount.stripeAccountId,
      mode:            'subscription',
    });
  }

  // ── Plain amount PaymentIntent ────────────────────────────────────────────
  const applicationFeeAmount =
    applicationFeeRate > 0 ? Math.round(amount * applicationFeeRate) : 0;

  let intent;
  try {
    intent = await createPaymentIntent({
      amount,
      currency,
      stripeAccountId:      stripeAccount.stripeAccountId,
      applicationFeeAmount: applicationFeeAmount || undefined,
      metadata:             sharedMeta,
    });
  } catch (err) {
    console.error('[create-intent]', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  // Save to DB immediately so the verify endpoint can look up locationId/stripeAccountId
  // before payment_intent.succeeded fires (GHL calls verify right after checkout success)
  try {
    await upsertPaymentEvent({
      locationId:      locationId,
      stripeAccountId: stripeAccount.stripeAccountId,
      paymentIntentId: intent.id,
      entityId:        finalEntityId,
      entityType:      finalEntityType,
      amount:          amount,
      currency:        currency,
      status:          'PENDING',
      customerName:    metadata.customerName  ?? null,
      customerEmail:   metadata.customerEmail ?? null,
      customerPhone:   metadata.customerPhone ?? null,
    });
  } catch (dbErr) {
    console.warn('[create-intent] Failed to pre-save payment event (non-fatal):', dbErr.message);
  }

  return NextResponse.json({
    clientSecret:    intent.client_secret,
    paymentIntentId: intent.id,
    publishableKey:  stripeAccount.publishableKey,
    stripeAccountId: stripeAccount.stripeAccountId,
    mode:            'payment',
  });
}
