/**
 * PUT    /api/products/[id]  – update a product
 * DELETE /api/products/[id]  – archive a product
 * ---------------------------------------------------------------------------
 * Body for PUT:
 * { locationId, name?, description? }
 *
 * Body for DELETE:
 * { locationId }
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { updateProduct } from '@/lib/stripe';
import { getStripeAccount } from '@/lib/tokenStore';

export async function PUT(request, { params }) {
  const { id: productId } = await params;
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { locationId, name, description } = body;
  if (!locationId) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  }

  const stripeAccount = await getStripeAccount(locationId);
  if (!stripeAccount) {
    return NextResponse.json({ error: 'No Stripe account connected for this location' }, { status: 404 });
  }

  try {
    const product = await updateProduct(stripeAccount.stripeAccountId, productId, { name, description });
    return NextResponse.json({ product });
  } catch (err) {
    console.error('[products PUT]', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  const { id: productId } = await params;
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

  try {
    // Archive (deactivate) rather than hard-delete — Stripe recommends this
    const product = await updateProduct(stripeAccount.stripeAccountId, productId, { active: false });
    return NextResponse.json({ product });
  } catch (err) {
    console.error('[products DELETE]', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
