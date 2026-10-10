// SPDX-License-Identifier: Apache-2.0
// Webhook authentication and replay bounds. This module never opens a socket and never
// registers a hook with GitHub or GitLab. Polling is the fallback when no delivery arrives.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function clampPollSeconds(value: number | undefined): number {
  const n = value ?? 60;
  if (!Number.isFinite(n)) return 60;
  return Math.min(300, Math.max(15, Math.trunc(n)));
}

export interface WebhookLimits {
  maxSkewSeconds: number;
  replayWindowSeconds: number;
}

export type WebhookVerdict = { ok: true; id: string; event: string } | { ok: false; reason: string };

function header(headers: Record<string, string>, name: string): string {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want) return value;
  }
  return '';
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

function timestampMs(headers: Record<string, string>, body: string): number | null {
  const raw = header(headers, 'x-github-timestamp') || header(headers, 'x-gitlab-timestamp');
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  }
  try {
    const parsed = JSON.parse(body) as { timestamp?: unknown };
    if (typeof parsed.timestamp === 'number' && Number.isFinite(parsed.timestamp)) {
      return parsed.timestamp > 1e12 ? parsed.timestamp : parsed.timestamp * 1000;
    }
  } catch {
    /* body is not JSON; delivery id still bounds replay */
  }
  return null;
}

/** Verify one delivery. `seen` returns the expiry (ms) of a delivery id already accepted, or null. */
export function verifyWebhookDelivery(input: {
  provider: 'github' | 'gitlab';
  secret: string;
  body: string;
  headers: Record<string, string>;
  nowMs: number;
  limits: WebhookLimits;
  seen: (id: string) => number | null;
}): WebhookVerdict {
  if (!input.secret) return { ok: false, reason: 'Webhook secret is not in the Keychain. The delivery was not accepted.' };
  const id = input.provider === 'github' ? header(input.headers, 'x-github-delivery') : header(input.headers, 'x-gitlab-event-uuid');
  const event = input.provider === 'github' ? header(input.headers, 'x-github-event') : header(input.headers, 'x-gitlab-event');
  if (!id || !event) return { ok: false, reason: 'Delivery id or event name is missing.' };
  if (input.provider === 'github') {
    const expected = `sha256=${createHmac('sha256', input.secret).update(input.body).digest('hex')}`;
    if (!same(expected, header(input.headers, 'x-hub-signature-256'))) return { ok: false, reason: 'Webhook signature does not match.' };
  } else if (!same(input.secret, header(input.headers, 'x-gitlab-token'))) {
    return { ok: false, reason: 'Webhook token does not match.' };
  }
  const stamped = timestampMs(input.headers, input.body);
  if (stamped !== null && Math.abs(input.nowMs - stamped) > input.limits.maxSkewSeconds * 1000) {
    return { ok: false, reason: 'Delivery is outside the configured replay window.' };
  }
  const expiry = input.seen(id);
  if (expiry !== null && expiry > input.nowMs) return { ok: false, reason: 'This delivery id was already accepted.' };
  return { ok: true, id, event };
}
