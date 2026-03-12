/**
 * POST /api/auth/stripe/disconnect
 * ---------------------------------------------------------------------------
 * Deauthorize a Stripe Connect account for a GHL location.
 * Body: { locationId: string }
 * ---------------------------------------------------------------------------
 */

import { NextResponse } from 'next/server';
import { deauthorizeStripeAccount } from '@/lib/stripe';
import { getStripeAccount, saveStripeAccount } from '@/lib/tokenStore';

export async function POST(request) {
  const { locationId } = await request.json();
  if (!locationId) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  }

  const account = await getStripeAccount(locationId);
  if (!account) {
    return NextResponse.json({ error: 'No Stripe account found for this location' }, { status: 404 });
  }

  try {
    await deauthorizeStripeAccount(account.stripeAccountId);
  } catch (err) {
    console.error('[Stripe Disconnect]', err.message);
    // Continue — might already be deauthorized on Stripe's side
  }

  // Clear from store
  await saveStripeAccount(locationId, null);

  return NextResponse.json({ success: true });
}
