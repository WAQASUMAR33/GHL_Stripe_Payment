/**
 * GET /api/auth/stripe
 * ---------------------------------------------------------------------------
 * Step 1 of Stripe Connect OAuth: redirect merchant to Stripe.
 * Requires ?locationId=xxx so we know which GHL location is connecting.
 * ---------------------------------------------------------------------------
 */

import { NextResponse } from 'next/server';
import { buildStripeConnectOAuthUrl } from '@/lib/stripe';
import { generateStateToken } from '@/lib/crypto';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('locationId');
  const email      = searchParams.get('email') ?? undefined;

  if (!locationId) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  }

  const state = generateStateToken({ locationId, source: 'stripe-connect' });
  const authUrl = buildStripeConnectOAuthUrl(state, email);

  return NextResponse.redirect(authUrl);
}
