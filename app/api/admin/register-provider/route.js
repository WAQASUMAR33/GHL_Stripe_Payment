/**
 * POST /api/admin/register-provider
 * ---------------------------------------------------------------------------
 * Debug endpoint — manually registers + connects the GHL payment provider
 * for a location and returns the raw API response so errors are visible.
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { ghlClient, getValidAccessToken } from '@/lib/ghl';

export async function POST(request) {
  const { locationId } = await request.json();
  if (!locationId) return NextResponse.json({ error: 'locationId required' }, { status: 400 });

  const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  const results = {};

  // ── Step 1: verify token ──────────────────────────────────────────────────
  try {
    const token = await getValidAccessToken(locationId);
    results.token = token ? `ok (${token.slice(0, 12)}...)` : 'missing';
  } catch (err) {
    results.token = `ERROR: ${err.message}`;
    return NextResponse.json({ step: 'get-token', results }, { status: 500 });
  }

  const client = await ghlClient(locationId);

  // ── Step 2: create / update provider (try both endpoint variants) ─────────
  const providerBody = {
    altId:       locationId,
    altType:     'location',
    name:        'Stripe',
    description: 'Accept payments via Stripe Connect',
    paymentsUrl: `${appUrl}/checkout`,
    queryUrl:    `${appUrl}/api/payments/status`,
    imageUrl:    'https://upload.wikimedia.org/wikipedia/commons/b/ba/Stripe_Logo%2C_revised_2016.svg',
  };

  // Try primary endpoint
  try {
    const { data } = await client.post('/payments/custom-provider/provider', providerBody);
    results.createProvider = { ok: true, data };
  } catch (err) {
    results.createProvider = {
      ok:     false,
      status: err.response?.status,
      error:  err.response?.data ?? err.message,
    };
  }

  // Try alternate endpoint if first failed
  if (!results.createProvider.ok) {
    try {
      const { data } = await client.post('/payments/integrations/provider/whitelabel', providerBody);
      results.createProviderAlt = { ok: true, data };
    } catch (err) {
      results.createProviderAlt = {
        ok:     false,
        status: err.response?.status,
        error:  err.response?.data ?? err.message,
      };
    }
  }

  // ── Step 3: connect ───────────────────────────────────────────────────────
  try {
    const { data } = await client.post('/payments/custom-provider/connect', {
      locationId,
      liveMode: false,
    });
    results.connect = { ok: true, data };
  } catch (err) {
    results.connect = {
      ok:     false,
      status: err.response?.status,
      error:  err.response?.data ?? err.message,
    };
  }

  // Try alternate connect endpoint
  if (!results.connect.ok) {
    try {
      const { data } = await client.post('/payments/integrations/provider/whitelabel/connect', {
        locationId,
        liveMode: false,
      });
      results.connectAlt = { ok: true, data };
    } catch (err) {
      results.connectAlt = {
        ok:     false,
        status: err.response?.status,
        error:  err.response?.data ?? err.message,
      };
    }
  }

  return NextResponse.json(results, { status: 200 });
}
