/**
 * GET /api/payments/transactions?locationId=xxx&limit=50&offset=0&status=SUCCESS
 * ---------------------------------------------------------------------------
 * List payment transactions for a location from the database.
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { listPaymentEvents } from '@/lib/tokenStore';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('locationId');
  const limit      = parseInt(searchParams.get('limit')  ?? '50', 10);
  const offset     = parseInt(searchParams.get('offset') ?? '0',  10);
  const status     = searchParams.get('status') ?? undefined;

  if (!locationId) {
    return NextResponse.json({ error: 'locationId is required' }, { status: 400 });
  }

  const events = await listPaymentEvents(locationId, { limit, offset, status });
  return NextResponse.json({ transactions: events });
}
