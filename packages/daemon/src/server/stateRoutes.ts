// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Read models: the full projected state for a fresh client, and the onboarding report.
import type { FastifyInstance } from 'fastify';
import type { Daemon } from '../daemon.ts';
import { onboardingReport } from '../onboarding.ts';

export function registerStateRoutes(app: FastifyInstance, d: Daemon): void {
  app.get('/api/state', async () => ({ seq: d.state.seq, state: d.state, demo: d.baseEnv().ACC_DEMO_FIXTURES === '1', tracker: { type: d.tracker.type, target: d.tracker.target, live: d.tracker.live }, outbox: d.store.outboxStats() }));
  app.get('/api/onboarding', async () => onboardingReport(d));
}
