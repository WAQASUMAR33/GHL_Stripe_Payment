/**
 * POST /api/connect/onboard
 * ---------------------------------------------------------------------------
 * Generate a Stripe Account Link for hosted onboarding (or re-onboarding).
 * Returns a one-time URL to redirect the merchant to.
 *
 * Body: { locationId: string }
 * Response: { url: string }
 * ---------------------------------------------------------------------------
 */

import { NextResponse } from 'next/server';
import { createAccountLink } from '@/lib/stripe';
import { getStripeAccount } from '@/lib/tokenStore';

export async function POST(request) {
  const { locationId } = await request.json();

  if (!locationId) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  }

  const stored = await getStripeAccount(locationId);
  if (!stored) {
    return NextResponse.json(
      { error: 'Stripe account not connected. Complete OAuth first.' },
      { status: 404 }
    );
  }

  const returnUrl  = `${process.env.APP_URL}/dashboard?locationId=${locationId}&onboarding=complete`;
  const refreshUrl = `${process.env.APP_URL}/api/connect/onboard/refresh?locationId=${locationId}`;

  try {
    const link = await createAccountLink(stored.stripeAccountId, returnUrl, refreshUrl);
    return NextResponse.json({ url: link.url });
  } catch (err) {
    console.error('[connect/onboard]', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
