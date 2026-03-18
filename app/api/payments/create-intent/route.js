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
  getPrice,
} from '@/lib/stripe';
import { getStripeAccount } from '@/lib/tokenStore';

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
    applicationFeeRate = 0,
    metadata = {},
  } = body;

  if (!locationId) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  }
  if (!priceId && !amount) {
    return NextResponse.json({ error: 'Either priceId or amount is required' }, { status: 400 });
  }

  const finalEntityId   = entityId   || `ghl-${Date.now()}`;
  const finalEntityType = entityType || 'transaction';

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

  // ── If a priceId is provided, check whether it is recurring ──────────────
  if (priceId) {
    let price;
    try {
      price = await getPrice(priceId, stripeAccount.stripeAccountId);
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

  // ── No priceId → plain amount PaymentIntent ───────────────────────────────
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

  return NextResponse.json({
    clientSecret:    intent.client_secret,
    paymentIntentId: intent.id,
    publishableKey:  stripeAccount.publishableKey,
    stripeAccountId: stripeAccount.stripeAccountId,
    mode:            'payment',
  });
}
