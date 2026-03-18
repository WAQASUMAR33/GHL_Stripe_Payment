/**
 * POST /api/payments/status  — GHL queryUrl handler
 * GET  /api/payments/status  — internal PaymentIntent status lookup
 * ---------------------------------------------------------------------------
 * GHL POSTs { type, apiKey, locationId, ... } for all payment operations.
 * apiKey = GHL_CLIENT_SECRET (our shared secret GHL sends back on every call).
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getPaymentIntent, createRefund } from '@/lib/stripe';
import { getStripeAccount, getPaymentEventByIntentId } from '@/lib/tokenStore';

// ── POST: GHL queryUrl ────────────────────────────────────────────────────────

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { type, apiKey, locationId } = body;

  if (!apiKey || apiKey !== process.env.GHL_CLIENT_SECRET) {
    console.warn('[queryUrl] Invalid apiKey');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  console.log(`[queryUrl] type=${type} locationId=${locationId} body:`, JSON.stringify(body));

  switch (type) {

    case 'verify': {
      const { chargeId } = body;
      if (!chargeId) return NextResponse.json({ failed: true });

      // GHL doesn't always send locationId — look it up from our DB using the PI ID
      let resolvedLocationId = locationId;
      let stripeAccountId;
      if (!resolvedLocationId) {
        const event = await getPaymentEventByIntentId(chargeId);
        resolvedLocationId = event?.locationId ?? null;
        stripeAccountId    = event?.stripeAccountId ?? null;
      }

      let stripeAccount = resolvedLocationId ? await getStripeAccount(resolvedLocationId) : null;
      if (!stripeAccount && stripeAccountId) {
        // Minimal fallback — just need the stripeAccountId to query Stripe
        stripeAccount = { stripeAccountId };
      }

      console.log(`[queryUrl/verify] chargeId=${chargeId} locationId=${resolvedLocationId} stripeAccountId=${stripeAccount?.stripeAccountId}`);

      if (!stripeAccount) return NextResponse.json({ failed: true });
      try {
        const intent = await getPaymentIntent(chargeId, stripeAccount.stripeAccountId);
        if (intent.status === 'succeeded') return NextResponse.json({ success: true });
        if (['canceled', 'payment_failed'].includes(intent.status)) return NextResponse.json({ failed: true });
        return NextResponse.json({ success: false });
      } catch (err) {
        console.error('[queryUrl/verify]', err.message);
        return NextResponse.json({ failed: true });
      }
    }

    case 'refund': {
      const { chargeId, amount } = body;
      const stripeAccount = await getStripeAccount(locationId);
      if (!stripeAccount) return NextResponse.json({ success: false, message: 'No Stripe account' });
      try {
        const refund = await createRefund({
          paymentIntentId: chargeId,
          stripeAccountId: stripeAccount.stripeAccountId,
          amount: amount ? Math.round(amount * 100) : undefined,
        });
        return NextResponse.json({ success: true, id: refund.id, amount: refund.amount / 100, currency: refund.currency, message: 'Refund successful' });
      } catch (err) {
        console.error('[queryUrl/refund]', err.message);
        return NextResponse.json({ success: false, message: err.message });
      }
    }

    case 'list_payment_methods':
      return NextResponse.json([]);

    case 'charge_payment':
      return NextResponse.json({ success: false, failed: true, message: 'Off-session charges not supported' });

    case 'create_subscription':
      return NextResponse.json({ success: false, failed: true, message: 'Manual subscriptions not supported' });

    case 'cancel_subscription':
      return NextResponse.json({ status: 'canceled' });

    default:
      console.warn('[queryUrl] Unknown type:', type);
      return NextResponse.json({ error: `Unknown type: ${type}` }, { status: 400 });
  }
}

// ── GET: internal status check ────────────────────────────────────────────────

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const locationId      = searchParams.get('locationId');
  const paymentIntentId = searchParams.get('paymentIntentId');

  if (!locationId || !paymentIntentId) {
    return NextResponse.json({ error: 'locationId and paymentIntentId are required' }, { status: 400 });
  }

  const stripeAccount = await getStripeAccount(locationId);
  if (!stripeAccount) {
    return NextResponse.json({ error: 'Stripe account not connected' }, { status: 404 });
  }

  try {
    const intent = await getPaymentIntent(paymentIntentId, stripeAccount.stripeAccountId);
    return NextResponse.json({ id: intent.id, status: intent.status, amount: intent.amount, currency: intent.currency, metadata: intent.metadata });
  } catch (err) {
    console.error('[payment-status/GET]', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
