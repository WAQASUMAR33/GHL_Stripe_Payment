/**
 * POST /api/payments/refund
 * ---------------------------------------------------------------------------
 * Issue a full or partial refund on a Stripe PaymentIntent.
 *
 * Request body:
 * {
 *   locationId:      string,
 *   paymentIntentId: string,
 *   amount?:         number,   // cents — omit for full refund
 *   reason?:         string    // 'duplicate' | 'fraudulent' | 'requested_by_customer'
 * }
 * ---------------------------------------------------------------------------
 */

import { NextResponse } from 'next/server';
import { createRefund } from '@/lib/stripe';
import { getStripeAccount } from '@/lib/tokenStore';

export async function POST(request) {
  const { locationId, paymentIntentId, amount, reason } = await request.json();

  if (!locationId || !paymentIntentId) {
    return NextResponse.json({ error: 'locationId and paymentIntentId are required' }, { status: 400 });
  }

  const stripeAccount = await getStripeAccount(locationId);
  if (!stripeAccount) {
    return NextResponse.json({ error: 'Stripe account not connected for this location' }, { status: 404 });
  }

  try {
    const refund = await createRefund({
      paymentIntentId,
      stripeAccountId: stripeAccount.stripeAccountId,
      amount,
      reason,
    });

    return NextResponse.json({ refundId: refund.id, status: refund.status, amount: refund.amount });
  } catch (err) {
    console.error('[refund]', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
