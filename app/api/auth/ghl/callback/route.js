/**
 * GET /api/auth/ghl/callback
 * ---------------------------------------------------------------------------
 * Step 2 of GHL OAuth: GHL redirects back here with ?code=&state=
 * We exchange the code for tokens and store them.
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { exchangeGHLCode } from '@/lib/ghl';
import { saveGHLTokens } from '@/lib/tokenStore';
import { verifyStateToken } from '@/lib/crypto';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const code  = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  // Handle user-denied
  if (error) {
    return NextResponse.redirect(`${process.env.APP_URL}/dashboard?error=ghl_denied`);
  }

  if (!code) {
    return NextResponse.json({ error: 'Missing code' }, { status: 400 });
  }

  // Verify CSRF state only when present (GHL marketplace installs skip state)
  let stateData;
  if (state) {
    try {
      stateData = verifyStateToken(state);
    } catch {
      return NextResponse.json({ error: 'Invalid state token' }, { status: 400 });
    }
  }

  // Exchange code for tokens
  let tokenData;
  try {
    tokenData = await exchangeGHLCode(code);
  } catch (err) {
    console.error('[GHL OAuth] Token exchange failed:', err.response?.data ?? err.message);
    return NextResponse.redirect(`${process.env.APP_URL}/dashboard?error=ghl_token_exchange`);
  }

  const locationId = tokenData.locationId ?? stateData?.locationId;
  if (!locationId) {
    return NextResponse.json({ error: 'No locationId in token response' }, { status: 400 });
  }

  // Persist tokens
  await saveGHLTokens(locationId, {
    access_token:  tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at:    Date.now() + (tokenData.expires_in ?? 86400) * 1000,
    companyId:     tokenData.companyId,
    userId:        tokenData.userId,
    locationId,
  });

  // Redirect to dashboard with location context
  return NextResponse.redirect(
    `${process.env.APP_URL}/dashboard?locationId=${locationId}&connected=ghl`
  );
}
