/**
 * GET /api/auth/stripe/callback
 * ---------------------------------------------------------------------------
 * Step 2 of Stripe Connect OAuth: Stripe redirects back here with ?code=&state=
 * We exchange the code for the connected account credentials.
 * ---------------------------------------------------------------------------
 */

import { NextResponse } from 'next/server';
import { exchangeStripeCode } from '@/lib/stripe';
import { saveStripeAccount } from '@/lib/tokenStore';
import { verifyStateToken } from '@/lib/crypto';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const code  = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    return NextResponse.redirect(`${process.env.APP_URL}/dashboard?error=stripe_denied`);
  }

  if (!code || !state) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
  }

  // Verify CSRF state and recover locationId
  let stateData;
  try {
    stateData = verifyStateToken(state);
  } catch {
    return NextResponse.json({ error: 'Invalid state token' }, { status: 400 });
  }

  const { locationId } = stateData;
  if (!locationId) {
    return NextResponse.json({ error: 'No locationId in state' }, { status: 400 });
  }

  // Exchange code
  let oauthToken;
  try {
    oauthToken = await exchangeStripeCode(code);
  } catch (err) {
    console.error('[Stripe OAuth] Token exchange failed:', err.message);
    return NextResponse.redirect(
      `${process.env.APP_URL}/dashboard?error=stripe_token_exchange&locationId=${locationId}`
    );
  }

  // Persist
  await saveStripeAccount(locationId, {
    stripeAccountId: oauthToken.stripe_user_id,
    accessToken:     oauthToken.access_token,
    refreshToken:    oauthToken.refresh_token,
    publishableKey:  oauthToken.stripe_publishable_key,
    livemode:        oauthToken.livemode,
    tokenType:       oauthToken.token_type,
    scope:           oauthToken.scope,
  });

  return NextResponse.redirect(
    `${process.env.APP_URL}/dashboard?locationId=${locationId}&connected=stripe`
  );
}
