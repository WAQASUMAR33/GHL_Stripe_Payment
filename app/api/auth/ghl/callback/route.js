/**
 * GET /api/auth/ghl/callback
 * ---------------------------------------------------------------------------
 * Step 2 of GHL OAuth: GHL redirects back here with ?code=&state=
 * We exchange the code for tokens and store them.
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { exchangeGHLCode, createGHLPaymentProvider } from '@/lib/ghl';
import { saveGHLTokens } from '@/lib/tokenStore';
import { verifyStateToken } from '@/lib/crypto';

export async function GET(request) {
  // Derive base URL from the incoming request so redirects work even if
  // APP_URL env var is missing (prevents HTTP 500 on undefined/dashboard).
  const reqUrl  = new URL(request.url);
  const baseUrl = process.env.APP_URL || `${reqUrl.protocol}//${reqUrl.host}`;

  const { searchParams } = reqUrl;
  const code  = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  try {
    // Handle user-denied
    if (error) {
      return NextResponse.redirect(`${baseUrl}/dashboard?error=ghl_denied`);
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
      const detail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      console.error('[GHL OAuth] Token exchange failed:', detail);
      return NextResponse.redirect(
        `${baseUrl}/dashboard?error=ghl_token_exchange&detail=${encodeURIComponent(detail)}`
      );
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

    // Register this app as a payment provider for the location (best-effort)
    try {
      await createGHLPaymentProvider(locationId);
      console.log(`[GHL callback] Payment provider registered for ${locationId}`);
    } catch (err) {
      console.warn('[GHL callback] createGHLPaymentProvider failed (non-fatal):', err.message);
    }

    return NextResponse.redirect(
      `${baseUrl}/dashboard?locationId=${locationId}&connected=ghl`
    );

  } catch (err) {
    // Catch-all: never let an unhandled exception return HTTP 500
    console.error('[GHL callback] Unhandled error:', err.message);
    return NextResponse.redirect(
      `${baseUrl}/dashboard?error=ghl_callback_error&detail=${encodeURIComponent(err.message)}`
    );
  }
}
