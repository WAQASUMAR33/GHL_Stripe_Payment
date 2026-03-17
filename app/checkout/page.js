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
          background: (!stripe || loading) ? '#a5b4fc' : '#4f46e5',
          color: '#fff',
          border: 'none',
          padding: '14px 0',
          borderRadius: 8,
          fontSize: 15,
          fontWeight: 600,
          cursor: (!stripe || loading) ? 'not-allowed' : 'pointer',
          transition: 'background .2s',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          width: '100%',
        }}
      >
        {loading ? (
          <>
            <span style={{ display: 'inline-block', width: 16, height: 16, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            Processing…
          </>
        ) : (
          <>🔒 Pay Now</>
        )}
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
  const [debugLog,      setDebugLog]      = useState(['page loaded']);
  const initDataRef = useRef(null);

  function addLog(msg) {
    console.log('[checkout]', msg);
    setDebugLog((prev) => [...prev.slice(-9), msg]);
  }

  useEffect(() => {
    // ── Report height whenever the DOM changes ──
    const ro = new ResizeObserver(reportHeight);
    ro.observe(document.documentElement);

    // ── Send custom_provider_ready repeatedly until GHL responds ──
    addLog('sending custom_provider_ready…');
    window.parent.postMessage(JSON.stringify({ type: 'custom_provider_ready', loaded: true }), '*');
    const readyInterval = setInterval(() => {
      if (!initDataRef.current) {
        window.parent.postMessage(JSON.stringify({ type: 'custom_provider_ready', loaded: true }), '*');
      }
    }, 500);

    // ── Listen for payment_initiate_props from GHL ──
    function onMessage(event) {
      // GHL may send message as a JSON string or a plain object — handle both
      let msg = event.data;
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg); } catch { return; }
      }
      addLog(`msg received: type=${msg?.type ?? 'unknown'} origin=${event.origin}`);
      if (!msg || msg.type !== 'payment_initiate_props') return;
      if (initDataRef.current) return; // already handled
      clearInterval(readyInterval);
      initDataRef.current = msg;
      addLog(`payment_initiate_props: amount=${msg.amount} currency=${msg.currency} locationId=${msg.locationId}`);
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
      // Customer bio — GHL may send these at top level or inside a contact object
      contact,
      email,
      firstName,
      lastName,
      phone,
    } = msg;

    // Resolve customer fields from GHL's contact object or top-level fields
    const contactObj      = contact ?? {};
    const customerEmail   = email       || contactObj.email       || null;
    const customerPhone   = phone       || contactObj.phone       || null;
    const customerFirst   = firstName   || contactObj.firstName   || null;
    const customerLast    = lastName    || contactObj.lastName    || null;
    const customerName    = (customerFirst || customerLast)
      ? [customerFirst, customerLast].filter(Boolean).join(' ')
      : null;

    const resolvedCurrency   = currency   || 'usd';
    const resolvedEntityId   = entityId   || transactionId || orderId || `ghl-${Date.now()}`;
    const resolvedEntityType = entityType || 'transaction';
    const amountCents        = Math.round(Number(amount) * 100);

    addLog(`calling create-intent: ${amountCents} ${resolvedCurrency} locationId=${locationId}`);

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
          ghlTransactionId: transactionId  ?? null,
          ghlOrderId:       orderId        ?? null,
          ghlEntityId:      entityId       ?? null,
          ghlContactId:     contactId      ?? null,
          customerName,
          customerEmail,
          customerPhone,
        },
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { addLog(`create-intent error: ${data.error}`); setError(data.error); return; }
        addLog(`create-intent ok, loading Stripe…`);
        setClientSecret(data.clientSecret);
        setStripePromise(
          loadStripe(publishableKey || data.publishableKey, {
            ...(data.stripeAccountId ? { stripeAccount: data.stripeAccountId } : {}),
          })
        );
        setReady(true);
      })
      .catch((err) => { addLog(`create-intent fetch error: ${err.message}`); setError(err.message); });
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
        html, body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: transparent;
          min-height: 100%;
        }
        .checkout-wrapper {
          display: flex;
          justify-content: center;
          align-items: flex-start;
          padding: 24px 16px;
        }
        .checkout-card {
          width: 100%;
          max-width: 520px;
          background: #ffffff;
          border-radius: 12px;
          box-shadow: 0 4px 24px rgba(0,0,0,0.08);
          padding: 32px 28px;
        }
        .checkout-header {
          text-align: center;
          margin-bottom: 24px;
        }
        .checkout-header .lock-icon {
          font-size: 22px;
          margin-bottom: 6px;
        }
        .checkout-header h2 {
          font-size: 18px;
          font-weight: 700;
          color: #111827;
          margin-bottom: 4px;
        }
        .checkout-header p {
          font-size: 13px;
          color: #6b7280;
        }
        .divider {
          border: none;
          border-top: 1px solid #e5e7eb;
          margin: 20px 0;
        }
      `}</style>

      <div className="checkout-wrapper">
        <div className="checkout-card">
          <div className="checkout-header">
            <div className="lock-icon">🔒</div>
            <h2>Secure Payment</h2>
            <p>Your payment info is encrypted and secure</p>
          </div>

          <hr className="divider" />

          {error && (
            <div style={{ color: '#dc2626', fontSize: 14, padding: '10px 12px', background: '#fef2f2', borderRadius: 8, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>⚠️</span> {error}
            </div>
          )}

          {!error && !ready && (
            <div style={{ textAlign: 'center', padding: '32px 0' }}>
              <div style={{ display: 'inline-block', width: 28, height: 28, border: '3px solid #e5e7eb', borderTopColor: '#4f46e5', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              <p style={{ marginTop: 12, color: '#6b7280', fontSize: 14 }}>Loading payment form…</p>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {ready && clientSecret && stripePromise && (
            <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: 'stripe', variables: { borderRadius: '8px', colorPrimary: '#4f46e5' } } }}>
              <CheckoutForm onSuccess={handleSuccess} onError={handleError} />
            </Elements>
          )}

          <p style={{ textAlign: 'center', marginTop: 20, fontSize: 12, color: '#9ca3af' }}>
            🔐 256-bit SSL encrypted · Powered by Stripe
          </p>
        </div>
      </div>
    </>
  );
}
