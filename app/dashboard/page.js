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
  const [locationId, setLocationId]           = useState('');
  const [ghlConnected, setGhlConnected]       = useState(false);
  const [stripeStatus, setStripeStatus]       = useState(null);
  const [loading, setLoading]                 = useState(false);
  const [statusMsg, setStatusMsg]             = useState('');
  const [error, setError]                     = useState('');
  const [origin, setOrigin]                   = useState('');
  const [directAccountId, setDirectAccountId] = useState('');
  const [showDirect, setShowDirect]           = useState(false);
  const [tab, setTab]                         = useState('dashboard');
  const [transactions, setTransactions]       = useState([]);
  const [txLoading, setTxLoading]             = useState(false);
  const [txHasMore, setTxHasMore]             = useState(false);
  const [txCursor, setTxCursor]               = useState(null);

  // ── Read query params on mount ────────────────────────────────────────────
  useEffect(() => {
    setOrigin(process.env.NEXT_PUBLIC_APP_URL || window.location.origin);
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

  const fetchTransactions = useCallback(async (locId, cursor = null) => {
    if (!locId) return;
    setTxLoading(true);
    try {
      const url = `/api/payments/transactions?locationId=${locId}&limit=25${cursor ? `&startingAfter=${cursor}` : ''}`;
      const r = await fetch(url);
      const d = await r.json();
      if (cursor) {
        setTransactions(prev => [...prev, ...(d.transactions ?? [])]);
      } else {
        setTransactions(d.transactions ?? []);
      }
      setTxHasMore(d.hasMore ?? false);
      setTxCursor(d.nextCursor ?? null);
    } catch (e) {
      setError(e.message);
    } finally {
      setTxLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'transactions' && locationId) {
      setTxCursor(null);
      fetchTransactions(locationId, null);
    }
  }, [tab, locationId, fetchTransactions]);

  // ── Actions ───────────────────────────────────────────────────────────────

  function connectGHL() {
    window.location.href = `/api/auth/ghl${locationId ? `?locationId=${locationId}` : ''}`;
  }

  function connectStripe() {
    if (!locationId) { setError('Enter a Location ID first.'); return; }
    window.location.href = `/api/auth/stripe?locationId=${locationId}`;
  }

  async function connectDirect() {
    if (!locationId)      { setError('Enter a Location ID first.'); return; }
    if (!directAccountId) { setError('Enter a Stripe Account ID (acct_...).'); return; }
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/connect/direct', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ locationId, stripeAccountId: directAccountId.trim() }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error ?? 'Failed to connect account'); return; }
      setStripeStatus({ ...d });
      setStatusMsg(`Stripe account ${d.stripeAccountId} connected directly!`);
      setShowDirect(false);
      setDirectAccountId('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
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
          <div className={`nav-item ${tab === 'dashboard'     ? 'active' : ''}`} onClick={() => setTab('dashboard')}>Dashboard</div>
          <div className={`nav-item ${tab === 'transactions'  ? 'active' : ''}`} onClick={() => setTab('transactions')}>Transactions</div>
          <div className={`nav-item ${tab === 'settings'      ? 'active' : ''}`} onClick={() => setTab('settings')}>Settings</div>
        </div>

        {/* Main */}
        <div className="main">
          {tab === 'dashboard' && <>
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
              <>
                <div className="actions-row" style={{ marginBottom: 16 }}>
                  <button className="btn btn-primary" onClick={connectStripe} disabled={!locationId || loading}>
                    Connect with Stripe (OAuth)
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => { setShowDirect(v => !v); setError(''); }}
                    disabled={loading}
                  >
                    {showDirect ? 'Cancel' : 'Connect Existing Account'}
                  </button>
                </div>

                {showDirect && (
                  <div style={{ background: '#f8fafc', border: '1.5px solid #e2e8f0', borderRadius: 10, padding: 20, marginTop: 8 }}>
                    <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
                      Enter the Stripe Account ID of an already-onboarded connected account.
                    </p>
                    <div className="input-group">
                      <input
                        type="text"
                        placeholder="acct_1ABC..."
                        value={directAccountId}
                        onChange={(e) => setDirectAccountId(e.target.value)}
                      />
                      <button
                        className="btn btn-primary"
                        onClick={connectDirect}
                        disabled={!directAccountId || loading}
                      >
                        {loading ? 'Connecting…' : 'Connect Account'}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {stripeStatus?.connected && (
              <>
                {/* Account info row */}
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '16px 20px', marginBottom: 20, display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 2 }}>Account Name</div>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{stripeStatus.displayName || '—'}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 2 }}>Email</div>
                    <div style={{ fontSize: 14 }}>{stripeStatus.email || '—'}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 2 }}>Account ID</div>
                    <div style={{ fontSize: 12, fontFamily: 'monospace', color: '#475569' }}>{stripeStatus.stripeAccountId}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 2 }}>Country</div>
                    <div style={{ fontSize: 14 }}>{stripeStatus.country?.toUpperCase() || '—'}</div>
                  </div>
                  <div style={{ marginLeft: 'auto' }}>
                    <span className={`badge ${stripeStatus.livemode ? 'green' : 'yellow'}`} style={{ fontSize: 13, padding: '4px 14px' }}>
                      {stripeStatus.livemode ? 'Live Mode' : 'Test Mode'}
                    </span>
                  </div>
                </div>

                {/* Stats row */}
                <div className="status-row" style={{ marginBottom: 20 }}>
                  <div className="stat-box">
                    <div className="stat-label">Available Balance</div>
                    <div className="stat-value">
                      {new Intl.NumberFormat('en-US', { style: 'currency', currency: stripeStatus.balanceCurrency ?? 'usd' }).format((stripeStatus.availableBalance ?? 0) / 100)}
                    </div>
                  </div>
                  <div className="stat-box">
                    <div className="stat-label">Pending Balance</div>
                    <div className="stat-value">
                      {new Intl.NumberFormat('en-US', { style: 'currency', currency: stripeStatus.balanceCurrency ?? 'usd' }).format((stripeStatus.pendingBalance ?? 0) / 100)}
                    </div>
                  </div>
                  <div className="stat-box">
                    <div className="stat-label">Recent Transactions</div>
                    <div className="stat-value">
                      {stripeStatus.succeededTxCount ?? 0} succeeded
                      {stripeStatus.hasMore && <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 400 }}> (100+ total)</span>}
                    </div>
                  </div>
                  <div className="stat-box">
                    <div className="stat-label">Charges / Payouts</div>
                    <div className="stat-value" style={{ fontSize: 14, display: 'flex', gap: 8 }}>
                      <span className={`badge ${stripeStatus.chargesEnabled ? 'green' : 'red'}`}>{stripeStatus.chargesEnabled ? 'Charges ✓' : 'Charges ✗'}</span>
                      <span className={`badge ${stripeStatus.payoutsEnabled ? 'green' : 'red'}`}>{stripeStatus.payoutsEnabled ? 'Payouts ✓' : 'Payouts ✗'}</span>
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

          </> /* end dashboard tab */}

          {/* ── Transactions Tab ──────────────────────────────────────────── */}
          {tab === 'transactions' && <>
            <h1 className="page-title">Transactions</h1>
            <p className="page-sub">Recent payment events for this location.</p>

            {!locationId && <div className="alert alert-error">Enter a Location ID on the Dashboard tab first.</div>}

            {locationId && (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px 16px' }}>
                  <span style={{ fontWeight: 600, fontSize: 15 }}>Payment History (live from Stripe)</span>
                  <button className="btn btn-secondary" onClick={() => { setTxCursor(null); fetchTransactions(locationId, null); }} disabled={txLoading} style={{ padding: '6px 14px', fontSize: 13 }}>
                    {txLoading ? 'Loading…' : 'Refresh'}
                  </button>
                </div>
                {txLoading && transactions.length === 0 && <p style={{ padding: '0 24px 20px', color: '#6b7280', fontSize: 14 }}>Loading transactions…</p>}
                {!txLoading && transactions.length === 0 && (
                  <p style={{ padding: '0 24px 24px', color: '#6b7280', fontSize: 14 }}>No transactions found.</p>
                )}
                {transactions.length > 0 && (
                  <>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                        <th style={{ padding: '10px 24px', textAlign: 'left', color: '#6b7280', fontWeight: 600 }}>Date</th>
                        <th style={{ padding: '10px 16px', textAlign: 'left', color: '#6b7280', fontWeight: 600 }}>Payment Intent</th>
                        <th style={{ padding: '10px 16px', textAlign: 'left', color: '#6b7280', fontWeight: 600 }}>Description</th>
                        <th style={{ padding: '10px 16px', textAlign: 'right', color: '#6b7280', fontWeight: 600 }}>Amount</th>
                        <th style={{ padding: '10px 24px', textAlign: 'left', color: '#6b7280', fontWeight: 600 }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.map((tx) => {
                        const stripeStatusColor = {
                          succeeded:               'green',
                          requires_payment_method: 'red',
                          canceled:                'red',
                          processing:              'yellow',
                        }[tx.status] ?? 'gray';
                        return (
                          <tr key={tx.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '12px 24px', color: '#475569' }}>{new Date(tx.created * 1000).toLocaleDateString()}</td>
                            <td style={{ padding: '12px 16px', fontFamily: 'monospace', color: '#475569', fontSize: 12 }}>{tx.id}</td>
                            <td style={{ padding: '12px 16px', color: '#475569' }}>{tx.description ?? tx.entityType ?? '—'}</td>
                            <td style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600 }}>
                              {new Intl.NumberFormat('en-US', { style: 'currency', currency: tx.currency ?? 'usd' }).format(tx.amount / 100)}
                            </td>
                            <td style={{ padding: '12px 24px' }}>
                              <span className={`badge ${stripeStatusColor}`}>{tx.status}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {txHasMore && (
                    <div style={{ padding: '16px 24px', borderTop: '1px solid #f1f5f9', textAlign: 'center' }}>
                      <button className="btn btn-secondary" onClick={() => fetchTransactions(locationId, txCursor)} disabled={txLoading}>
                        {txLoading ? 'Loading…' : 'Load More'}
                      </button>
                    </div>
                  )}
                  </>
                )}
              </div>
            )}
          </>}

          {/* ── Settings Tab ─────────────────────────────────────────────── */}
          {tab === 'settings' && <>
            <h1 className="page-title">Settings</h1>
            <p className="page-sub">Integration endpoints and configuration reference.</p>

            <div className="card">
              <div className="card-title">Integration Endpoints</div>
              <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>Register these URLs in your GHL Marketplace app and Stripe Dashboard.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13 }}>
                {[
                  { label: 'GHL Webhook URL',            url: `${origin}/api/webhooks/ghl` },
                  { label: 'Stripe Webhook URL',         url: `${origin}/api/webhooks/stripe` },
                  { label: 'GHL OAuth Redirect URI',     url: `${origin}/api/auth/ghl/callback` },
                  { label: 'Stripe Connect Redirect URI',url: `${origin}/api/auth/stripe/callback` },
                  { label: 'Checkout URL (template)',    url: `${origin}/checkout?locationId=${locationId || 'LOCATION_ID'}&entityId=ORDER_ID&entityType=invoice&amount=9900&currency=usd` },
                  { label: 'Payment Status Query URL',   url: `${origin}/api/payments/status` },
                ].map(({ label, url }) => (
                  <div key={label}>
                    <strong>{label}</strong>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                      <div className="copy-url" style={{ flex: 1, margin: 0 }}>{url}</div>
                      <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: 12, flexShrink: 0 }}
                        onClick={() => { navigator.clipboard.writeText(url); }}>
                        Copy
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="card-title">Connection Status</div>
              <div className="status-row">
                <div className="stat-box">
                  <div className="stat-label">GHL Location</div>
                  <div className="stat-value" style={{ fontSize: 14 }}>{locationId || '—'}</div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">Stripe Account</div>
                  <div className="stat-value" style={{ fontSize: 14 }}>{stripeStatus?.stripeAccountId || '—'}</div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">Mode</div>
                  <div className="stat-value">
                    {stripeStatus ? <span className={`badge ${stripeStatus.livemode ? 'green' : 'yellow'}`}>{stripeStatus.livemode ? 'Live' : 'Test'}</span> : '—'}
                  </div>
                </div>
              </div>
            </div>
          </>}

        </div>
      </div>
    </>
  );
}
