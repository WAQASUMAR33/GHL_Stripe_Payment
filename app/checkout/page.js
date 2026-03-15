/**
 * /checkout
 * ---------------------------------------------------------------------------
 * GHL custom payment provider checkout iframe.
 *
 * Flow:
 *  1. Page loads → sends custom_provider_ready to parent (GHL) repeatedly
 *     until GHL responds (guards against race where parent isn't ready yet)
 *  2. GHL sends payment_initiate_props with amount, currency, publishableKey, etc.
 *  3. We call /api/payments/create-intent to get a Stripe clientSecret
 *  4. Customer completes payment via Stripe Elements
 *  5. On success → send custom_element_success_response { chargeId: PI_ID }
 *  6. On failure → send custom_element_error_response { error: { description } }
 *
 * Embedded inside a GHL order form iframe — no outer card wrapper needed.
 * Height is reported to the parent after each render so GHL can resize the iframe.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';

// ── helpers ──────────────────────────────────────────────────────────────────

function postToParent(msg) {
  window.parent.postMessage(msg, '*');
}

/** Tell GHL how tall our iframe content is so it can resize the frame. */
function reportHeight() {
  const h = document.documentElement.scrollHeight;
  postToParent({ type: 'set_height', height: h });
}

// ── CheckoutForm ──────────────────────────────────────────────────────────────

function CheckoutForm({ onSuccess, onError }) {
  const stripe   = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  // Report height after Stripe Elements renders
  useEffect(() => {
    const t = setTimeout(reportHeight, 300);
    return () => clearTimeout(t);
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!stripe || !elements) return;

    setLoading(true);
    setError(null);

    const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required',
    });

    if (stripeError) {
      setError(stripeError.message);
      setLoading(false);
      onError?.(stripeError.message);
    } else if (paymentIntent?.status === 'succeeded') {
      setLoading(false);
      onSuccess?.(paymentIntent.id);
    } else {
      setError('Payment did not complete. Please try again.');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PaymentElement onReady={reportHeight} />
      {error && (
        <div style={{ color: '#dc2626', fontSize: 14, padding: '10px 12px', background: '#fef2f2', borderRadius: 6 }}>
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={!stripe || loading}
        style={{
          background: loading ? '#6366f1' : '#4f46e5',
          color: '#fff',
          border: 'none',
          padding: '14px 0',
          borderRadius: 8,
          fontSize: 16,
          fontWeight: 600,
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: (!stripe || loading) ? 0.7 : 1,
          transition: 'background .2s',
        }}
      >
        {loading ? 'Processing…' : 'Pay Now'}
      </button>
    </form>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CheckoutPage() {
  const [stripePromise, setStripePromise] = useState(null);
  const [clientSecret,  setClientSecret]  = useState(null);
  const [error,         setError]         = useState(null);
  const [ready,         setReady]         = useState(false);
  const initDataRef = useRef(null);

  useEffect(() => {
    // ── Report height whenever the DOM changes ──
    const ro = new ResizeObserver(reportHeight);
    ro.observe(document.documentElement);

    // ── Send custom_provider_ready repeatedly until GHL responds ──
    window.parent.postMessage(JSON.stringify({ type: 'custom_provider_ready', loaded: true }), '*');
    const readyInterval = setInterval(() => {
      if (!initDataRef.current) {
        window.parent.postMessage(JSON.stringify({ type: 'custom_provider_ready', loaded: true }), '*');
      }
    }, 500);

    // ── Listen for payment_initiate_props from GHL ──
    function onMessage(event) {
      const msg = event.data;
      if (!msg || msg.type !== 'payment_initiate_props') return;
      if (initDataRef.current) return; // already handled
      clearInterval(readyInterval);
      initDataRef.current = msg;
      initPayment(msg);
    }

    window.addEventListener('message', onMessage);
    return () => {
      clearInterval(readyInterval);
      window.removeEventListener('message', onMessage);
      ro.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function initPayment(msg) {
    const {
      publishableKey,
      amount,       // GHL sends as decimal: 100.00 = $100
      currency,
      locationId,
      transactionId,
      orderId,
      entityId,     // GHL may use this key directly
      entityType,
      contactId,
    } = msg;

    const resolvedCurrency   = currency   || 'usd';
    const resolvedEntityId   = entityId   || transactionId || orderId || `ghl-${Date.now()}`;
    const resolvedEntityType = entityType || 'transaction';
    const amountCents        = Math.round(Number(amount) * 100);

    fetch('/api/payments/create-intent', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locationId,
        amount:     amountCents,
        currency:   resolvedCurrency.toLowerCase(),
        entityId:   resolvedEntityId,
        entityType: resolvedEntityType,
        metadata: {
          ghlTransactionId: transactionId ?? null,
          ghlOrderId:       orderId       ?? null,
          ghlEntityId:      entityId      ?? null,
          ghlContactId:     contactId     ?? null,
        },
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setError(data.error); return; }
        setClientSecret(data.clientSecret);
        setStripePromise(
          loadStripe(publishableKey || data.publishableKey, {
            ...(data.stripeAccountId ? { stripeAccount: data.stripeAccountId } : {}),
          })
        );
        setReady(true);
      })
      .catch((err) => setError(err.message));
  }

  function handleSuccess(paymentIntentId) {
    postToParent({ type: 'custom_element_success_response', chargeId: paymentIntentId });
  }

  function handleError(description) {
    postToParent({ type: 'custom_element_error_response', error: { description } });
  }

  return (
    <>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: transparent;
          padding: 16px;
        }
      `}</style>

      {error && (
        <div style={{ color: '#dc2626', fontSize: 14, padding: '10px 12px', background: '#fef2f2', borderRadius: 6, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {!error && !ready && (
        <p style={{ textAlign: 'center', color: '#6b7280', padding: '24px 0', fontSize: 14 }}>
          Loading payment form…
        </p>
      )}

      {ready && clientSecret && stripePromise && (
        <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: 'stripe' } }}>
          <CheckoutForm onSuccess={handleSuccess} onError={handleError} />
        </Elements>
      )}
    </>
  );
}
