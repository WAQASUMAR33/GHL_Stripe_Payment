/**
 * POST /api/payments/create-intent
 * ---------------------------------------------------------------------------
 * Create a Stripe PaymentIntent on behalf of a connected merchant account.
 * Called by the frontend checkout page or by GHL's payment trigger.
 *
 * Request body:
 * {
 *   locationId:          string,   // GHL location ID
 *   amount:              number,   // amount in smallest unit (e.g. cents for USD)
 *   currency:            string,   // ISO code e.g. "usd"
 *   entityId:            string,   // GHL invoice/order ID
 *   entityType:          string,   // "invoice" | "order" | "subscription"
 *   applicationFeeRate?: number,   // platform fee as decimal e.g. 0.02 = 2%
 *   metadata?:           object
 * }
 *
 * Response:
 * { clientSecret: string, paymentIntentId: string, publishableKey: string }
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createPaymentIntent } from '@/lib/stripe';
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
    entityId,
    entityType,
    applicationFeeRate = 0,
    metadata = {},
  } = body;

  if (!locationId || !amount || !entityId || !entityType) {
    return NextResponse.json(
      { error: 'locationId, amount, entityId, and entityType are required' },
      { status: 400 }
    );
  }

  const stripeAccount = await getStripeAccount(locationId);
  if (!stripeAccount) {
    return NextResponse.json(
      { error: 'This location has not connected a Stripe account yet' },
      { status: 404 }
    );
  }

  const applicationFeeAmount =
    applicationFeeRate > 0 ? Math.round(amount * applicationFeeRate) : 0;

  let intent;
  try {
    intent = await createPaymentIntent({
      amount,
      currency,
      stripeAccountId: stripeAccount.stripeAccountId,
      applicationFeeAmount: applicationFeeAmount || undefined,
      metadata: {
        locationId,
        entityId,
        entityType,
        ...metadata,
      },
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
  });
}
