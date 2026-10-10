// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Read-only code host. Live GitHub and GitLab are contacted only when the owner
// approved the current project, host, scopes and capabilities in Connectors. The token comes
// from the Keychain. Webhooks are verified locally and are never registered.
import { productionBranchOf, SYSTEM, type CodeHostSnapshot } from '@acc/core';
import { getSecret, type SecretName } from '../../secrets.ts';
import { ProviderRefused } from './http.ts';
import { readGitHub } from './github.ts';
import { readGitLab } from './gitlab.ts';
import { clampPollSeconds, verifyWebhookDelivery } from './webhook.ts';
import type { Daemon } from '../../daemon.ts';

export function liveOrigin(provider: 'github' | 'gitlab' | 'vercel' | 'supabase', host: string): string {
  if (provider === 'github') return host === 'api.github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
  if (provider === 'gitlab') return `https://${host}`;
  if (provider === 'vercel') return host === 'api.vercel.com' ? 'https://api.vercel.com' : `https://${host}`;
  return host === 'api.supabase.com' ? 'https://api.supabase.com' : `https://${host}`;
}

export function activationOf(cfg: { activated?: boolean; host?: string; scopes?: string[] } | null | undefined): { host: string; scopes: string[] } | null {
  if (!cfg?.activated || !cfg.host || !cfg.scopes?.length) return null;
  return { host: cfg.host, scopes: cfg.scopes };
}

export class CodeHosts {
  readonly d: Daemon;

  constructor(d: Daemon) {
    this.d = d;
  }

