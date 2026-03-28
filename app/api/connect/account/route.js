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
import { getStripeAccount, saveStripeAccount } from '@/lib/tokenStore';
import { getPrisma } from '@/lib/db';
import Stripe from 'stripe';

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
    apiVersion: '2024-06-20',
  });
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('locationId');

  if (!locationId) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  }

  let stored = await getStripeAccount(locationId);
  console.log(`[connect/account] getStripeAccount(${locationId}):`, stored ? `found ${stored.stripeAccountId}` : 'null — attempting auto-connect');

  if (!stored) {
    // Auto-connect fallback: look up the org's stripeAccountId from the shared organizations table
    try {
      const db = await getPrisma();
      const rows = await db.$queryRaw`
        SELECT o.stripe_account_id
        FROM organizations o
        WHERE o.ghl_id = ${locationId}
          AND o.stripe_account_id IS NOT NULL
          AND o.stripe_account_id != ''
        UNION
        SELECT o.stripe_account_id
        FROM organizations o
        INNER JOIN ghl_accounts ga ON ga.organization_id = o.id
        WHERE ga.ghl_location_id = ${locationId}
          AND o.stripe_account_id IS NOT NULL
          AND o.stripe_account_id != ''
        LIMIT 1
      `;
      const stripeAccountId = rows?.[0]?.stripe_account_id ?? null;
      console.log(`[connect/account] Auto-connect org lookup for ${locationId}: stripeAccountId=${stripeAccountId}`);

      if (stripeAccountId) {
        try {
          await saveStripeAccount(locationId, {
            stripeAccountId,
            accessToken:    'direct',
            refreshToken:   null,
            publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
            livemode:       true,
            tokenType:      'direct',
            scope:          null,
          });
          stored = await getStripeAccount(locationId);
          console.log(`[connect/account] Auto-connected Stripe ${stripeAccountId} for location ${locationId}`);
        } catch (saveErr) {
          // P2002 = unique constraint (stripeAccountId already used by another location)
          // P2003 = FK constraint (no ghlConnection row for this locationId)
          console.error(`[connect/account] saveStripeAccount failed (code=${saveErr.code}):`, saveErr.message);
        }
      } else {
        console.warn(`[connect/account] No org with stripeAccountId found for locationId=${locationId}`);
      }
    } catch (err) {
      console.warn('[connect/account] Auto-connect fallback failed:', err.message);
    }
  }

  if (!stored) {
    return NextResponse.json({ connected: false });
  }

  try {
    const stripe  = getStripe();
    const account = await getConnectedAccount(stored.stripeAccountId);

    // Fetch balance and recent transaction count in parallel
    const [balance, recentIntents] = await Promise.all([
      stripe.balance.retrieve({ stripeAccount: stored.stripeAccountId }),
      stripe.paymentIntents.list({ limit: 100 }, { stripeAccount: stored.stripeAccountId }),
    ]);

    const availableBalance = balance.available?.reduce((sum, b) => sum + b.amount, 0) ?? 0;
    const pendingBalance   = balance.pending?.reduce((sum, b) => sum + b.amount, 0) ?? 0;
    const balanceCurrency  = balance.available?.[0]?.currency ?? account.default_currency ?? 'usd';

    const succeededCount = recentIntents.data.filter(p => p.status === 'succeeded').length;
    const totalCount     = recentIntents.data.length;

    return NextResponse.json({
      connected:        true,
      stripeAccountId:  account.id,
      displayName:      account.display_name || account.business_profile?.name || '',
      email:            account.email,
      website:          account.business_profile?.url || null,
      country:          account.country,
      currency:         account.default_currency,
      createdAt:        account.created,
      livemode:         stored.livemode,
      chargesEnabled:   account.charges_enabled,
      payoutsEnabled:   account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      availableBalance,
      pendingBalance,
      balanceCurrency,
      recentTxCount:    totalCount,
      succeededTxCount: succeededCount,
      hasMore:          recentIntents.has_more,
    });
  } catch (err) {
    console.error('[connect/account]', err.message);
    return NextResponse.json({ connected: false, error: err.message }, { status: 500 });
  }
}
