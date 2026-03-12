/**
 * /checkout?locationId=xxx&entityId=yyy&entityType=invoice&amount=5000&currency=usd
 * ---------------------------------------------------------------------------
 * Customer-facing checkout page.
 * Fetches a PaymentIntent from our API, then renders Stripe Elements.
 * This page can be embedded in a GHL funnel / website via iframe.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useEffect, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';

// ─── Inner form component ─────────────────────────────────────────────────────

function CheckoutForm({ onSuccess }) {
  const stripe   = useStripe();
  const elements = useElements();

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!stripe || !elements) return;

    setLoading(true);
    setError(null);

    const { error: stripeError } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: window.location.href + '&payment=complete',
      },
      redirect: 'if_required',
    });

    if (stripeError) {
      setError(stripeError.message);
      setLoading(false);
    } else {
      setSuccess(true);
      setLoading(false);
      onSuccess?.();
    }
  }

  if (success) {
    return (
      <div className="success-box">
        <div className="success-icon">✓</div>
        <h2>Payment Successful!</h2>
        <p>Your payment has been processed. You will receive a confirmation shortly.</p>
      </div>
    );
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

// ─── Page component ───────────────────────────────────────────────────────────

export default function CheckoutPage() {
  const [stripePromise, setStripePromise] = useState(null);
  const [clientSecret, setClientSecret]   = useState(null);
  const [error, setError]                 = useState(null);
  const [params, setParams]               = useState({});

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const p = {
      locationId:  sp.get('locationId'),
      entityId:    sp.get('entityId'),
      entityType:  sp.get('entityType') ?? 'invoice',
      amount:      parseInt(sp.get('amount') ?? '0', 10),
      currency:    sp.get('currency') ?? 'usd',
    };
    setParams(p);

    if (!p.locationId || !p.entityId || !p.amount) {
      setError('Missing required checkout parameters.');
      return;
    }

    fetch('/api/payments/create-intent', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(p),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setError(data.error); return; }
        setClientSecret(data.clientSecret);
        setStripePromise(loadStripe(data.publishableKey, { stripeAccount: undefined }));
      })
      .catch((err) => setError(err.message));
  }, []);

  const amountDisplay = params.amount
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: params.currency ?? 'usd' })
        .format(params.amount / 100)
    : '';

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
        .success-box { text-align: center; padding: 20px; }
        .success-icon { font-size: 48px; color: #16a34a; background: #f0fdf4; border-radius: 50%; width: 72px; height: 72px; line-height: 72px; margin: 0 auto 16px; }
        .success-box h2 { color: #166534; font-size: 20px; margin-bottom: 8px; }
        .success-box p { color: #6b7280; font-size: 14px; }
        .loading-text { text-align: center; color: #6b7280; padding: 32px 0; }
      `}</style>

      <div className="checkout-wrapper">
        <div className="checkout-card">
          <div className="checkout-header">
            <h1>Complete Your Payment</h1>
            {amountDisplay && <div className="amount">{amountDisplay}</div>}
          </div>

          {error && <div className="error-msg">{error}</div>}

          {!error && !clientSecret && (
            <p className="loading-text">Loading payment details…</p>
          )}

          {clientSecret && stripePromise && (
            <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: 'stripe' } }}>
              <CheckoutForm />
            </Elements>
          )}
        </div>
      </div>
    </>
  );
}
