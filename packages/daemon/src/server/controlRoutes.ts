// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Owner controls: approvals, alerts, rules, the kill switch, the tracker poll, settings, team
// messages and project Docker.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HUMAN, RULE_NAMES, type RuleName } from '@acc/core';
import { CommandError, type Daemon } from '../daemon.ts';
import type { SettingsDraft } from '../settings.ts';
import type { SendTeamMessage } from '../team.ts';
import { parseBody, type Req } from './route.ts';

export function registerControlRoutes(app: FastifyInstance, d: Daemon): void {
  app.post('/api/approvals/:id/resolve', async (req: Req<{ decision: string; channel?: string }>) => {
    d.resolveApproval(req.params.id, String(req.body?.decision ?? ''), req.body?.channel ?? 'web');
    return { ok: true };
  });
  app.post('/api/alerts/:id/resolve', async (req: Req<{ resolution?: string }>) => {
    d.resolveAlert(req.params.id, req.body?.resolution ?? 'dismissed');
    return { ok: true };
  });
  app.post('/api/rules/:id', async (req: Req<{ enabled: boolean }>) => {
    if (!(RULE_NAMES as readonly string[]).includes(req.params.id)) throw new CommandError('unknown rule', 404);
    d.setRule(req.params.id as RuleName, Boolean(req.body?.enabled));
    return { ok: true };
  });
  app.post('/api/kill-switch', async (req: Req<{ engaged: boolean }>) => ({ stopped: await d.setKillSwitch(Boolean(req.body?.engaged)) }));
  app.post('/api/tracker/poll', async () => ({ changed: await d.poller.poll() }));

  app.get('/api/settings', async () => d.settings.read());
  app.post('/api/settings/request', async (req: Req<{ settings: SettingsDraft; expected: string }>) => ({ decision: d.settings.request(req.body?.settings, req.body?.expected) }));

  app.get('/api/team', async () => d.team.snapshot());
  app.get('/api/team/messages', async (req: Req<unknown, { id: string }, { agentId?: string; after?: string; limit?: string }>) => d.team.list(req.query.agentId ?? null, { after: Number(req.query.after ?? 0), limit: Number(req.query.limit ?? 20) }));
  app.post('/api/team/messages', async (req: Req<SendTeamMessage>) => ({ message: d.team.send(req.body, HUMAN) }));

  app.get('/api/docker', async () => d.docker.list());
  app.get('/api/docker/:id/logs', async (req: Req) => d.docker.logs(req.params.id));
  app.post('/api/docker/:id/request', async (req: Req) => d.docker.request(req.params.id, parseBody(z.object({ action: z.string() }), req.body).action));
  app.post('/api/docker/decisions/:id/resolve', async (req: Req) => {
    const b = parseBody(z.object({ answer: z.string(), nonce: z.string().optional() }), req.body);
    return d.docker.resolve(req.params.id, b.answer, { nonce: b.nonce });
  });
}
