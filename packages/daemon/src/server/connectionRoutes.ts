// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Connections (API keys in the Keychain) and egress transparency: which hosts the daemon may
// reach and the most recent outbound requests.
import type { FastifyInstance } from 'fastify';
import { CommandError } from '../errors.ts';
import type { Daemon } from '../daemon.ts';
import { deleteSecret, hasSecret, providerSecretFor, SECRET_NAMES, setSecret, type SecretName } from '../secrets.ts';
import type { Req } from './route.ts';

const secretName = (id: string): SecretName => {
  if (!(SECRET_NAMES as readonly string[]).includes(id)) throw new CommandError('unknown connection', 404);
  return id as SecretName;
};

export function registerConnectionRoutes(app: FastifyInstance, d: Daemon): void {
  app.get('/api/connections', async () => {
    const out: Record<string, { stored: boolean; usedBy: string[]; storedAt: string | null; ageDays: number | null; rotationDue: boolean }> = {};
    for (const name of SECRET_NAMES) {
      out[name] = { stored: await hasSecret(name, d.baseEnv()), ...d.accounts.keyAge(name), usedBy: d.config.agents.filter((a) => providerSecretFor(a)?.secret === name || (name === 'linear' && d.config.tracker.type === 'linear')).map((a) => a.id) };
    }
    return { connections: out, egress: { allowed: d.egress.allowed, recent: d.egress.log.slice(-50) } };
  });
  app.post('/api/connections/:id', async (req: Req<{ key?: string }>) => {
    const name = secretName(req.params.id);
    const key = String(req.body?.key ?? '').trim();
    if (!key) throw new CommandError('key is required');
    await setSecret(name, key);
    d.addSecret(key);
    d.accounts.keyStored(name);
    for (const a of d.config.agents) if (providerSecretFor(a)?.secret === name && a.enabled !== false) void d.probe(a.id).catch(() => undefined);
    return { stored: true };
  });
  app.delete('/api/connections/:id', async (req: Req) => {
    const name = secretName(req.params.id);
    await deleteSecret(name);
    d.accounts.keyRemoved(name);
    return { stored: false };
  });
}
