// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Redeems a single-use pairing token. The token travels in the URL fragment, so it is never sent to
// a server, written to an access log or leaked through a Referer header. It is read once and removed
// from the address bar and history before anything else happens, and it is never rendered.
import { useEffect, useState } from 'react';

interface Outcome { ok: boolean; message: string }
let attempt: Promise<Outcome> | null = null;

/** Runs at most once per page load, even under React StrictMode's double effects. */
export function redeemFromLocation(): Promise<Outcome> {
  if (attempt) return attempt;
  const match = /(?:^#|&)t=([^&]+)/.exec(window.location.hash);
  const token = match ? decodeURIComponent(match[1]) : null;
  window.history.replaceState(null, '', window.location.pathname);
  attempt = !token
    ? Promise.resolve({ ok: false, message: 'This page needs a pairing link. Create one on the Mac under Phone & alerts.' })
    : fetch('/api/remote/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), credentials: 'same-origin', referrerPolicy: 'no-referrer' })
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          return res.ok ? { ok: true, message: 'Paired.' } : { ok: false, message: body.error ?? `Pairing failed (${res.status}).` };
        })
        .catch(() => ({ ok: false, message: 'Could not reach One Connect. Check that the tunnel is running on the Mac.' }));
  return attempt;
}

export function PairPage() {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  useEffect(() => {
    void redeemFromLocation().then((o) => {
      setOutcome(o);
      if (o.ok) window.location.replace('/phone');
    });
  }, []);
  return (
    <main className="splash card card-b col" aria-live="polite">
      <h1 style={{ fontSize: 20 }}>{outcome ? (outcome.ok ? 'Paired' : 'Not paired') : 'Pairing this phone…'}</h1>
      <p className="muted">{outcome ? outcome.message : 'Checking your single-use link.'}</p>
      {outcome && !outcome.ok && <p className="faint small">Links work once and expire within minutes. Nothing was stored on this device.</p>}
    </main>
  );
}
