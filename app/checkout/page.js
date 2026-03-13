/**
 * /checkout
 * ---------------------------------------------------------------------------
 * GHL custom payment provider checkout iframe.
 *
 * Flow:
 *  1. Page loads → sends custom_provider_ready to parent (GHL)
 *  2. GHL sends payment_initiate_props with amount, currency, publishableKey, etc.
 *  3. We call /api/payments/create-intent to get a Stripe clientSecret
 *  4. Customer completes payment via Stripe Elements
 *  5. On success → send custom_element_success_response { chargeId: PI_ID }
 *  6. On failure → send custom_element_error_response { error: { description } }
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

// ── CheckoutForm ──────────────────────────────────────────────────────────────

function CheckoutForm({ onSuccess, onError }) {
  const stripe   = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

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
    <form onSubmit={handleSubmit} className="payment-form">
      <PaymentElement />
      {error && <div className="error-msg">{error}</div>}
      <button type="submit" disabled={!stripe || loading} className="pay-btn">
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
  const [amountDisplay, setAmountDisplay] = useState('');
  const [ready,         setReady]         = useState(false);
  const initDataRef = useRef(null);

  // Step 1: send custom_provider_ready and listen for payment_initiate_props
  useEffect(() => {
    // Send immediately, then retry every 500 ms until GHL responds
    // (GHL may not be listening yet on the first tick)
    postToParent({ type: 'custom_provider_ready', loaded: true });
    const readyInterval = setInterval(() => {
      if (!initDataRef.current) {
        postToParent({ type: 'custom_provider_ready', loaded: true });
      }
    }, 500);

    function onMessage(event) {
      const msg = event.data;
      if (!msg || msg.type !== 'payment_initiate_props') return;
      clearInterval(readyInterval);

      const {
        publishableKey,
        amount,           // decimal e.g. 100.00 = $100
        currency = 'usd',
        locationId,
        transactionId,
        orderId,
        entityId,         // GHL may send this directly
        entityType,       // GHL may send this directly
        contactId,
      } = msg;

      initDataRef.current = msg;

      // GHL sends amount as a decimal (e.g. 100.00 = $100.00)
      const amountCents = Math.round(Number(amount) * 100);

      setAmountDisplay(
        new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: (currency || 'usd').toUpperCase(),
        }).format(Number(amount))
      );

      // Resolve entityId — GHL may send it under different keys
      const resolvedEntityId   = entityId || transactionId || orderId || `ghl-${Date.now()}`;
      const resolvedEntityType = entityType || 'transaction';

      // Create PaymentIntent on our server
      fetch('/api/payments/create-intent', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationId,
          amount:     amountCents,
          currency:   (currency || 'usd').toLowerCase(),
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
          // Use the publishableKey GHL sent (connected account's pk)
          setStripePromise(
            loadStripe(publishableKey || data.publishableKey, {
              ...(data.stripeAccountId ? { stripeAccount: data.stripeAccountId } : {}),
            })
          );
          setReady(true);
        })
        .catch((err) => setError(err.message));
    }

    window.addEventListener('message', onMessage);
    return () => {
      clearInterval(readyInterval);
      window.removeEventListener('message', onMessage);
    };
  }, []);

  function handleSuccess(paymentIntentId) {
    postToParent({
      type:     'custom_element_success_response',
      chargeId: paymentIntentId,
    });
  }

  function handleError(description) {
    postToParent({
      type:  'custom_element_error_response',
      error: { description },
    });
  }

  return (
    <>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f6f9; }
        .checkout-wrapper { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
        .checkout-card { background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,.08); padding: 40px; width: 100%; max-width: 480px; }
        .checkout-header { text-align: center; margin-bottom: 32px; }
        .checkout-header h1 { font-size: 22px; font-weight: 700; color: #1a1a2e; }
        .checkout-header .amount { font-size: 36px; font-weight: 800; color: #4f46e5; margin-top: 8px; }
        .payment-form { display: flex; flex-direction: column; gap: 20px; }
        .pay-btn { background: #4f46e5; color: #fff; border: none; padding: 14px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background .2s; }
        .pay-btn:hover:not(:disabled) { background: #4338ca; }
        .pay-btn:disabled { opacity: .6; cursor: not-allowed; }
        .error-msg { color: #dc2626; font-size: 14px; padding: 10px; background: #fef2f2; border-radius: 6px; }
        .loading-text { text-align: center; color: #6b7280; padding: 32px 0; }
      `}</style>

      <div className="checkout-wrapper">
        <div className="checkout-card">
          <div className="checkout-header">
            <h1>Complete Your Payment</h1>
            {amountDisplay && <div className="amount">{amountDisplay}</div>}
          </div>

          {error && <div className="error-msg">{error}</div>}

          {!error && !ready && (
            <p className="loading-text">Loading payment details…</p>
          )}

          {ready && clientSecret && stripePromise && (
            <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: 'stripe' } }}>
              <CheckoutForm onSuccess={handleSuccess} onError={handleError} />
            </Elements>
          )}
        </div>
      </div>
    </>
  );
}