  private delivery(): CodeHostSnapshot['delivery'] {
    const cfg = this.d.config.code_host;
    let lastDeliveryAt: string | null = null;
    const raw = this.d.store.kvGet('webhook:last');
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { at?: string };
        lastDeliveryAt = typeof parsed.at === 'string' ? parsed.at : null;
      } catch {
        lastDeliveryAt = null;
      }
    }
    return {
      registered: false,
      pollSeconds: clampPollSeconds(cfg?.poll_seconds),
      webhook: cfg?.webhook ? 'configured' : 'off',
      lastDeliveryAt,
    };
  }

  private empty(source: CodeHostSnapshot['source'], error: string | null, detail: string): CodeHostSnapshot {
    return {
      provider: this.d.config.code_host?.provider ?? 'unconfigured',
      checkedAt: this.d.nowIso(),
      source,
      productionBranch: productionBranchOf(this.d.config.project),
      protected: null,
      protectionDetail: detail,
      pulls: [],
      checks: [],
      error,
      delivery: this.delivery(),
    };
  }

  async refresh(opt: { live?: boolean; connectorId?: string } = {}): Promise<CodeHostSnapshot> {
    const cfg = this.d.config.code_host;
    const branch = productionBranchOf(this.d.config.project);
    let snapshot: CodeHostSnapshot;
    const choices = (cfg ? [cfg.provider] : ['github', 'gitlab'] as const).flatMap(provider => {
      const access = this.d.connectors.releaseAccess(provider, opt.connectorId);
      return access ? [access] : [];
    });
    if (opt.live && choices.length === 1) snapshot = await this.readLive(choices[0], branch);
    else if (!cfg?.fixture_base) snapshot = this.empty('unconfigured', null, choices.length > 1 ? 'Multiple active code hosts match. Choose one connection and Read now. No request was sent.' : choices.length === 1 ? 'Read is approved. Provider reachability remains unknown until you choose Read now. No request was sent.' : 'No active human Decision matches the current code host and project. Configure a connector and approve read in Decisions. No request was sent.');
    else {
      try {
        const read = cfg.provider === 'github'
          ? await readGitHub(this.d.egress.fetch, cfg.fixture_base, cfg.repo, branch)
          : await readGitLab(this.d.egress.fetch, cfg.fixture_base, cfg.project, branch);
        snapshot = { provider: cfg.provider, checkedAt: this.d.nowIso(), source: 'fixture', productionBranch: branch, ...read, delivery: this.delivery() };
      } catch (e) {
        const refused = e instanceof ProviderRefused;
        snapshot = this.empty(refused ? 'refused' : 'fixture', (e as Error).message, (e as Error).message);
      }
    }
    this.d.commit([{ type: 'code_host.checked', actor: SYSTEM, data: { snapshot } }]);
    this.warn(snapshot);
    return snapshot;
  }

  /**
   * Verify a delivery the owner forwarded to this local daemon.
   * Does not register a webhook and does not call the code host.
   */
  async acceptDelivery(input: { headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; reason: string; registered: false }> {
    const cfg = this.d.config.code_host;
    if (!cfg?.webhook) return { ok: false, reason: 'Webhook authentication is not configured.', registered: false };
    const secret = await getSecret(cfg.webhook.secret_account, this.d.baseEnv());
    if (!secret) return { ok: false, reason: 'Webhook secret is not in the Keychain. The delivery was not accepted.', registered: false };
    this.d.addSecret(secret);
    const headers = input.headers ?? {};
    const body = input.body ?? '';
    const seen = this.seenMap();
    const verdict = verifyWebhookDelivery({
      provider: cfg.provider,
      secret,
      body,
      headers,
      nowMs: this.d.now().getTime(),
      limits: { maxSkewSeconds: cfg.webhook.max_skew_seconds, replayWindowSeconds: cfg.webhook.replay_window_seconds },
      seen: (id) => seen[id] ?? null,
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason, registered: false };
    seen[verdict.id] = this.d.now().getTime() + cfg.webhook.replay_window_seconds * 1000;
    const now = this.d.now().getTime();
    for (const [id, exp] of Object.entries(seen)) if (exp <= now) delete seen[id];
    this.d.store.kvSet('webhook:seen', JSON.stringify(seen));
    this.d.store.kvSet('webhook:last', JSON.stringify({ at: this.d.nowIso(), event: verdict.event, id: verdict.id }));
    return { ok: true, reason: `Accepted ${verdict.event}. The hook is not registered with the host. Polling remains the fallback.`, registered: false };
  }

  private seenMap(): Record<string, number> {
    const raw = this.d.store.kvGet('webhook:seen');
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, number>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private async readLive(access: NonNullable<ReturnType<Daemon['connectors']['releaseAccess']>>, branch: string): Promise<CodeHostSnapshot> {
    const cfg = access.config;
    if (cfg.kind !== 'github' && cfg.kind !== 'gitlab') return this.empty('refused', 'Not a code host.', 'Not a code host.');
    if (!this.d.egress.allowed.includes(cfg.host)) {
      return this.empty('refused', `${cfg.host} is not on the egress allowlist. No request was sent.`, `${cfg.host} is not on the egress allowlist. No request was sent.`);
    }
    access.authorize(cfg.capabilities[0]);
    const secretName: SecretName = cfg.kind;
    const token = await getSecret(secretName, this.d.baseEnv());
    if (!token) return this.empty('refused', 'No token is in the Keychain. No request was sent.', 'No token is in the Keychain. No request was sent.');
    this.d.addSecret(token);
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (cfg.kind === 'github') {
      headers.accept = 'application/vnd.github+json';
      headers['x-github-api-version'] = '2022-11-28';
    }
    try {
      const base = liveOrigin(cfg.kind, cfg.host);
      const opt = { headers, live: true, scopes: cfg.scopes, capabilities: cfg.capabilities, authorize: access.authorize };
      const read = cfg.kind === 'github'
        ? await readGitHub(this.d.egress.fetch, base, cfg.repo, branch, opt)
        : await readGitLab(this.d.egress.fetch, base, cfg.project, branch, opt);
      access.authorize(cfg.capabilities[0]);
      return { provider: cfg.kind, checkedAt: this.d.nowIso(), source: 'live', productionBranch: branch, ...read, delivery: this.delivery() };
    } catch (e) {
      const message = this.d.redactText((e as Error).message);
      return this.empty(e instanceof ProviderRefused ? 'refused' : 'live', message, message);
    }
  }

  private warn(snapshot: CodeHostSnapshot): void {
    const d = this.d;
    if (snapshot.protected === false) {
      d.alert({
        kind: 'branch_protection',
        severity: 'critical',
        message: `Production branch ${snapshot.productionBranch} is not protected. One Connect will not treat a release as safe until the code host reports protection.`,
        suggestion: { kind: 'text', text: 'Turn on branch protection in GitHub or GitLab before pushing or deploying.' },
        dedupeKey: `branch-protection:${snapshot.productionBranch}`,
      });
    } else if (snapshot.protected === true) d.resolveAlerts((a) => a.dedupeKey === `branch-protection:${snapshot.productionBranch}`, 'branch is protected');
    const failed = snapshot.checks.filter((c) => c.status === 'failed');
    if (failed.length) {
      d.alert({
        kind: 'infra',
        severity: 'critical',
        message: `CI on ${snapshot.productionBranch} is failing: ${failed.map((c) => c.name).join(', ')}.`,
        dedupeKey: `ci-failing:${snapshot.productionBranch}`,
      });
    } else if (snapshot.checks.length > 0 && snapshot.checks.every((c) => c.status === 'passed')) d.resolveAlerts((a) => a.dedupeKey === `ci-failing:${snapshot.productionBranch}`, 'checks passed');
  }
}
