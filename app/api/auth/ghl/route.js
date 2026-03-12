/**
 * GET /api/auth/ghl
 * ---------------------------------------------------------------------------
 * Step 1 of GHL OAuth: redirect the user to GHL's authorization page.
 * Accepts optional query params: ?locationId=xxx to re-authenticate a specific location.
 * ---------------------------------------------------------------------------
 */

import { NextResponse } from 'next/server';
import { buildGHLOAuthUrl } from '@/lib/ghl';
import { generateStateToken } from '@/lib/crypto';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('locationId') ?? '';

  // Encode locationId hint into the CSRF state token
  const state = generateStateToken({ locationId, source: 'ghl-oauth' });

  const authUrl = buildGHLOAuthUrl(state);
  return NextResponse.redirect(authUrl);
}
