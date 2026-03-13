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
import { getStripeAccount } from '@/lib/tokenStore';

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
    name:        'ChangeWorks',
    description: 'Accept payments via Stripe Connect',
    paymentsUrl: `${appUrl}/checkout`,
    queryUrl:    `${appUrl}/api/payments/status`,
    imageUrl:    'https://upload.wikimedia.org/wikipedia/commons/b/ba/Stripe_Logo%2C_revised_2016.svg',
  };

  // Try primary endpoint — locationId as query param
  try {
    const { data } = await client.post(`/payments/custom-provider/provider?locationId=${locationId}`, providerBody);
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

  // ── Step 3: connect for BOTH modes (test + live) ─────────────────────────
  // Use the location-level _id returned by createProvider — NOT the
  // marketplace-level provider ID — so GHL can enable the right record.
  const providerId =
      results.createProvider?.data?._id
    ?? results.createProvider?.data?.id
    ?? results.createProviderAlt?.data?._id
    ?? results.createProviderAlt?.data?.id;

  results.detectedProviderId = providerId ?? null;

  // ── Step 3: connect with correct body format ─────────────────────────────
  // GHL expects { live: { liveMode, apiKey, publishableKey }, test: { ... } }
  const stripeAccount  = await getStripeAccount(locationId);
  const apiKey         = process.env.GHL_CLIENT_SECRET;
  const publishableKey = stripeAccount?.publishableKey || process.env.STRIPE_PUBLISHABLE_KEY;

  results.envCheck = {
    hasGhlClientSecret:    !!process.env.GHL_CLIENT_SECRET,
    hasStripePublishable:  !!process.env.STRIPE_PUBLISHABLE_KEY,
    hasStripeAccount:      !!stripeAccount,
    stripeAccountPkPrefix: stripeAccount?.publishableKey?.slice(0, 7) ?? null,
  };

  if (!publishableKey || !apiKey) {
    results.connect = { ok: false, error: 'GHL_CLIENT_SECRET or STRIPE_PUBLISHABLE_KEY missing from env vars' };
    return NextResponse.json(results, { status: 200 });
  }

  const connectBody = {
    live: { liveMode: true,  apiKey, publishableKey, enabled: true },
    test: { liveMode: false, apiKey, publishableKey, enabled: true },
  };

  try {
    const { data } = await client.post(
      `/payments/custom-provider/connect?locationId=${locationId}`,
      connectBody
    );
    results.connect = { ok: true, data };
  } catch (err) {
    results.connect = {
      ok:     false,
      status: err.response?.status,
      error:  err.response?.data ?? err.message,
    };
  }

  return NextResponse.json(results, { status: 200 });
}
