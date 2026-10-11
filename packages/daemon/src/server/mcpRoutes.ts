// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The per-run MCP bridge. Authenticated by the run token header in http.ts, never by a session.
import type { FastifyInstance } from 'fastify';
import type { Daemon } from '../daemon.ts';
import type { Req } from './route.ts';

export const RUN_TOKEN_HEADER = 'x-acc-run-token';

export function registerMcpRoutes(app: FastifyInstance, d: Daemon): void {
  app.post('/api/mcp/:id', async (req: Req<Record<string, unknown>>) => d.mcp.call(String(req.headers[RUN_TOKEN_HEADER]), req.params.id, req.body ?? {}));
}
