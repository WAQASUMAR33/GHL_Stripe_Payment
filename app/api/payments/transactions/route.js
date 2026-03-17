/**
 * GET /api/payments/transactions?locationId=xxx&limit=50&startingAfter=pi_xxx
 * ---------------------------------------------------------------------------
 * List payment transactions for a location fetched live from the Stripe API.
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getStripeAccount } from '@/lib/tokenStore';
import { getPrisma } from '@/lib/db';
import Stripe from 'stripe';

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
    apiVersion: '2024-06-20',
  });
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const locationId     = searchParams.get('locationId');
  const limit          = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 100);
  const startingAfter  = searchParams.get('startingAfter') ?? undefined;

  if (!locationId) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  }

  const stripeAccount = await getStripeAccount(locationId);
  if (!stripeAccount) {
    return NextResponse.json({ error: 'No Stripe account connected for this location' }, { status: 404 });
  }

  const stripe = getStripe();

  const intents = await stripe.paymentIntents.list(
    {
      limit,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    },
    { stripeAccount: stripeAccount.stripeAccountId }
  );

  // Enrich with customer data stored in our DB (populated by the Stripe webhook
  // after pulling billing_details from the charge).
  const piIds = intents.data.map((pi) => pi.id);
  let dbEvents = [];
  try {
    const db = await getPrisma();
    dbEvents = await db.ghlPaymentEvent.findMany({
      where:  { paymentIntentId: { in: piIds } },
      select: { paymentIntentId: true, customerName: true, customerEmail: true, customerPhone: true },
    });
  } catch { /* non-critical — proceed without DB enrichment */ }

  const dbMap = Object.fromEntries(dbEvents.map((e) => [e.paymentIntentId, e]));

  const transactions = intents.data.map((pi) => {
    const db = dbMap[pi.id] ?? {};
    return {
      id:                 pi.id,
      amount:             pi.amount,
      currency:           pi.currency,
      status:             pi.status,
      created:            pi.created,
      description:        pi.description ?? null,
      entityId:           pi.metadata?.entityId   ?? null,
      entityType:         pi.metadata?.entityType ?? null,
      receiptEmail:       pi.receipt_email ?? null,
      paymentMethodTypes: pi.payment_method_types,
      latestCharge:       pi.latest_charge ?? null,
      // Customer bio — prefer billing_details (from DB) over metadata fallback
      customerName:  db.customerName  || pi.metadata?.customerName  || null,
      customerEmail: db.customerEmail || pi.metadata?.customerEmail || pi.receipt_email || null,
      customerPhone: db.customerPhone || pi.metadata?.customerPhone || null,
    };
  });

  return NextResponse.json({
    transactions,
    hasMore:    intents.has_more,
    nextCursor: intents.has_more ? intents.data[intents.data.length - 1]?.id : null,
  });
}
