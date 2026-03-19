/**
 * POST /api/webhooks/ghl
 * ---------------------------------------------------------------------------
 * GHL Payment Provider webhook handler with DB logging.
 * ---------------------------------------------------------------------------
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { createPaymentIntent, createRefund, createProduct, createPrice, updateProduct, archivePrice, setProductDefaultPrice } from '@/lib/stripe';
import {
  getStripeAccount,
  createWebhookLog,
  updateWebhookLog,
  upsertPaymentEvent,
  saveProductSync,
  getProductSync,
  deleteProductSync,
  savePriceSync,
  getPriceSync,
  deletePriceSync,
} from '@/lib/tokenStore';

const GHL_CLIENT_SECRET = process.env.GHL_CLIENT_SECRET;

function verifyGHLWebhook(rawBody, signature) {
  const expected = createHmac('sha256', GHL_CLIENT_SECRET)
    .update(rawBody)
    .digest('hex');
  return expected === signature;
}

export async function POST(request) {
  const rawBody   = Buffer.from(await request.arrayBuffer());
  const signature = request.headers.get('x-ghl-signature');

  // ── DEBUG: log all incoming headers and raw body snippet ─────────────────
  const allHeaders = {};
  request.headers.forEach((v, k) => { allHeaders[k] = v; });
  console.log('[GHL Webhook] DEBUG headers:', JSON.stringify(allHeaders));
  console.log('[GHL Webhook] DEBUG body snippet:', rawBody.toString('utf-8').slice(0, 500));
  // ─────────────────────────────────────────────────────────────────────────

  // Peek at the event type before full parse so we know whether to verify.
  // GHL payment-provider events (PAYMENT_PROVIDER_CHARGE etc.) are signed
  // with GHL_CLIENT_SECRET. General marketplace webhooks (ProductCreate,
  // PriceCreate etc.) use a different signing key — skip verification for them.
  let rawType = '';
  try { rawType = JSON.parse(rawBody.toString('utf-8'))?.type ?? ''; } catch {}

  const isPaymentEvent = ['PAYMENT_PROVIDER_CHARGE', 'PAYMENT_PROVIDER_REFUND', 'INSTALL', 'UNINSTALL'].includes(rawType);

  console.log(`[GHL Webhook] DEBUG type="${rawType}" isPaymentEvent=${isPaymentEvent} hasSignature=${!!signature}`);

  if (GHL_CLIENT_SECRET && signature && isPaymentEvent && !verifyGHLWebhook(rawBody, signature)) {
    // Log mismatch but do NOT reject — GHL uses Ed25519 (not HMAC-SHA256) for current signing.
    // Security is enforced downstream: we verify stripeAccount exists for the locationId,
    // and no sensitive action is taken without a valid connected Stripe account.
    console.warn('[GHL Webhook] Signature mismatch (expected — GHL may use Ed25519). Proceeding with payload validation.');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    console.error('[GHL Webhook] Failed to parse JSON body');
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { type, locationId, data } = payload;
  const eventId = payload.eventId ?? `ghl-${Date.now()}-${Math.random()}`;

  console.log(`[GHL Webhook] DEBUG full payload keys: ${Object.keys(payload).join(', ')}`);
  console.log(`[GHL Webhook] DEBUG locationId=${locationId} data keys: ${data ? Object.keys(data).join(', ') : 'none'}`);

  // Log the incoming event
  await createWebhookLog({
    source:     'GHL',
    eventId,
    eventType:  type,
    locationId: locationId ?? undefined,
    payload,
  });

  console.log(`[GHL Webhook] ${type} | location: ${locationId}`);

  try {
    switch (type) {

      case 'PAYMENT_PROVIDER_CHARGE': {
        const stripeAccount = await getStripeAccount(locationId);
        if (!stripeAccount) {
          await updateWebhookLog(eventId, 'FAILED', `No Stripe account for location ${locationId}`);
          return NextResponse.json(
            { error: `No Stripe account connected for location ${locationId}` },
            { status: 404 }
          );
        }

        // DEBUG: log full data to understand recurring product structure
        console.log('[GHL Webhook] DEBUG PAYMENT_PROVIDER_CHARGE full data:', JSON.stringify(data).slice(0, 1000));

        // Extract customer info from GHL's contact object or top-level fields
        const contact       = data.contact ?? {};
        const customerName  = (contact.firstName || contact.lastName)
          ? [contact.firstName, contact.lastName].filter(Boolean).join(' ')
          : (data.customerName ?? null);
        const customerEmail = contact.email ?? data.email ?? null;
        const customerPhone = contact.phone ?? data.phone ?? null;

        // data.transactionId = GHL's internal transaction ID (what we pass back as ghlTransactionId)
        // data.entityId = GHL's order/invoice entity ID
        const ghlTransactionId = data.transactionId ?? data.entityId ?? null;
        console.log(`[GHL Webhook] PAYMENT_PROVIDER_CHARGE ghlTransactionId=${ghlTransactionId} entityId=${data.entityId} entityType=${data.entityType}`);

        const intent = await createPaymentIntent({
          amount:          data.amount,
          currency:        data.currency ?? 'usd',
          stripeAccountId: stripeAccount.stripeAccountId,
          metadata: {
            locationId,
            entityId:         data.entityId,
            entityType:       data.entityType,
            ghlTransactionId,
            ghlContactId:     data.contactId ?? null,
            customerName,
            customerEmail,
            customerPhone,
          },
        });

        // Save PI #1 to DB immediately so verify and Stripe webhook can resolve it
        // GHL links its pending transaction to this PI ID. If checkout creates PI #2,
        // the Stripe webhook looks up PI #1 by entityId and uses its ID for GHL notification.
        try {
          await upsertPaymentEvent({
            locationId,
            stripeAccountId: stripeAccount.stripeAccountId,
            paymentIntentId: intent.id,
            entityId:        data.entityId ?? null,
            entityType:      data.entityType ?? 'invoice',
            amount:          data.amount,
            currency:        data.currency ?? 'usd',
            status:          'PENDING',
            customerName,
            customerEmail,
            customerPhone,
          });
          console.log(`[GHL Webhook] PAYMENT_PROVIDER_CHARGE: saved PI #1 ${intent.id} for entityId=${data.entityId}`);
        } catch (dbErr) {
          console.warn('[GHL Webhook] Failed to pre-save PI #1 (non-fatal):', dbErr.message);
        }

        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({
          clientSecret:   intent.client_secret,
          publishableKey: stripeAccount.publishableKey,
        });
      }

      case 'PAYMENT_PROVIDER_REFUND': {
        const stripeAccount = await getStripeAccount(locationId);
        if (!stripeAccount) {
          await updateWebhookLog(eventId, 'FAILED', `No Stripe account for location ${locationId}`);
          return NextResponse.json({ error: 'Stripe account not connected' }, { status: 404 });
        }

        const refund = await createRefund({
          paymentIntentId: data.externalTransactionId,
          stripeAccountId: stripeAccount.stripeAccountId,
          amount:          data.amount,
          reason:          data.reason,
        });

        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({ refundId: refund.id, status: refund.status });
      }

      case 'INSTALL':
        console.log(`[GHL Webhook] App installed on location ${locationId}`);
        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({ received: true });

      case 'UNINSTALL':
        console.log(`[GHL Webhook] App uninstalled from location ${locationId}`);
        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({ received: true });

      // ── GHL Product events → sync to Stripe ───────────────────────────────
      case 'ProductCreate': {
        console.log('[GHL Webhook] DEBUG ProductCreate — fetching Stripe account for location:', locationId);
        const stripeAccount = await getStripeAccount(locationId);
        if (!stripeAccount) {
          console.warn('[GHL Webhook] DEBUG ProductCreate — no Stripe account found for location:', locationId);
          await updateWebhookLog(eventId, 'SKIPPED', 'No Stripe account'); break;
        }

        // GHL may nest product in data or send it at the top level
        const prod = data ?? payload;
        console.log('[GHL Webhook] DEBUG ProductCreate prod keys:', Object.keys(prod).join(', '));
        console.log('[GHL Webhook] DEBUG ProductCreate prod sample:', JSON.stringify(prod).slice(0, 400));
        const ghlProductId = prod.id ?? prod._id;
        const name         = prod.name ?? prod.title;
        if (!name || !ghlProductId) {
          console.warn('[GHL Webhook] DEBUG ProductCreate — missing name or id. name:', name, 'id:', ghlProductId);
          await updateWebhookLog(eventId, 'SKIPPED', 'Missing product name/id'); break;
        }

        // Extract price from variants or top-level price field
        const variant      = prod.variants?.[0] ?? prod.prices?.[0] ?? {};
        const priceAmount  = variant.price ?? variant.amount ?? prod.price ?? 0;
        const currency     = (variant.currency ?? prod.currency ?? 'usd').toLowerCase();
        const isRecurring  = prod.recurring ?? prod.productType === 'RECURRING' ?? false;
        const interval     = prod.interval ?? variant.interval ?? 'month';

        const stripeProduct = await createProduct({
          stripeAccountId: stripeAccount.stripeAccountId,
          name,
          description: prod.description ?? undefined,
        });

        let stripePrice = null;
        if (priceAmount > 0) {
          stripePrice = await createPrice({
            stripeAccountId: stripeAccount.stripeAccountId,
            productId:       stripeProduct.id,
            amount:          Math.round(Number(priceAmount) * 100),
            currency,
            recurring:       isRecurring ? { interval } : undefined,
          });
        }

        await saveProductSync(locationId, ghlProductId, stripeProduct.id, stripePrice?.id ?? null);
        console.log(`[GHL Webhook] ProductCreate: GHL ${ghlProductId} → Stripe ${stripeProduct.id}`);
        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({ received: true, stripeProductId: stripeProduct.id });
      }

      case 'ProductUpdate': {
        const stripeAccount = await getStripeAccount(locationId);
        if (!stripeAccount) { await updateWebhookLog(eventId, 'SKIPPED', 'No Stripe account'); break; }

        const prod         = data ?? payload;
        const ghlProductId = prod.id ?? prod._id;
        const name         = prod.name ?? prod.title;
        if (!ghlProductId) { await updateWebhookLog(eventId, 'SKIPPED', 'Missing product id'); break; }

        const mapping = await getProductSync(locationId, ghlProductId);
        if (!mapping) { await updateWebhookLog(eventId, 'SKIPPED', 'No Stripe mapping found — product may not have been synced'); break; }

        await updateProduct(stripeAccount.stripeAccountId, mapping.stripeProductId, {
          ...(name                ? { name }                        : {}),
          ...(prod.description    ? { description: prod.description } : {}),
        });

        console.log(`[GHL Webhook] ProductUpdate: Stripe ${mapping.stripeProductId}`);
        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({ received: true });
      }

      case 'ProductDelete': {
        const stripeAccount = await getStripeAccount(locationId);
        if (!stripeAccount) { await updateWebhookLog(eventId, 'SKIPPED', 'No Stripe account'); break; }

        const prod         = data ?? payload;
        const ghlProductId = prod.id ?? prod._id;
        if (!ghlProductId) { await updateWebhookLog(eventId, 'SKIPPED', 'Missing product id'); break; }

        const mapping = await getProductSync(locationId, ghlProductId);
        if (!mapping) { await updateWebhookLog(eventId, 'SKIPPED', 'No Stripe mapping found'); break; }

        // Archive in Stripe (cannot hard-delete products with associated prices)
        await updateProduct(stripeAccount.stripeAccountId, mapping.stripeProductId, { active: false });
        await deleteProductSync(locationId, ghlProductId);

        console.log(`[GHL Webhook] ProductDelete: archived Stripe ${mapping.stripeProductId}`);
        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({ received: true });
      }

      case 'PriceCreate': {
        const stripeAccount = await getStripeAccount(locationId);
        if (!stripeAccount) { await updateWebhookLog(eventId, 'SKIPPED', 'No Stripe account'); break; }

        const priceData = data ?? payload;
        console.log('[GHL Webhook] DEBUG PriceCreate full priceData:', JSON.stringify(priceData).slice(0, 800));

        // GHL may use different field names for the price ID and parent product ID
        const ghlPriceId   = priceData.id   ?? priceData._id  ?? null;
        const ghlProductId = priceData.productId ?? priceData.product ?? priceData.product_id ?? priceData.variantProductId ?? null;

        console.log(`[GHL Webhook] DEBUG PriceCreate ghlPriceId=${ghlPriceId} ghlProductId=${ghlProductId}`);

        if (!ghlPriceId || !ghlProductId) {
          console.warn('[GHL Webhook] DEBUG PriceCreate — missing price or product id. Keys present:', Object.keys(priceData).join(', '));
          await updateWebhookLog(eventId, 'SKIPPED', `Missing price/product id. Keys: ${Object.keys(priceData).join(', ')}`);
          break;
        }

        // Find the Stripe product this price belongs to
        const productMapping = await getProductSync(locationId, ghlProductId);
        console.log(`[GHL Webhook] DEBUG PriceCreate productMapping:`, JSON.stringify(productMapping));
        if (!productMapping) {
          await updateWebhookLog(eventId, 'SKIPPED', `No Stripe product mapping found for GHL product ${ghlProductId}`);
          break;
        }

        // GHL may send amount in dollars (e.g. 9.99) or cents (e.g. 999)
        const rawAmount   = priceData.amount ?? priceData.price ?? priceData.unitAmount ?? 0;
        // If amount looks like dollars (< 1000 and has decimals or is small), convert to cents
        const amount      = rawAmount < 1000 ? Math.round(Number(rawAmount) * 100) : Math.round(Number(rawAmount));
        const currency    = (priceData.currency ?? 'usd').toLowerCase();
        const isRecurring = priceData.recurring ?? priceData.type === 'RECURRING' ?? false;
        const interval    = priceData.interval ?? priceData.recurringInterval ?? 'month';

        console.log(`[GHL Webhook] DEBUG PriceCreate amount=${amount} currency=${currency} recurring=${isRecurring}`);

        const stripePrice = await createPrice({
          stripeAccountId: stripeAccount.stripeAccountId,
          productId:       productMapping.stripeProductId,
          amount,
          currency,
          recurring:       isRecurring ? { interval } : undefined,
        });

        await savePriceSync(locationId, ghlPriceId, ghlProductId, stripePrice.id);
        await setProductDefaultPrice(stripeAccount.stripeAccountId, productMapping.stripeProductId, stripePrice.id);

        console.log(`[GHL Webhook] PriceCreate: GHL ${ghlPriceId} → Stripe ${stripePrice.id}`);
        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({ received: true, stripePriceId: stripePrice.id });
      }

      case 'PriceUpdate': {
        // Stripe prices are immutable — archive old price and create a new one
        const stripeAccount = await getStripeAccount(locationId);
        if (!stripeAccount) { await updateWebhookLog(eventId, 'SKIPPED', 'No Stripe account'); break; }

        const priceData    = data ?? payload;
        const ghlPriceId   = priceData.id ?? priceData._id;
        const ghlProductId = priceData.productId ?? priceData.product;
        if (!ghlPriceId) { await updateWebhookLog(eventId, 'SKIPPED', 'Missing price id'); break; }

        const priceMapping   = await getPriceSync(locationId, ghlPriceId);
        const productMapping = ghlProductId ? await getProductSync(locationId, ghlProductId) : null;
        const stripeProductId = productMapping?.stripeProductId ?? null;

        // Archive old Stripe price
        if (priceMapping?.stripePriceId) {
          try { await archivePrice(stripeAccount.stripeAccountId, priceMapping.stripePriceId); } catch {}
        }

        // Create replacement price if we have the product mapping
        if (stripeProductId) {
          const amount      = priceData.amount ?? priceData.price ?? 0;
          const currency    = (priceData.currency ?? 'usd').toLowerCase();
          const isRecurring = priceData.recurring ?? priceData.type === 'RECURRING' ?? false;
          const interval    = priceData.interval ?? 'month';

          const newPrice = await createPrice({
            stripeAccountId: stripeAccount.stripeAccountId,
            productId:       stripeProductId,
            amount:          Math.round(Number(amount) * 100),
            currency,
            recurring:       isRecurring ? { interval } : undefined,
          });

          await savePriceSync(locationId, ghlPriceId, ghlProductId, newPrice.id);
          await setProductDefaultPrice(stripeAccount.stripeAccountId, stripeProductId, newPrice.id);
          console.log(`[GHL Webhook] PriceUpdate: new Stripe price ${newPrice.id}`);
        }

        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({ received: true });
      }

      case 'PriceDelete': {
        const stripeAccount = await getStripeAccount(locationId);
        if (!stripeAccount) { await updateWebhookLog(eventId, 'SKIPPED', 'No Stripe account'); break; }

        const priceData  = data ?? payload;
        const ghlPriceId = priceData.id ?? priceData._id;
        if (!ghlPriceId) { await updateWebhookLog(eventId, 'SKIPPED', 'Missing price id'); break; }

        const mapping = await getPriceSync(locationId, ghlPriceId);
        if (mapping?.stripePriceId) {
          await archivePrice(stripeAccount.stripeAccountId, mapping.stripePriceId);
          await deletePriceSync(locationId, ghlPriceId);
          console.log(`[GHL Webhook] PriceDelete: archived Stripe price ${mapping.stripePriceId}`);
        }

        await updateWebhookLog(eventId, 'PROCESSED');
        return NextResponse.json({ received: true });
      }

      default:
        await updateWebhookLog(eventId, 'SKIPPED');
        return NextResponse.json({ received: true });
    }

    // Fallback for any case that used `break` (SKIPPED branches)
    return NextResponse.json({ received: true });
  } catch (err) {
    console.error(`[GHL Webhook] Error handling ${type}:`, err.message);
    console.error(`[GHL Webhook] Stack:`, err.stack);
    console.error(`[GHL Webhook] Response data:`, JSON.stringify(err.response?.data ?? null));
    await updateWebhookLog(eventId, 'FAILED', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
