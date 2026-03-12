/**
 * GET /api/locations
 * ---------------------------------------------------------------------------
 * List all GHL locations connected to this app, with Stripe account status.
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { listGHLLocations, getStripeAccount } from '@/lib/tokenStore';

export async function GET() {
  const locationIds = await listGHLLocations();

  const locations = await Promise.all(
    locationIds.map(async (id) => {
      const stripe = await getStripeAccount(id);
      return {
        locationId:      id,
        ghlConnected:    true,
        stripeConnected: !!stripe,
        stripeAccountId: stripe?.stripeAccountId ?? null,
        livemode:        stripe?.livemode ?? false,
      };
    })
  );

  return NextResponse.json({ locations });
}
