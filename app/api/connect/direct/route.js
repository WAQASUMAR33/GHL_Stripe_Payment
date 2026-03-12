/**
 * POST /api/connect/direct
 * ---------------------------------------------------------------------------
 * Connect an existing Stripe account directly by account ID (acct_xxx).
 * Useful when onboarding is already complete and OAuth flow is not needed.
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getConnectedAccount } from '@/lib/stripe';
import { saveStripeAccount } from '@/lib/tokenStore';
import { connectGHLPaymentProvider } from '@/lib/ghl';

export async function POST(request) {
  try {
    const { locationId, stripeAccountId } = await request.json();

    if (!locationId)     return NextResponse.json({ error: 'locationId is required' },     { status: 400 });
    if (!stripeAccountId) return NextResponse.json({ error: 'stripeAccountId is required' }, { status: 400 });

    if (!stripeAccountId.startsWith('acct_')) {
      return NextResponse.json({ error: 'Invalid Stripe account ID — must start with acct_' }, { status: 400 });
    }

    // Verify the account exists and retrieve its details
    let account;
    try {
      account = await getConnectedAccount(stripeAccountId);
    } catch (err) {
      return NextResponse.json(
        { error: `Stripe account not found: ${err.message}` },
        { status: 404 }
      );
    }

    // Save to DB (no OAuth tokens — direct connection)
    await saveStripeAccount(locationId, {
      stripeAccountId: account.id,
      accessToken:     'direct',   // marker — no OAuth token
      refreshToken:    null,
      publishableKey:  '',
      livemode:        account.livemode ?? false,
      tokenType:       'direct',
      scope:           null,
    });

    // Activate the payment provider in GHL (best-effort)
    try {
      await connectGHLPaymentProvider(locationId, account.livemode ?? false);
      console.log(`[connect/direct] GHL payment provider connected for ${locationId}`);
    } catch (err) {
      console.warn('[connect/direct] connectGHLPaymentProvider failed (non-fatal):', err.message);
    }

    return NextResponse.json({
      connected:        true,
      stripeAccountId:  account.id,
      displayName:      account.display_name || account.business_profile?.name || '',
      email:            account.email,
      chargesEnabled:   account.charges_enabled,
      payoutsEnabled:   account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      livemode:         account.livemode,
    });

  } catch (err) {
    console.error('[connect/direct]', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
