/**
 * GET /api/payments/status?locationId=xxx&paymentIntentId=yyy
 * ---------------------------------------------------------------------------
 * Retrieve the current status of a PaymentIntent from the connected account.
 * ---------------------------------------------------------------------------
 */

import { NextResponse } from 'next/server';
import { getPaymentIntent } from '@/lib/stripe';
import { getStripeAccount } from '@/lib/tokenStore';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const locationId      = searchParams.get('locationId');
  const paymentIntentId = searchParams.get('paymentIntentId');

  if (!locationId || !paymentIntentId) {
    return NextResponse.json({ error: 'locationId and paymentIntentId are required' }, { status: 400 });
  }

  const stripeAccount = await getStripeAccount(locationId);
  if (!stripeAccount) {
    return NextResponse.json({ error: 'Stripe account not connected for this location' }, { status: 404 });
  }

  try {
    const intent = await getPaymentIntent(paymentIntentId, stripeAccount.stripeAccountId);
    return NextResponse.json({
      id:       intent.id,
      status:   intent.status,
      amount:   intent.amount,
      currency: intent.currency,
      metadata: intent.metadata,
    });
  } catch (err) {
    console.error('[payment-status]', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
