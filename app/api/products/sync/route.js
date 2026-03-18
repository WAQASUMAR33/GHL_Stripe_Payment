/**
 * POST /api/products/sync
 * ---------------------------------------------------------------------------
 * Fetch products from GHL's catalog and create any missing ones in Stripe.
 * GHL does not fire product webhooks to custom payment providers, so this
 * endpoint must be called manually (e.g. from the dashboard Sync button).
 *
 * Body: { locationId }
 *
 * Returns: { synced: number, skipped: number, errors: string[] }
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { ghlClient } from '@/lib/ghl';
import { getStripeAccount } from '@/lib/tokenStore';
import { listProducts, createProduct, createPrice } from '@/lib/stripe';

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { locationId } = body;
  if (!locationId) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  }

  const stripeAccount = await getStripeAccount(locationId);
  if (!stripeAccount) {
    return NextResponse.json({ error: 'No Stripe account connected for this location' }, { status: 404 });
  }

  // ── Fetch GHL products ────────────────────────────────────────────────────
  let ghlProducts = [];
  try {
    const client = await ghlClient(locationId);
    const { data } = await client.get(`/products/?locationId=${locationId}&limit=100`);
    ghlProducts = data?.products ?? data?.list ?? data ?? [];
    if (!Array.isArray(ghlProducts)) ghlProducts = [];
  } catch (err) {
    console.error('[products/sync] GHL fetch error:', err.response?.status, err.response?.data ?? err.message);
    return NextResponse.json(
      { error: `Failed to fetch GHL products: ${err.response?.data?.message ?? err.message}` },
      { status: 502 }
    );
  }

  if (ghlProducts.length === 0) {
    return NextResponse.json({ synced: 0, skipped: 0, errors: [], message: 'No products found in GHL' });
  }

  // ── Fetch existing Stripe products to avoid duplicates (match by name) ───
  let existingStripeProducts = [];
  try {
    const result = await listProducts(stripeAccount.stripeAccountId, { limit: 100 });
    existingStripeProducts = result.data ?? [];
  } catch (err) {
    console.warn('[products/sync] Could not fetch existing Stripe products:', err.message);
  }
  const existingNames = new Set(existingStripeProducts.map((p) => p.name.toLowerCase().trim()));

  // ── Sync each GHL product to Stripe ──────────────────────────────────────
  let synced  = 0;
  let skipped = 0;
  const errors = [];

  for (const gp of ghlProducts) {
    const name = gp.name ?? gp.title ?? '';
    if (!name) { skipped++; continue; }

    if (existingNames.has(name.toLowerCase().trim())) {
      skipped++;
      continue;
    }

    // GHL price: gp.price is usually in dollars (e.g. 9.99), convert to cents
    const priceAmount = gp.price != null ? Math.round(Number(gp.price) * 100) : 0;
    const currency    = (gp.currency ?? 'usd').toLowerCase();
    const description = gp.description ?? gp.shortDescription ?? undefined;

    try {
      const stripeProduct = await createProduct({
        stripeAccountId: stripeAccount.stripeAccountId,
        name,
        description,
      });

      if (priceAmount > 0) {
        const isRecurring = gp.recurring ?? gp.type === 'recurring';
        await createPrice({
          stripeAccountId: stripeAccount.stripeAccountId,
          productId:       stripeProduct.id,
          amount:          priceAmount,
          currency,
          recurring: isRecurring ? { interval: gp.interval ?? 'month' } : undefined,
        });
      }

      synced++;
    } catch (err) {
      console.error('[products/sync] Failed to create Stripe product:', name, err.message);
      errors.push(`"${name}": ${err.message}`);
    }
  }

  return NextResponse.json({ synced, skipped, errors, total: ghlProducts.length });
}
