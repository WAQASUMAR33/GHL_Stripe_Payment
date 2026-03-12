/**
 * GET /api/connect/account?locationId=xxx
 * ---------------------------------------------------------------------------
 * Return the Stripe Connect account status for a GHL location.
 * Used by the dashboard to show connection state.
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getConnectedAccount } from '@/lib/stripe';
import { getStripeAccount } from '@/lib/tokenStore';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('locationId');

  if (!locationId) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  }

  const stored = await getStripeAccount(locationId);
  if (!stored) {
    return NextResponse.json({ connected: false });
  }

  try {
    const account = await getConnectedAccount(stored.stripeAccountId);
    return NextResponse.json({
      connected:       true,
      stripeAccountId: account.id,
      displayName:     account.display_name || account.business_profile?.name || '',
      email:           account.email,
      country:         account.country,
      currency:        account.default_currency,
      livemode:        stored.livemode,
      chargesEnabled:  account.charges_enabled,
      payoutsEnabled:  account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
    });
  } catch (err) {
    console.error('[connect/account]', err.message);
    return NextResponse.json({ connected: false, error: err.message }, { status: 500 });
  }
}
