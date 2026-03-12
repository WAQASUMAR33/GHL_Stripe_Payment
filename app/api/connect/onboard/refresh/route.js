/**
 * GET /api/connect/onboard/refresh?locationId=xxx
 * ---------------------------------------------------------------------------
 * Stripe calls this when the onboarding link expires.
 * We generate a fresh Account Link and redirect the merchant.
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createAccountLink } from '@/lib/stripe';
import { getStripeAccount } from '@/lib/tokenStore';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('locationId');

  if (!locationId) {
    return NextResponse.redirect(`${process.env.APP_URL}/dashboard?error=missing_location`);
  }

  const stored = await getStripeAccount(locationId);
  if (!stored) {
    return NextResponse.redirect(`${process.env.APP_URL}/dashboard?error=not_connected`);
  }

  const returnUrl  = `${process.env.APP_URL}/dashboard?locationId=${locationId}&onboarding=complete`;
  const refreshUrl = `${process.env.APP_URL}/api/connect/onboard/refresh?locationId=${locationId}`;

  try {
    const link = await createAccountLink(stored.stripeAccountId, returnUrl, refreshUrl);
    return NextResponse.redirect(link.url);
  } catch (err) {
    console.error('[onboard/refresh]', err.message);
    return NextResponse.redirect(`${process.env.APP_URL}/dashboard?error=onboard_refresh_failed`);
  }
}
