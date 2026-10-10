// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Account payment settings remain vendor-owned. A human's time-bounded attestation is distinct
// from detected billing; it never changes an unknown vendor setting into "off".
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { HUMAN, type Actor, type AgentState } from '@acc/core';
import { CommandError, type Daemon } from './daemon.ts';
import { sha256 } from './util/hash.ts';

interface Confirmation { binding: string; session: string; at: string; expiresAt: string }
const TTL_MS = 12 * 60 * 60_000;
export class SubscriptionSafety {
  private readonly session = randomBytes(24).toString('hex');
  private readonly d: Daemon;
  constructor(d: Daemon) { this.d = d; }

  private binding(a: AgentState): string {
    let binary: unknown = null;
    if (a.binary) {
      try { const s = fs.statSync(a.binary.path); binary = [fs.realpathSync(a.binary.path), a.binary.version, s.dev, s.ino, s.size, s.mtimeMs]; }
      catch { binary = 'missing'; }
    }
    return sha256(JSON.stringify({ id: a.id, adapter: a.config.adapter, provider: a.config.provider, binary, configuredBinary: a.config.binary, subscription: a.config.subscription, billing: a.config.billing, meteredOptIn: a.config.metered_opt_in, auth: a.auth, detectedBilling: a.billing, probedAt: a.probedAt }));
  }

  status(agentId: string) {
    const a = this.d.state.agents[agentId];
    if (!a) throw new CommandError('Unknown agent', 404);
    const required = a.config.adapter !== 'relay' && !a.config.metered_opt_in && a.billing.mode === 'subscription' && a.billing.overage === 'unknown';
    const raw = this.d.store.kvGet(`subscription-confirm:${agentId}`);
    const confirmation = raw ? JSON.parse(raw) as Confirmation : null;
    const valid = Boolean(required && a.auth.state === 'logged_in' && a.binary && confirmation?.session === this.session && confirmation.binding === this.binding(a) && Date.parse(confirmation.expiresAt) > this.d.now().getTime());
    const message = valid ? 'Owner confirmed paid overage, purchased credits and auto-recharge off for this login and daemon session; vendor setting remains unknown.' : 'Confirm paid overage, purchased credits and auto-recharge are off for this login in Agents & subscriptions.';
    return { required, valid, confirmedAt: valid ? confirmation!.at : null, expiresAt: valid ? confirmation!.expiresAt : null, message };
  }

  confirm(agentId: string, off: boolean, actor: Actor = HUMAN) {
    if (actor.type !== 'human' || actor.id === 'jev') throw new CommandError('Only the owner can confirm subscription payment settings', 403);
    const a = this.d.state.agents[agentId];
    if (!a || !this.status(agentId).required || a.auth.state !== 'logged_in' || !a.binary) throw new CommandError('Re-check the signed-in subscription runtime before confirming its settings', 409);
    if (off !== true) throw new CommandError('Confirm that all paid fallbacks are off before using included usage', 428);
    const at = this.d.nowIso();
    const expiresAt = new Date(this.d.now().getTime() + TTL_MS).toISOString();
    const binding = this.binding(a);
    this.d.commit([{ type: 'agent.subscription_confirmed', actor, agentId, data: { binding, expiresAt, scope: 'daemon-session', note: 'Owner attests paid overage, purchased credits and auto-recharge are off; vendor cannot verify them. Reconfirm after account changes, restart or expiry.' } }], [], () => this.d.store.kvSet(`subscription-confirm:${agentId}`, JSON.stringify({ binding, session: this.session, at, expiresAt })));
    return this.status(agentId);
  }
}
