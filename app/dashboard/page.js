/**
 * /dashboard?locationId=xxx
 * ---------------------------------------------------------------------------
 * Admin dashboard for managing GHL ↔ Stripe Connect integration.
 * Shows connection status, lets you initiate/disconnect Stripe Connect,
 * and displays recent activity.
 * ---------------------------------------------------------------------------
 */

'use client';

import { useEffect, useState, useCallback } from 'react';

export default function DashboardPage() {
  const [locationId, setLocationId]       = useState('');
  const [ghlConnected, setGhlConnected]   = useState(false);
  const [stripeStatus, setStripeStatus]   = useState(null);
  const [loading, setLoading]             = useState(false);
  const [statusMsg, setStatusMsg]         = useState('');
  const [error, setError]                 = useState('');

  // ── Read query params on mount ────────────────────────────────────────────
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const loc = sp.get('locationId') ?? '';
    setLocationId(loc);

    const connected = sp.get('connected');
    if (connected === 'ghl')    { setGhlConnected(true); setStatusMsg('GHL account connected!'); }
    if (connected === 'stripe') { setStatusMsg('Stripe account connected!'); }
    if (sp.get('onboarding') === 'complete') setStatusMsg('Stripe onboarding complete!');
    if (sp.get('error'))        { setError(`Error: ${sp.get('error')}`); }

    // Remove params from URL bar
    window.history.replaceState({}, '', '/dashboard' + (loc ? `?locationId=${loc}` : ''));
  }, []);

  // ── Fetch Stripe account status ───────────────────────────────────────────
  const fetchStripeStatus = useCallback(async (locId) => {
    if (!locId) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/connect/account?locationId=${locId}`);
      const d = await r.json();
      setStripeStatus(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (locationId) fetchStripeStatus(locationId);
  }, [locationId, fetchStripeStatus]);

  // ── Actions ───────────────────────────────────────────────────────────────

  function connectGHL() {
    window.location.href = `/api/auth/ghl${locationId ? `?locationId=${locationId}` : ''}`;
  }

  function connectStripe() {
    if (!locationId) { setError('Enter a Location ID first.'); return; }
    window.location.href = `/api/auth/stripe?locationId=${locationId}`;
  }

  async function startOnboarding() {
    setLoading(true);
    try {
      const r = await fetch('/api/connect/onboard', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ locationId }),
      });
      const d = await r.json();
      if (d.url) window.location.href = d.url;
      else setError(d.error ?? 'Failed to create onboarding link');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function disconnectStripe() {
    if (!confirm('Disconnect Stripe account? Payments will stop working.')) return;
    setLoading(true);
    try {
      await fetch('/api/auth/stripe/disconnect', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ locationId }),
      });
      setStripeStatus(null);
      setStatusMsg('Stripe account disconnected.');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const isFullyOnboarded =
    stripeStatus?.connected &&
    stripeStatus?.chargesEnabled &&
    stripeStatus?.detailsSubmitted;

  return (
    <>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f6f9; color: #1a1a2e; }
        .layout { display: flex; min-height: 100vh; }
        .sidebar { width: 240px; background: #1a1a2e; color: #fff; padding: 24px 16px; flex-shrink: 0; }
        .sidebar h2 { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
        .sidebar p  { font-size: 12px; color: #94a3b8; margin-bottom: 32px; }
        .nav-item { padding: 10px 12px; border-radius: 8px; margin-bottom: 4px; font-size: 14px; cursor: pointer; color: #cbd5e1; }
        .nav-item.active { background: #4f46e5; color: #fff; }
        .main { flex: 1; padding: 40px; }
        .page-title { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
        .page-sub   { color: #6b7280; font-size: 14px; margin-bottom: 32px; }
        .card { background: #fff; border-radius: 12px; padding: 28px; margin-bottom: 24px; box-shadow: 0 1px 8px rgba(0,0,0,.06); }
        .card-title { font-size: 16px; font-weight: 600; margin-bottom: 20px; display: flex; align-items: center; gap: 8px; }
        .badge { display: inline-flex; align-items: center; gap-4px; padding: 3px 10px; border-radius: 99px; font-size: 12px; font-weight: 600; }
        .badge.green  { background: #dcfce7; color: #166534; }
        .badge.red    { background: #fee2e2; color: #991b1b; }
        .badge.yellow { background: #fef9c3; color: #854d0e; }
        .badge.gray   { background: #f1f5f9; color: #475569; }
        .input-group { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
        .input-group input { flex: 1; min-width: 220px; padding: 10px 14px; border: 1.5px solid #e2e8f0; border-radius: 8px; font-size: 14px; outline: none; }
        .input-group input:focus { border-color: #4f46e5; }
        .btn { padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; transition: all .15s; }
        .btn-primary   { background: #4f46e5; color: #fff; }
        .btn-primary:hover:not(:disabled) { background: #4338ca; }
        .btn-secondary { background: #f1f5f9; color: #475569; }
        .btn-secondary:hover:not(:disabled) { background: #e2e8f0; }
        .btn-danger    { background: #fee2e2; color: #991b1b; }
        .btn-danger:hover:not(:disabled)   { background: #fecaca; }
        .btn:disabled  { opacity: .5; cursor: not-allowed; }
        .status-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
        .stat-box   { background: #f8fafc; border-radius: 10px; padding: 18px; }
        .stat-label { font-size: 12px; color: #6b7280; margin-bottom: 6px; }
        .stat-value { font-size: 18px; font-weight: 700; color: #1a1a2e; }
        .alert  { padding: 12px 16px; border-radius: 8px; font-size: 14px; margin-bottom: 20px; }
        .alert-success { background: #dcfce7; color: #166534; }
        .alert-error   { background: #fee2e2; color: #991b1b; }
        .divider { border: none; border-top: 1.5px solid #f1f5f9; margin: 20px 0; }
        .actions-row { display: flex; gap: 12px; flex-wrap: wrap; }
        .copy-url { font-family: monospace; font-size: 13px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 14px; word-break: break-all; color: #475569; margin-top: 8px; }
      `}</style>

      <div className="layout">
        {/* Sidebar */}
        <div className="sidebar">
          <h2>PayProvider</h2>
          <p>GHL + Stripe Connect</p>
          <div className="nav-item active">Dashboard</div>
          <div className="nav-item">Transactions</div>
          <div className="nav-item">Settings</div>
        </div>

        {/* Main */}
        <div className="main">
          <h1 className="page-title">Integration Dashboard</h1>
          <p className="page-sub">Connect your GHL location to a Stripe account to start accepting payments.</p>

          {statusMsg && <div className="alert alert-success">{statusMsg}</div>}
          {error     && <div className="alert alert-error">{error}</div>}

          {/* Step 1: GHL Connection */}
          <div className="card">
            <div className="card-title">
              Step 1 — Connect GHL Location
              <span className={`badge ${locationId ? 'green' : 'gray'}`}>
                {locationId ? 'Connected' : 'Not connected'}
              </span>
            </div>

            <div className="input-group">
              <input
                type="text"
                placeholder="Paste your GHL Location ID"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              />
              <button className="btn btn-primary" onClick={connectGHL}>
                Connect GHL
              </button>
            </div>

            {locationId && (
              <p style={{ fontSize: 13, color: '#6b7280' }}>
                Location ID: <strong>{locationId}</strong>
              </p>
            )}
          </div>

          {/* Step 2: Stripe Connect */}
          <div className="card">
            <div className="card-title">
              Step 2 — Connect Stripe Account
              <span className={`badge ${
                isFullyOnboarded ? 'green' : stripeStatus?.connected ? 'yellow' : 'gray'
              }`}>
                {isFullyOnboarded
                  ? 'Active'
                  : stripeStatus?.connected
                  ? 'Onboarding incomplete'
                  : 'Not connected'}
              </span>
            </div>

            {!stripeStatus?.connected && (
              <div className="actions-row">
                <button className="btn btn-primary" onClick={connectStripe} disabled={!locationId || loading}>
                  Connect with Stripe
                </button>
              </div>
            )}

            {stripeStatus?.connected && (
              <>
                <div className="status-row" style={{ marginBottom: 20 }}>
                  <div className="stat-box">
                    <div className="stat-label">Account</div>
                    <div className="stat-value" style={{ fontSize: 14 }}>
                      {stripeStatus.displayName || stripeStatus.stripeAccountId}
                    </div>
                  </div>
                  <div className="stat-box">
                    <div className="stat-label">Charges Enabled</div>
                    <div className="stat-value">{stripeStatus.chargesEnabled ? '✅ Yes' : '❌ No'}</div>
                  </div>
                  <div className="stat-box">
                    <div className="stat-label">Payouts Enabled</div>
                    <div className="stat-value">{stripeStatus.payoutsEnabled ? '✅ Yes' : '❌ No'}</div>
                  </div>
                  <div className="stat-box">
                    <div className="stat-label">Mode</div>
                    <div className="stat-value">
                      <span className={`badge ${stripeStatus.livemode ? 'green' : 'yellow'}`}>
                        {stripeStatus.livemode ? 'Live' : 'Test'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="actions-row">
                  {!isFullyOnboarded && (
                    <button className="btn btn-primary" onClick={startOnboarding} disabled={loading}>
                      Complete Stripe Onboarding
                    </button>
                  )}
                  <button className="btn btn-danger" onClick={disconnectStripe} disabled={loading}>
                    Disconnect Stripe
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Webhook / Integration Info */}
          <div className="card">
            <div className="card-title">Integration Endpoints</div>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
              Register these URLs in your GHL Marketplace app and Stripe Dashboard.
            </p>

            <div style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <strong>GHL Webhook URL</strong>
                <div className="copy-url">{process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin}/api/webhooks/ghl</div>
              </div>
              <div>
                <strong>Stripe Webhook URL</strong>
                <div className="copy-url">{process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin}/api/webhooks/stripe</div>
              </div>
              <div>
                <strong>GHL OAuth Redirect URI</strong>
                <div className="copy-url">{process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin}/api/auth/ghl/callback</div>
              </div>
              <div>
                <strong>Stripe Connect Redirect URI</strong>
                <div className="copy-url">{process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin}/api/auth/stripe/callback</div>
              </div>
              {locationId && (
                <div>
                  <strong>Checkout URL (for this location)</strong>
                  <div className="copy-url">
                    {window.location.origin}/checkout?locationId={locationId}&entityId=ORDER_ID&entityType=invoice&amount=9900&currency=usd
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
